# 05 — Rain / storm   `[gen]` · effort 🟡 · Natural / elemental

## Concept

A sheet of falling rain: fine diagonal streaks blown by wind, splash rings where
drops land at the bottom, and the odd lightning-lit flash washing the frame. From
a light drizzle to a torrential downpour, all in one card. Transparent between
the streaks so it layers over anything (photos, fluid, aurora).

**Elegant↔energetic range:** low `density` + slow `speed` + soft `splash` = a
gentle mist on a window; high `density` + fast slanted streaks + strong `flash` =
a violent squall.

## Signal map

| Signal | Natural target |
|---|---|
| `energy` | `density` — heavier music, heavier rain |
| `onset` | `splash` bursts — hits kick up splashes |
| `flux` | `wind` gusts |
| peak / `energy` env | `flash` — occasional storm flash |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `density` | density | 0..1 | 0.5 | number of raindrops on screen |
| `speed` | speed | 0.2..4 | 1.5 | fall speed (streak length scales with it) |
| `wind` | wind | -1..1 | 0.2 | streak slant / horizontal drift |
| `splash` | splash | 0..1 | 0.4 | splash-ring intensity at the bottom |
| `flash` | flash | 0..1 | 0.2 | full-frame storm flash strength |
| `thickness` | thickness | 0.5..3 px | 1.0 | streak width |
| `hue` | hue | 0..1 | 0.58 | streak tint (cool blue default) |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `seed`: int.

## Backend algorithm

Stateless via deterministic drops → copies `backdrop`.

1. Maintain a fixed pool of `N_max` drops each with a random `(x0, phase, speed
   jitter)` from `(seed, drop_index)`. A drop's y-position at time `t` is
   `((phase + speed·t) mod 1)` mapped down-frame; `x = x0 + wind·y`. Only the
   first `density·N_max` drops are drawn (density gates count, not per-frame
   spawning — keeps it stateless).
2. Draw each visible drop as a short streak (PIL `ImageDraw.line`, length ∝
   `speed`, width `thickness`) into an RGBA scratch, tinted by `hue`.
3. **Splashes**: where a drop's y wraps past the bottom this frame (a pure
   function of `phase`, `speed`, `t`), draw an expanding ring scaled by `splash`.
4. `flash` adds a decaying white wash keyed off the wired signal (same edge trick
   as `02-lightning`). `opacity` scales alpha.

The wrap-based motion means block `[a,b]` is a pure function of `t`, no state.

## Frontend card

Copy `BackdropNode.tsx`. Note in `paramHelp` that `wind` is signed (drift left/
right).

## Template & effort

Copy **`backdrop`**. 🟡 — many line draws + splash rings; still stateless.

## Playground demo

`rain-storm` → `output`, `energy` → `density`, `onset` → `splash`.

## Variants / open questions

- A `ground` port to add a reflective wet-floor gradient at the bottom.
- Snow preset: slow `speed`, round drops (dots not streaks), gentle `wind` drift.
- Combine with `02-lightning` for a full storm (lightning's `flash` and rain's
  `flash` can share one signal).
