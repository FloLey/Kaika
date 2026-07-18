# 27 — Video feedback (trails tunnel)   `[fx]` · effort 🔴 · Video→video FX

**The headline idea.** Point a camera at its own monitor and you get the classic
video-feedback tunnel — each frame contains a slightly zoomed, rotated,
hue-shifted copy of the frame before it, recursing inward forever into a
spiralling well of echoes. This card does it in software: every frame blends a
warped copy of the **previous output** back over the current input, the staple of
every live-visuals rig.

## Concept

An `[fx]` card that feeds its own output back into itself. It keeps the previous
output frame, warps it (zoom + rotate + hue-shift about a pivot), attenuates it by
`feedback·decay`, and blends it over the current input — so any bright detail
leaves a trail that spirals toward the zoom centre and fades. Because it's `[fx]`
it echoes *whatever is wired in* — a photo, a clip, a live fluid — and the trails
are of that content.

**Elegant↔energetic range:** a low `feedback` with `decay` near 1 and a tiny
`zoom` = soft ghosting trails that gently smear motion; a high `feedback` with
strong `zoom`, `rotate` on the flux, and a beat-kicked pivot = a churning
kaleidoscopic vortex pumping and spiralling on every hit.

## Signal map

| Signal | Natural target |
|---|---|
| `energy` | `feedback` — louder = stronger, longer-lived echoes |
| `beat` | `zoom` — a rising edge kicks the tunnel inward |
| `flux` | `rotate` — busier spectrum twists the spiral |
| `brightness` | `hue_shift` — spectral centroid rotates the echo hue |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `feedback` | feedback | 0..0.98 | 0.6 | gain of the fed-back previous frame (capped <1 for stability) |
| `zoom` | zoom | 0.9..1.1 | 1.02 | per-frame scale of the echo about the pivot |
| `rotate` | rotate | -30..30 | 0.0 | per-frame rotation of the echo (degrees) |
| `hue_shift` | hue | -0.1..0.1 | 0.0 | per-frame hue rotation of the echo |
| `decay` | decay | 0.8..1.0 | 0.95 | extra per-frame attenuation (keeps the loop stable) |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `blend`: `"add"` / `"screen"` / `"max"` — how the warped echo combines with the
  current input (screen is the classic soft glow; max is punchier).
- `center`: `(x, y)` pivot of the zoom/rotate (0.5, 0.5 = frame centre), the
  vanishing point of the tunnel.
- `seed`: int (reserved — any dithering/jitter; derive from seed only, never
  wall-clock, so a render is reproducible and streaming-consistent).

## Backend algorithm — **stateful** (copies `transform` + `FluidClip` streaming)

The current frame depends on the previous **output**, so blocks must run
**sequentially** and carry state, exactly like `FluidClip.advance(a, b)`.

1. **Setup** (`_video_feedback_block`): resolve the source
   (`src = _video_source(dag.graph, node["id"], "video")`; if `None` raise
   `ValueError`), `producer = dag._block_producer(src)`,
   `params = dag._fx_params(node)`, and allocate a `prev` output buffer (starts
   as zeros / the first input frame). A `_feedback_static(data)` reads
   blend/center/seed. Register cleanup like fluid (`dag._closers.append(...)`) if
   anything needs releasing.
2. **Per frame** `i` (input `in = producer` slice at `i`):
   `warped = hue_rotate(affine(prev, zoom[i], rotate[i], about center), hue_shift[i])`
   — the warp via `scipy.ndimage.affine_transform` (or a numpy bilinear remap);
   then `echo = warped · feedback[i] · decay[i]`; then
   `out = blend(in, echo)` per `blend`. Store `out` as the new `prev`.
3. **Clamp** every channel to `[0, 1]` (or `0..255`) after the blend — the whole
   point of `decay < 1` and `feedback < 1` is to keep the recursion bounded;
   without the cap a bright region can run away and bloom the frame to white.
4. Output RGBA — carry the input's alpha, or opaque where the input is
   dye-on-black `(T,H,W,3)`. `opacity` scales alpha.

**Streaming contract**: `produce(a, b)` warps and blends forward from the `prev`
frame the last block left in the closure. Blocks are front-to-back and contiguous
(the render engine guarantees it, same as fluid), so the streamed result equals a
whole-clip render, which runs the identical loop over `[0, nframes]` seeded from a
blank `prev`. Because it's stateful and the warp is per-frame, it's a good
candidate for the raw-frame cache.

## Frontend card

Copy `TransformNode.tsx` (has a video input + a mode `<select>`). Add the `blend`
select and `center` x/y inputs. The card previews over its upstream producer.

## Template & effort

Copy **`transform`** for the I/O + **`FluidClip`** for the stateful streaming. 🔴
— cross-block state plus a per-frame affine warp and hue rotation; the streaming
contract is the delicate part (a whole-clip vs. streamed mismatch would show as a
seam in the trails).

## Playground demo

An `image` card (dummy bundled photo) → `video-feedback` → `output`, with
`energy` wired to `feedback` and `beat` → `zoom`. `[fx]` cards need an upstream
producer in the demo — bundle the dummy asset per the Playground invariant.

## Variants / open questions

- `mirror`: reuse `transform`'s kaleidoscope on the fed-back frame for symmetric
  tunnels (don't reimplement — reference the existing card).
- `polar`: warp in polar coordinates for a true spiral / droste tunnel instead of
  a plain zoom.
- Runaway guard: besides the `feedback`/`decay` caps, an optional soft-knee
  limiter on the echo before blending, so a sustained loud passage can't clip to
  white — document the default caps as the primary stability mechanism.
- Colour drift accumulation: hue_shift compounds every frame — decide whether to
  wrap or clamp the accumulated rotation for long clips.
