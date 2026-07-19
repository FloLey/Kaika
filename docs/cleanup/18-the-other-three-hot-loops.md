# Step 18 — The other three hot loops

**Tier.** Core.

**Goal.** Three independent per-frame wastes, each with an obvious fix and no shared risk.

**Blocked by.** Step **16** (parity helper + baselines). Independent of 17 — they touch
different files and can land in either order.

**Size.** M overall; each of the three is a sitting on its own. **Land them as three
commits**, so a parity regression bisects to one.

> Line numbers are a snapshot — re-grep before relying on one.

---

## 1. `_transform_frames` rebuilds the same warp every frame

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

## 2. `procgen._value_noise_2d` rebuilds its RNG lattice on every call

`procgen.py:39`:

```python
lat = np.random.default_rng(seed).random((res_y, res_x), dtype=np.float32)
```

The lattice is a pure function of `(res_y, res_x, seed)`. But `clouds` (`sources.py:927`)
calls `_cloud_density` per layer per frame, and each call issues **~14 `fbm2d` octaves**
(5 macro + 3 + 3 warp + 3 detail). That is ~14 fresh `default_rng` constructions and lattice
draws per frame, drawn from a set of only ~14 distinct lattices for the entire clip.

`lru_cache` on the lattice draw, keyed `(res_y, res_x, seed)`. Three lines.

⚠ **Return a read-only view or a copy.** A cached array handed to a caller that mutates it in
place would corrupt every later frame — the classic `lru_cache`-on-a-mutable bug. Set
`lat.flags.writeable = False` on the cached array and let any mutating caller copy
explicitly; that turns a silent corruption into an immediate error. Also bound the cache
(`maxsize`) — seeds are user-controllable, so an unbounded cache is a slow memory leak.

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

- Three commits, each with its own before/after number.
- No `RENDER_VERSION` bump — and if any of the three *does* move a pixel, stop and work out
  why rather than bumping. These are meant to be exactly equivalent.
- The `lru_cache` is bounded and its array is non-writeable.

## Risks

- **The mutable-cache trap** in fix 2 — the only way this step corrupts output rather than
  merely failing. The non-writeable flag is not optional.
- **Constancy detection in fix 1** misfiring on a param that is constant *within* a block but
  varies across blocks. Block-local constancy is still correct here (`coords` is rebuilt per
  block), but confirm the resolved arrays really are block-scoped before relying on it.
