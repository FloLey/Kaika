# Step 17 — The fluid emitter hot loop

**Status: RESOLVED, but not as proposed.** The windowing this step is built around was
measured and **rejected**; a different, exact change took ~40% of the emitter cost instead.
Landed 2026-07-20.

---

## What the sweep decided

Step 16 §2 required the truncation tolerance to be measured *before* this step was written.
It was, and the answer was no. The prototype computed the full grid and zeroed outside the
k·rc box (measuring truncation only, not slice arithmetic), swept k ∈ {2.5, 3, 4} plus a
mass-renormalised variant, over every fluid-bearing demo plus hand-built radial, heat,
wrap-edge and small-radius cases.

Max per-channel delta, worst case over all workloads:

| | k=2.5 | k=3 | k=4 | k=3 renormalised |
|---|---|---|---|---|
| worst over all cases | **198** | **200** | **200** | **202** |
| (typical 1 s demo) | 20–180 | 3–49 | 1–8 | 3–49 |

**k does not help.** The reason is in the per-frame breakdown of the 5-second case at k=3:

```
f0:1  f13:7  f26:5  f39:48  f52:123  f66:197  f79:178  f92:164  f105:186  f119:191
```

The error **compounds monotonically with frame index** and saturates near 200 levels. The
sim is recursive — `step()` advects the previous field — so it is a chaotic system, and a
perturbation of ~1e-4 relative amplifies through advection and the pressure solve until the
two runs are different plausible flows rather than the same flow to within a tolerance. A
1-second clip hides this (k=4 looks like ≤8 levels); anything longer does not.

Mass renormalisation (`1/erf(k/√2)²`, to preserve `add_radial`'s divergence source through
`_project`) does **not** rescue it — 202 at k=3. It corrects the systematic mass loss, not
the chaotic amplification, and those are different problems.

**This is exactly why step 16 required the sweep first.** Written the other way round, the
windowing would have shipped on the strength of a 1-second parity test and quietly changed
every long render.

## What landed instead

The profile that motivated this step was right that the emitters cost ~6× the solver
(measured 8.1 ms/frame against `step()`'s 1.4 on the 180×96 export grid — the audit's "~3×"
was an understatement). It was wrong about *which part*:

| per call, 180×96 grid | ms |
|---|---|
| `_gauss` — the `exp()` everyone blames | 0.028 |
| `add_dye`'s `(amount*g)[...,None] * color[None,None,:]` temporary | **0.069** |

The full-frame `(H,W,3)` temporary cost **two and a half times the exponential**. At
`_POINT_CAP = 64` emitters that is ~4.4 ms/frame of pure allocation, against ~1.4 ms for all
four FFTs in `step()`.

Accumulating one channel at a time removes it and is **bit-identical** — same operands, same
order, one fewer intermediate array:

```python
a = amount * self._gauss(px, py, radius)
dye = self.dye[layer]
for c in range(dye.shape[-1]):
    dye[..., c] += a * color[c]
```

| | before | after | |
|---|---|---|---|
| `add_dye` (excl. `_gauss`) | 0.069 ms | 0.019 ms | 3.6× |
| points fluid, 64 emitters, r=0.08, 2 s | 0.52 s | **0.36 s** | **1.44×** |
| points fluid, 64 emitters, r=0.02, 2 s | 0.50 s | **0.34 s** | 1.47× |

Verified bit-identical across **every** fluid-bearing Playground demo over 2-second clips,
and pinned by `test_add_dye_matches_the_broadcast_it_replaced_exactly`
(`tests/test_fluid_perf.py`) so the claim cannot rot. **No `RENDER_VERSION` bump** — and
unlike the windowing, that is asserted rather than hoped.

## What is still on the table

`add_force` (`:186`), `add_heat` (`:191`) and `add_radial` (`:199`) still compute a full-grid
`_gauss` each. Windowing them has the same chaotic-amplification problem, so it is not a free
win — but note `_gauss` itself is only 0.028 ms, so the ceiling for windowing all four is
~1.8 ms/frame at 64 emitters. **That is now smaller than what the `add_dye` fix already
took**, and it costs a version bump plus visibly different long renders. Not obviously worth
it; do not start without re-reading the sweep above.

---

> Everything below is the ORIGINAL step as written before the measurement. Kept because the
> reasoning is instructive and the profile numbers in it are still broadly right — it is the
> *conclusion* that the sweep overturned.

---

## The hole

`backend/fluid.py:172`:

```python
def _gauss(self, px: float, py: float, radius: float) -> np.ndarray:
    rc = max(1.0, radius * self.short)
    cx, cy = px * self.w, py * self.h
    d2 = (self.X - cx) ** 2 + (self.Y - cy) ** 2
    return np.exp(-d2 / (2 * rc * rc)).astype(np.float32)
```

Four full-grid temporaries (two squarings, the sum, the `exp`), for a function whose result
is **numerically zero across almost the entire grid**. A typical `radius=0.08` on a 216-cell
grid puts σ at ~17 cells; past ~4σ the value is below 1e-7, and `add_dye` multiplies it by an
amount that is already ≤1.

Four callers, all on the per-frame path:

| Caller | Line | Extra cost |
|---|---|---|
| `add_dye` | `:178` | also builds `(amount * g)[..., None] * color[None, None, :]` — a full `(h,w,3)` float32 temp |
| `add_force` | `:186` | two full-grid multiply-adds |
| `add_heat` | `:191` | `np.maximum(self.T, amount * g, out=self.T)` — MAX-blend, note this when windowing |
| `add_radial` | `:199` | accumulates into `self._src` |

## The multiplier

`_emitter.inject` (`fluid.py:437`) calls **two** of these per emitter per frame — `add_heat`
or `add_dye`, then `add_force`. `LayerInjector.apply` loops every emitter each frame. And
`_POINT_CAP = 64` (`graph_common.py:27`) bounds a points pipeline at 64 emitters.

So a points-driven fluid does up to **128 full-grid exponentials per frame**.

At the `gridCells: 216` export grid a frame is ~40–50k cells, so that is ~6.4M transcendentals
per frame — against the four FFTs in `step()` (the two `_project` calls, `:212`, `:279`,
`:283`) at roughly 2M ops. **The emitters cost more than the Navier–Stokes solver they feed.**
That inversion is the finding.

## The fix, and the precedent

Compute the Gaussian on a `[y0:y1, x0:x1]` window sized from `rc`, and add it in place.

**Do not invent the clipping arithmetic — this repo already has it.** `sources._stamp`
(`sources.py:784`) does exactly this for rain drops:

```python
r = ker.shape[0] // 2
iy, ix = int(round(y)), int(round(x))
y0, y1 = max(0, iy - r), min(u.shape[0], iy + r + 1)
x0, x1 = max(0, ix - r), min(u.shape[1], ix + r + 1)
if y1 <= y0 or x1 <= x0:
    return
u[y0:y1, x0:x1] += amp * ker[y0 - iy + r : y1 - iy + r, x0 - ix + r : x1 - ix + r]
```

Reuse that shape. The natural refactor is a private `_gauss_window(px, py, radius)` returning
`(slice_y, slice_x, g_window)`, with the four callers doing their own in-place blend against
the window — which also deletes `add_dye`'s full-frame RGB temporary, since the colour
multiply now happens on the window.

Expected: at `radius=0.08` on a 216-cell grid, a 4σ window is roughly 137×137 against
~216×216 — call it **2.5× less work per emitter**, and considerably better for the small
radii that dominate points pipelines. Measure it; do not quote this number.

### ⚠ Three things the window must not break

1. **`add_heat` is a MAX-blend, not additive** (`:191`, and its docstring explains why —
   overlapping emitters saturate at flame temperature instead of super-heating past white).
   `np.maximum(..., out=...)` on the window only is correct *because* the outside contribution
   is below the existing field, but state that reasoning in a comment.
2. **Wrap.** The dye layers have a `wrap` edge mode (`LayerInjector.apply` maps it to a
   layer). If the sim wraps, an emitter near an edge must wrap its window too — or emitters
   near the border silently lose their tail. Check `_project`'s `np.roll` usage to confirm
   the field really is periodic before deciding.
3. **`add_radial` feeds `_project` as a divergence source** (`:199`, docstring). Truncating a
   divergence source changes the *global* solve, not just the local pixels — the Poisson
   solve redistributes it. This is the caller most likely to need a wider window; verify it
   separately in the parity run.

## The version question

Step 16's k-sweep answers it:

- If the measured max per-channel delta is ≤ 1/255, the picture is identical at 8-bit output.
  **No `RENDER_VERSION` bump** — and say so explicitly in the commit, because a reviewer will
  reasonably assume otherwise.
- If it is above that, bump, and record in `docs/render-versions.md` that cached clips are
  invalidated because emitter falloff is now truncated.

Do not skip the bump to preserve cache hits. A stale clip that no longer matches a fresh
render is the "export doesn't match the preview" bug class, which is the worst one here.

---

## Verification

1. `assert_frames_close` (step 16) between a pre-change and post-change render of each fluid
   Playground demo, at the tolerance step 16 chose.
2. The step-16 benchmark's fluid case, before and after — **report both numbers in the commit
   message.**
3. `test_card_impact` stays green, including `test_whole_clip_matches_the_block_stream`.
4. A fire card (`add_heat`) and a radial emitter (`add_radial`) get their own parity checks —
   they are the two callers whose blend is not a plain add.

## Acceptance criteria

- No caller of `_gauss` allocates a full-grid array.
- Parity holds at the stated tolerance for every fluid demo, wrap mode on **and** off.
- The benchmark shows a real improvement, recorded as a number.
- `RENDER_VERSION` bumped, or a written justification for why not.

## Risks

- **Edge emitters under wrap** — the highest-probability breakage, and the easiest to miss
  because the Playground demos may not have one. Add a demo or a test that does.
- **A radius large enough that the window is the whole grid.** Fall back cleanly; the windowed
  path must never be *slower* than what it replaced.
- **`self.X` / `self.Y`** may be retained only for `_gauss`. If so they can go, but check for
  other users first.
