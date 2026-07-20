# 04 — Aurora   `[gen]` · effort 🟢 · Natural / elemental

## Concept

Curtains of northern light: soft vertical ribbons of green/teal/magenta hanging
from the top of the frame, waving side to side, brightening and dimming as if
breathing. Deeply calm by nature — a wedding-friendly, ambient layer — but it can
be pushed into fast, vivid, high-contrast sheets. Best over a dark or starfield
background.

**Elegant↔energetic range:** slow `sway` + few soft wide bands + low `speed` =
serene; fast `sway` + many thin saturated bands + high `speed` = an electric sky.

## Signal map

| Signal | Natural target |
|---|---|
| `harmonic` (other/vocals) | curtain brightness — tonal pads light it up |
| `chroma` | `hue` band — the colour follows the key |
| `energy` | `sway` amplitude — louder = wider waving |
| `flux` | `speed` of the rippling |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `sway` | sway | 0..1 | 0.4 | horizontal wave amplitude of the curtains |
| `speed` | speed | 0.1..3 | 0.6 | rippling / drift rate |
| `bands` | bands | 1..8 | 3 | number of overlapping curtains |
| `hue` | hue | 0..1 | 0.35 | base colour (0.35≈green → 0.8≈magenta) |
| `spread` | spread | 0..1 | 0.5 | hue variation across the bands |
| `softness` | softness | 0..1 | 0.7 | vertical falloff / blur of the curtains |
| `brightness` | brightness | 0..1 | 0.6 | overall intensity |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `seed`: int.

## Backend algorithm

Stateless field → copies `backdrop`.

1. For each of `bands` curtains `k`: a vertical intensity profile hanging from the
   top with a soft exponential/`smoothstep` falloff (`softness`), whose horizontal
   position is `x_k(y, t) = base_k + sway · sin(y·f_k + speed·t·ω_k + φ_k)` — the
   curtain wobbles more toward its bottom (classic aurora drape).
2. Intensity along the curtain modulated by a slow 1-D noise so it shimmers in
   patches; colour from `hue + spread·(k/bands)` mapped through an
   additive teal→green→magenta ramp.
3. **Additively** accumulate the bands into an RGB buffer (glowing overlaps),
   scale by `brightness`; alpha = `smoothstep` of the accumulated luminance so the
   gaps stay transparent. `opacity` scales it.

All numpy `sin`/noise over `(H, W)`. Cheap.

## Frontend card

Copy `BackdropNode.tsx`. `bands` is an int port (fmt `int`).

## Template & effort

Copy **`backdrop`**. 🟢 — additive field, no state.

## Playground demo

`aurora` → `output`, `harmonic` (other) → `brightness`, `energy` → `sway`.

## Variants / open questions

- `star_bleed`: let a wired background show through the transparent gaps (already
  works via the stack combine — just document pairing with `11-starfield`).
- A `horizon_glow` port adding a bottom gradient (aurora reflected on snow).
- Colour could optionally lock to the `chroma` pitch-class wheel for a literal
  "sky in the song's key" effect.
