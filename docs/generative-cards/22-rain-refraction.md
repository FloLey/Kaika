# 22 — Rain on water (refraction)   `[fx]` · effort 🔴 · Video→video FX

**The headline idea.** Droplets strike the surface of a pool; each impact sends a
ring of ripples spreading and fading, and the whole underlying picture is seen
*through* that disturbed water — bent, wobbling, catching glints of light. The
image is the pond bed; the music makes it rain.

## Concept

An `[fx]` card that treats the incoming frames as a texture viewed through a
rippling water surface. It maintains a **height field**; drops spawn expanding
rings on it; the field's gradient **refracts** (remaps) the source pixels, so
still parts of the image sit calm while ripples distort locally. Add a specular
glint on the wave slopes and it reads as real water.

**Elegant↔energetic range:** a rare drop with gentle `strength` and high
`damping` = a single meditative ripple crossing a calm pond; a downpour of drops
with high `strength` and low `damping` = a churning, near-abstract liquid mirror.

## Signal map

| Signal | Natural target |
|---|---|
| `onset` (drums) | `drop_rate` — each hit spawns droplets |
| `energy` | `strength` — louder = bigger ripples |
| `flux` | `damping` (busier = choppier / less settling) |
| `brightness` | `specular` glint intensity |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `drop_rate` | drops | 0..1 | 0.3 | droplet spawn rate (rising edges add drops) |
| `strength` | strength | 0..1 | 0.5 | ripple amplitude → refraction magnitude |
| `damping` | damping | 0..1 | 0.5 | how fast the surface settles |
| `refraction` | refraction | 0..0.1 | 0.03 | max pixel displacement from the height gradient |
| `specular` | glint | 0..1 | 0.3 | highlight strength on wave slopes |
| `spread` | ring size | 0..1 | 0.5 | ripple wavelength / ring spacing |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `sim_scale`: simulation grid resolution (e.g. ¼ of output for speed; the height
  field can be low-res and upsampled before remapping).
- `bed`: `"video"` (refract the input) or `"tint"` (a plain coloured pool if no
  input is wired — makes it usable as a near-`[gen]` too).
- `seed`: int (drop positions).

## Backend algorithm — **stateful** (copies `transform` + `FluidClip` streaming)

The height field integrates over time, so blocks must run **sequentially** and
carry state, exactly like `FluidClip.advance(a, b)`.

1. **Setup** (`_rain_refraction_block`): resolve the source
   (`producer = dag._block_producer(src)`), the params (`dag._fx_params(node)`),
   and allocate two height buffers `h`, `h_prev` at `sim_scale`. Precompute drop
   events from the full `drop_rate` array (rising edges → `(frame, x, y, amp)`
   from `seed`).
2. **Ripple update** per frame — a cheap 2-D wave equation (the classic
   "pond ripple" stencil):
   `h_new = (h[N,S,E,W] averaged) − h_prev`, then `h_new *= (1 − damping·k)`.
   Inject `strength·amp` at each drop's cell on its spawn frame. Swap buffers.
   This is O(sim pixels) per frame — sub-fluid cost.
3. **Refract**: gradient `(∂h/∂x, ∂h/∂y)` (upsampled to output size) gives a
   per-pixel offset `refraction·∇h`; remap the source frame with
   `scipy.ndimage.map_coordinates` (or a vectorised bilinear gather). Add
   `specular · relu(∇h·light_dir)` as a white highlight.
4. Output RGBA; `opacity` scales alpha.

**Streaming contract**: `produce(a, b)` advances the wave sim from where the last
block left off (state in the closure). Blocks are front-to-back and contiguous
(the render engine guarantees it, same as fluid), so the streamed result equals a
whole-clip render. The whole-clip handler runs the same loop over `[0, nframes]`.
Because it's stateful, it should register any resources and — like fluid — is a
good candidate for the raw-frame cache if the sim is expensive.

## Frontend card

Copy `TransformNode.tsx` (video input). Add a `bed` `<select>`. The card previews
over its upstream producer.

## Template & effort

Copy **`transform`** for the I/O + **`FluidClip`** for the stateful streaming.
🔴 — a real (if lightweight) time-integrated simulation plus a per-frame remap;
the most involved of the FX cards, and the one whose look most rewards the effort.

## Playground demo

An `image` card (dummy photo) → `rain-refraction` → `output`, `onset` (drums) →
`drop_rate`, `energy` → `strength`. Bundle the dummy asset (`[fx]` needs an
upstream).

## Variants / open questions

- `caustics`: add refracted-light caustic patterns on a "floor" for a
  looking-into-a-pool look.
- `rain_layer`: optionally composite falling drops (borrow `05-rain-storm`) that
  *cause* the ripples they land as — visually ties the effect together.
- A pure `[gen]` sibling ("water surface") is just `bed:"tint"` with no input —
  could ship as a preset rather than a separate card.
- Tunable `sim_scale` trades fidelity for speed; document the default (¼) and its
  cost.
