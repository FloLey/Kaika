# Step 18 — The other three hot loops

**Tier.** Core.

**Goal.** Three independent per-frame wastes, each with an obvious fix and no shared risk.

**Blocked by.** Step **16** (parity helper + baselines). Independent of 17 — they touch
different files and can land in either order.

**Size.** M overall; each of the three is a sitting on its own. **Land them as three
commits**, so a parity regression bisects to one.

> Line numbers are a snapshot — re-grep before relying on one.

---

## 1. ~~`_transform_frames` rebuilds the same warp every frame~~ — **DONE, and neither proposed fix was the reason**

> ✅ Landed in `8cefeb7`. **1345 ms → 163 ms (8.3×)** on a 12-frame 1080p RGBA block; the
> warp itself 98 ms → 0.4 ms per frame (234×). `RENDER_VERSION` → 15.
>
> **Both fixes proposed below are real and both are nearly worthless.** Profiled per frame at
> 1080p RGBA:
>
> | | ms | share |
> |---|---|---|
> | `map_coordinates` ×4 channels | 92.1 | **88%** |
> | build `coords` (fix a) | 3.8 | 3.6% |
> | `astype(float32)` ×4 (fix b) | 1.8 | 1.7% |
> | clip + `astype(uint8)` ×4 | 4.0 | 3.8% |
>
> The answer was to stop calling `map_coordinates` per channel: `cv2.remap` does all four in
> one vectorised call, and OpenCV is already a dependency. **This is the third of step 18's
> three findings to be misdiagnosed the same way** — the expensive thing was never the
> allocation, it was the library call next to it.
>
> ⚠ Two traps worth keeping, both of which look like rounding until plotted. scipy `mirror`
> is `BORDER_REFLECT_101` (abc|ba), **not** `BORDER_REFLECT` (abc|cb) — the wrong one costs
> ~5.6 levels of mean error. And scipy `constant` returns `cval` for **any** coordinate
> outside `[0, n-1]` (a hard cutoff) while cv2 blends against a virtual border pixel: half a
> pixel out reads 100 where scipy reads 0, a one-pixel band up to 200 levels wide that a mean
> hides completely. An explicit out-of-bounds mask restores it. With both handled, all 8
> combinations (3 edge modes × 3ch/4ch) agree to max delta 1.
>
> The residual ±1 is cv2's fixed-point interpolation weights vs scipy's float — invisible but
> not byte-identical, hence the version bump rather than an assumption of equivalence.

### The original finding, kept for the reasoning it got wrong

`graph_render.py:1280`. Per frame it builds `dx`, `dy`, `sx`, `sy` and `coords` — five full
`(h,w)` float32 arrays — then loops channels:

```python
for ch in range(c):
    warped = map_coordinates(frames[i, :, :, ch].astype(np.float32), coords, order=1, mode=edge, ...)
```

Two compounding costs:

**(a) The geometry is usually frame-invariant.** `zoom`, `rotate`, `pan_x`, `pan_y` are
`const` bindings on any unmodulated transform card — the common case by a wide margin. When
all four resolve to constants, `coords` is *identical for all N frames* and is being rebuilt
N times. A 150-frame block at 540×960 allocates on the order of hundreds of MB of coordinate
grids to recompute one mapping.

The check is cheap and local: the resolved per-frame arrays for those four params are already
in hand, so test whether each is constant (`np.ptp(arr) == 0`, or compare against `arr[0]`)
and hoist the whole `coords` construction above the frame loop when they all are. Keep the
per-frame path for the modulated case — do not try to be clever about partial constancy in
this step.

**(b) `astype(np.float32)` runs per channel, per frame.** That is a full-frame copy each
time; C=4 on an RGBA layer means 4 copies and 4 `map_coordinates` calls per frame — 600 per
block. `map_coordinates` accepts 3-D input, so either pass `(h, w, c)` with an integer third
coordinate axis and do one call, or at minimum hoist the `astype` to once per frame.

⚠ Confirm the `mode=edge` semantics survive the 3-D form — the boundary mode applies to every
axis, and the channel axis must not be interpolated or padded. If that turns out awkward,
take fix (b)'s cheap half (one `astype` per frame) and leave the per-channel calls.

## 2. ~~`procgen._value_noise_2d` rebuilds its RNG lattice on every call~~ — **DONE, but not this way**

> ✅ Landed in `372edb9`. **The finding as written was wrong**, and the way it was wrong is
> the most useful thing in this file.

The audit proposed `lru_cache` on the lattice draw, reasoning that `clouds` issues ~14
`fbm2d` octaves per frame and so rebuilds ~14 lattices per frame. That is all true. It is
also irrelevant — **measured, the lattice is 0.005–0.028 ms of a ~2.0 ms call, i.e. 0.2–0.8%
of it.** Caching it would have saved nothing, while adding a cache to invalidate, a
`maxsize` to tune, and the non-writeable-array trap the ⚠ above correctly anticipated.

The real cost was next door, in the interpolation. The old form took four
`lat[np.ix_(ym, xm)]` gathers, each materialising a full `(h, w)` frame by scattered 2-D
fancy indexing. Doing the bilinear lerp **separably** — along x on the small `(res_y, w)`
slab first, then gathering rows and lerping along y — replaces them with two slab gathers
plus two contiguous row gathers:

| | before | after | |
|---|---|---|---|
| `_value_noise_2d` 384², res=6 | 2.02 ms | 0.22 ms | 9.3× |
| `_value_noise_2d` 384², res=96 | 1.98 ms | 0.31 ms | 6.4× |
| **clouds card, 384², 2 s** | **47.1 ms** | **25.7 ms** | **1.83×** |
| waves card | 22.7 ms | 20.7 ms | 1.10× |
| rain card | 11.0 ms | 10.1 ms | 1.09× |

Bit-identical (a gather is exact; the per-pixel multiply/add order is unchanged), so no
`RENDER_VERSION` bump.

**The lesson, for the rest of this wave:** the audit read "allocates on every call" as "is
the hot loop" without profiling. Allocation size is not cost. A three-line microbenchmark
before the fix would have redirected the work in about two minutes — which is exactly what
step 16 exists to make routine.

## 2b. ~~`sources._noise_row`, same shape~~ — **NOT A FINDING**

Proposed on the same reasoning ("twice per band per frame in `aurora` while `cell` changes
~once a second"). Profiled: `_noise_row` **does not appear in aurora's top-14 cumulative
entries at all**, and aurora measured 10.4 ms both before and after the `_value_noise_2d`
change — so it is not a meaningful consumer of either. `_row_at` (the interpolation, again)
is the notable entry.

**Do not implement this.** Left in the file rather than deleted so the next reader does not
re-derive it from the same bad reasoning.

**Same shape at `sources._noise_row`** (`:666`): `np.random.default_rng(seed).random(k)`,
called twice per band per frame by `aurora` (`:722–723`), while `cell = int(t / period)`
changes only ~once per second. At 30 fps that is ~29 of every 30 calls recomputing an
identical array.

## 3. `colorgrade_apply` materialises a whole-block luminance it reads one slice at a time

`look_fx.py:134`, and `:167`:

```python
lum = _luminance(rgb)  # (T,H,W) float32 0..255
```

Built up front for all three modes — but `duotone` and `neon` only ever touch `lum[i]` inside
their per-frame loops.

The cost is worst exactly where it hurts: a sim-free graph renders the HD segment path at
`nativeShort = min(w, h)` = 1080 (`routes/export.py:229`), so a block is `(15, 1920, 1080)`
float32 ≈ **124 MB** allocated, touched one slice at a time, and discarded.

Move the computation inside the loop for those two modes. Check what the third mode does
before touching it — if it genuinely needs the whole block (a temporal operation), leave that
branch alone and say why in a comment.

> ✅ Landed in `372edb9`. All **three** modes read one slice at a time — `thermal` too, which
> additionally built a second whole-block `(T,H,W)` uint8 `idx` array — so all three moved
> inside their loops. Measured on a 15-frame 1080p block:
>
> | mode | peak before | peak after | time |
> |---|---|---|---|
> | thermal | 356.0 MB | 175.5 MB | 0.45 → 0.44 s |
> | duotone | 356.0 MB | 197.8 MB | 0.56 → 0.54 s |
> | neon | 356.0 MB | 191.8 MB | 0.36 → 0.36 s |
>
> **This is a memory win, not a speed win**, and was reported that way. The audit implied a
> throughput gain ("only read one slice at a time"); the arithmetic is unchanged and so is
> the wall clock. Halving peak on the HD export path is still worth having — it is the path
> most likely to hit a memory ceiling — but the honest claim is the narrow one.

---

## Verification

1. `assert_frames_close` at `atol=0` for **all three** — unlike step 17, none of these is an
   approximation. Any pixel difference is a bug, not a tolerance question.
   - transform: a card with constant params **and** one with a modulated `zoom`, to prove the
     hoist did not capture the modulated path.
   - clouds/aurora: the seeded-determinism property is the point — same seed, same output,
     across repeated renders in one process (which is what the cache now spans).
   - colorgrade: each of the three modes.
2. Step-16 benchmark: the transform block case and the clouds clip case, before and after.
3. `test_card_impact` green.

## Acceptance criteria

- Each fix commits with its own before/after number. ✅ for 2 and 3 (`372edb9`).
- No `RENDER_VERSION` bump — and if any *does* move a pixel, stop and work out why rather
  than bumping. These are meant to be exactly equivalent. ✅ both landed bit-identical,
  verified with `assert_frames_close` at exact.
- ~~The `lru_cache` is bounded and its array is non-writeable.~~ Moot — no cache was needed.

## Status

| Fix | State |
|---|---|
| 1. `_transform_frames` | ✅ `8cefeb7`, 8.3× — via `cv2.remap`, **not** the proposed hoist (3.6%) |
| 2. value-noise interpolation | ✅ `372edb9`, 1.83× on clouds (not the proposed cache) |
| 2b. `_noise_row` | ❌ not a finding; profiled to nothing |
| 3. per-frame luminance | ✅ `372edb9`, peak halved |

## Risks

- ~~**The mutable-cache trap** in fix 2~~ — gone with the cache.
- **Constancy detection in fix 1** misfiring on a param that is constant *within* a block but
  varies across blocks. Block-local constancy is still correct here (`coords` is rebuilt per
  block), but confirm the resolved arrays really are block-scoped before relying on it.
- **Believing this file.** **All three** of its findings were wrong on the numbers, in the
  same direction: allocation size read as cost, without profiling. Two proposed caches that
  would have saved ~0%, and a hoist worth 3.6% where the real target was an 88% library call
  standing next to it. Every one was corrected by a three-line measurement taken before the
  fix was written. That is the habit worth carrying into step 17 — which is the one finding
  in this wave that measurement *confirmed*, and even understated (5.9×, not the ~3× claimed).
