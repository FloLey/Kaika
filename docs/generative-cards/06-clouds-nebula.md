# 06 — Clouds / nebula   `[gen]` · effort 🟢 · Natural / elemental

## Concept

Slow, volumetric clouds of coloured mist drifting across the frame — read as
soft daytime clouds with a pale palette, or as a deep-space nebula with a
saturated purple/cyan one. Endlessly billowing, never repeating. A gorgeous,
cheap ambient background that almost any other card sits well on top of.

**Elegant↔energetic range:** large soft low-contrast puffs drifting slowly =
dreamy; small high-contrast high-turbulence wisps churning fast = a roiling
storm-front or a violent nebula.

## Signal map

| Signal | Natural target |
|---|---|
| `energy` | `brightness` — the clouds glow with loudness |
| `brightness` | `hue` drift |
| `flux` | `turbulence` — busier = more roil |
| `bar` | slow `drift` phase (structure evolves per bar) |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `scale` | scale | 0..1 | 0.5 | cloud feature size (small wisps ↔ big puffs) |
| `drift` | drift | 0.05..2 | 0.3 | scroll speed across the frame |
| `turbulence` | turbulence | 0..1 | 0.4 | domain-warp strength (roil) |
| `hue` | hue | 0..1 | 0.6 | base colour |
| `hue_range` | hue range | 0..1 | 0.3 | colour spread across density |
| `contrast` | contrast | 0..1 | 0.5 | soft haze ↔ hard-edged billows |
| `brightness` | brightness | 0..1 | 0.6 | overall intensity |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `palette`: `"sky"` / `"nebula"` / `"ink"` / `"ember"`.
- `seed`: int.

## Backend algorithm

Stateless fbm field → copies `backdrop`.

1. **Domain-warped fbm**: sample fbm noise at `p = (x, y) + drift·t·dir`, then
   warp `p += turbulence · fbm(p + offset)` once or twice for the billowing look.
   `scale` sets the base frequency.
2. Density `d = fbm(warped p)` → map through the palette by `d` (low = dark/
   transparent, high = bright cloud), hue = `hue + hue_range·d`. `contrast`
   applies a `smoothstep`/gamma to `d`. `brightness` scales luminance.
3. Alpha = `smoothstep(d)` so thin regions are transparent. `opacity` scales it.

fbm = a few octaves of the shared value-noise helper; all numpy, cheap even at
1080p (downsample the noise and upsample if needed).

## Frontend card

Copy `BackdropNode.tsx` + a `palette` `<select>`.

## Template & effort

Copy **`backdrop`**. 🟢 — the archetypal stateless field card.

## Playground demo

`clouds-nebula` → `output`, `energy` → `brightness`, `flux` → `turbulence`.

## Variants / open questions

- `light_dir`: a shading direction so the puffs get a lit/shadowed side (more
  volumetric).
- Could double as the texture source for `10-warp-tunnel` if we let cards accept
  a texture input — out of scope for v1.
- Overlaps conceptually with the existing `noise` *modulator*, but this is a full
  RGBA **video** producer, not a 0..1 curve — distinct role.
