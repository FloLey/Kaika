# Step 17 — The fluid emitter hot loop

**Tier.** Core. The single biggest measurable win in the repo.

**Goal.** Stop computing a full-grid exponential per emitter per frame.

**Blocked by.** Step **16** (hard — the tolerance for this approximation is decided there,
and the parity helper is what proves the picture survived).

**⚠ May require a `RENDER_VERSION` bump** (`backend/graph_hash.py`) — see "The version
question" below. If bumped, `docs/render-versions.md` gets the entry.

**Size.** L — small diff, large blast radius. Every fluid render in the app goes through it.

> Line numbers are a snapshot — re-grep before relying on one.

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
