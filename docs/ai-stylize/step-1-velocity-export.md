# Step 1 — Velocity export + warp validation (Workflow B)

**Goal:** capture the fluid sim's exact per-frame velocity field and cache it alongside the dye
frames, then extend the Step 0 prototype to warp the previous frame by that field before img2img
(the brief's **Workflow B**, §7). This is Kaika's structural advantage — we have the *exact*
motion the solver computed, where Deforum/ComfyUI can only estimate it via optical flow.

**Still no card.** This step touches the backend sim/cache and the prototype only, so the win
(warp beats no-warp) is proven before card work.

## Prerequisites

- Step 0 passed (a working loop + chosen model).

## Background (verified in code)

`backend/fluid.py:FluidClip.advance` (lines ~500-514) is the one place per-frame state is live:

```python
for i in range(a, b):
    self._layer.apply(sim, i)
    sim.step()
    frames[i - a] = _tonemap(sim.current_dye(), bg=self._bg)
```

Right there, `sim.u` and `sim.v` (float32 `(gh, gw)`, velocity in **grid cells/frame**) are in
memory and thrown away. Capturing them is nearly free relative to the FFT solve that just ran.
`backend/fluid_cache.py:frame_writer(key, shape)` already streams blocks to a memmap and is keyed
by `fluid.params_hash(params)` — the velocity field is fully determined by the *same* params, so
the *same* key namespace works with a `.vel` suffix.

## What to build

### 1. Capture velocity in the sim clip
Add an **opt-in** velocity channel to `FluidClip`, off by default so nothing pays until used:

- `FluidClip.__init__(..., capture_velocity: bool = False)`.
- When enabled, `advance(a, b)` also fills a `vel[i-a] = stack(sim.u, sim.v)` array
  (`[b-a, gh, gw, 2]`, float32) and returns it (e.g. `advance` returns `(frames, vel|None)`, or a
  sibling `advance_velocity()` — pick whichever keeps the existing single-return callers untouched;
  a tuple with a compat wrapper is cleanest given `simulate()` also calls `advance`).
- Keep units documented: cells/frame, on the coarse grid; the consumer upscales + rescales to
  pixels (calibrated visually — the brief warns the sign/scale needs calibration).

### 2. Cache velocity next to the dye frames
Mirror `_sim_blocks` (`graph_render.py:500`) with a parallel writer:

- Velocity is float32, not uint8 — either add a `dtype` arg to `fluid_cache.frame_writer` (it
  currently hard-codes `np.uint8` at line 96) or add a small `frame_writer_f32` sibling. Prefer
  parameterizing `frame_writer(key, shape, dtype=np.uint8)` — minimal, backward-compatible.
- Key: `f"{params_hash(params)}.vel"` (distinct file, same determinant). Store as
  `<key>.vel.npy`; `load`/`evict`/`clear` already glob `*.npy` so it's swept and bounded for free.
- Only write velocity when a downstream consumer needs it (see Step 2: the AI card requests it).
  For Step 1, a flag/env (`FLUID_VELOCITY_CACHE=1`) gating the capture is enough.

### 3. Warp in the prototype (Workflow B)
Add the brief §7 `warp_image(prev, flow_u, flow_v)` (`cv2.remap` with
`map_x = grid_x - flow_u`, `map_y = grid_y - flow_v`) to `scripts/ai_stylize_prototype.py`:

- Load `<key>.vel.npy`, upscale each `(u, v)` to the working resolution (remember to **scale the
  magnitude** by the pixel/grid ratio when you upscale — a cell displacement becomes several
  pixels), calibrate sign visually on 2–3 frames.
- Loop becomes: `warped = warp_image(prev, u_t, v_t)` → `pipe(image=warped, control=canny(frame_t),
  strength=DENOISE, ...)`. Because the start frame is "already in the pose," you can **lower**
  denoise vs Step 0 — test 0.35–0.45.

## Risks

- **Sign / scale calibration** — the brief explicitly flags it. Mitigation: a debug mode that
  writes the warped frames alone (no diffusion) so you can eyeball that matter flows the right way.
- **Boundary holes / stretching** where the warp pulls from off-grid — `BORDER_REFLECT` (brief's
  choice) hides most; the diffusion pass cleans the rest.
- **Cache size** — float32 velocity is ~2× a uint8 RGB frame per pixel-pair but at grid res still
  ~260 KB/frame; the 8 GB LRU cap already covers it. Note it in ARCHITECTURE later (Step 2).
- **Backward compatibility** — `simulate()` and every existing `advance` caller must keep working.
  Guard the new return shape behind the flag / a wrapper.

## Exit gate

Side-by-side: Workflow A (Step 0, no warp) vs Workflow B (warp), **same seed, same denoise, same
prompt**. The warped version must show visibly less flicker / more "flowing matter." If it doesn't,
recheck the sign/scale calibration before proceeding — the whole feature's differentiator rests
here.

## Verification

- Manual: the A/B flicker comparison mp4s; a warp-only debug clip proving flow direction.
- Automated (light): a unit test that `FluidClip(capture_velocity=True).advance` returns a
  `(frames, vel)` with `vel.shape == (n, gh, gw, 2)` and finite values; a `fluid_cache` test that
  a float32 `frame_writer` round-trips. Run `make test-backend`. No render-semantics change yet, so
  **no `RENDER_VERSION` bump** (velocity isn't visible in any rendered output until Step 2).
