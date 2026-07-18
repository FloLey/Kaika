# 19 — L-system (growing plant)   `[gen]` · effort 🟡 · Organic growth

## Concept

An L-system plant — tree, fern, vine or coral — that sprouts from the bottom of
the frame, branching and blooming in time with the music and swaying as it
grows. The grammar is fixed; what the music controls is *how much* of it has
grown, its branch angles, and its bloom.

**Elegant↔energetic range:** a single slow bonsai unfurling one branch per bar,
barely swaying = serene; a fast riotous thicket that explodes new branches on
every beat and sways hard on the energy = frantic.

## Signal map

| Signal | Natural target |
|---|---|
| `bar` | `growth` — the plant grows across the bar (0→1) |
| `beat` | spawn / reveal new branches (a growth kick) |
| `energy` | `sway` — louder music sways the branches harder |
| `chroma` | `hue` of the blooms (dominant pitch → flower colour) |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `growth` | growth | 0..1 | 0.5 | fraction of the turtle path drawn this frame |
| `angle` | angle | 5..40 | 22 | branch turn angle (deg) |
| `branch_ratio` | taper | 0.4..0.9 | 0.7 | child length / parent length |
| `sway` | sway | 0..1 | 0.3 | wind amplitude added to branch angles |
| `thickness` | thickness | 0..1 | 0.5 | trunk line width (tapers with depth) |
| `bloom` | bloom | 0..1 | 0.4 | flower/leaf size at branch tips |
| `hue` | hue | 0..1 | 0.3 | bloom palette rotation |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `preset`: `"tree"` / `"fern"` / `"vine"` / `"coral"` — the grammar + axiom.
- `depth`: int — L-system iteration count (how detailed the final plant is).
- `seed`: int — stochastic rule choices and jitter.

## Backend algorithm — **stateless** (copies `backdrop`)

Growth is *derived* from the wired signal at frame `i`, not integrated across
frames, so **no state is carried** — this stays 🟡 and copies `backdrop`.

1. **Expand once** (at setup, before any frame): run the `preset` grammar for
   `depth` iterations from `seed` → a fixed string → a fixed ordered list of
   turtle segments `(x0,y0,x1,y1,depth)`. This is deterministic and done a
   single time; every frame reuses it.
2. **Per frame** read `growth = growth_port[i]` (a pure function of the wired
   `bar`/`beat` curve). Draw the **first `growth`-fraction** of the segment list
   with PIL lines; line width from `thickness`, tapering with each segment's
   depth; `angle` and `sway·energy·sin(...)` rotate branch angles so the tree
   sways. Because `growth` monotonically follows the signal, the plant appears
   to grow and shrink with the music without any carried buffer.
3. **Blooms**: at branch tips whose segment index is past a `growth` threshold,
   draw dots sized by `bloom`, coloured through the palette (`hue`). Alpha from
   the drawn ink; `opacity` scales it. Return `(nframes, h, w, 4)`.

No block-to-block state: the whole-clip and block handlers each just render
`frames[a:b]` independently — like `backdrop`, any block can be computed alone.

## Frontend card

Copy `BackdropNode.tsx` + a `preset` `<select>` and a `depth` int slider.
Previews as a standalone generator.

## Template & effort

Copy **`backdrop`**. 🟡 — the grammar expansion + turtle drawing is light state
built *once*, and PIL line drawing per frame; no time integration, so it stays
stateless and cache-free.

## Playground demo

`lsystem` → `output`, `bar` → `growth`, `beat` → (branch spawn via `growth`),
`energy` → `sway`.

## Variants / open questions

- `wither`: run `growth` in reverse over an outro so the plant recedes.
- Multiple seeds side-by-side for a hedge / forest (a `count` static that lays
  out N plants along the base).
- Gravitropism: bias `angle` upward so vines climb — a `preset` detail.
- Because expansion is one-time, very high `depth` is cheap to *store* but heavy
  to *draw* — cap the drawn-segment count and document it.
