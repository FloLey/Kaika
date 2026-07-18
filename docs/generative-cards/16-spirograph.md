# 16 — Spirograph   `[gen]` · effort 🟡 · Geometric / retro-viz

## Concept

A harmonograph: the curve a pair of coupled, slowly damping pendulums would
trace on paper, drawn continuously over the whole clip so a luminous ink trail
accumulates into an intricate rosette. Because the pendulums decay, the figure
spirals gently inward, and because their frequency ratio is irrational-ish the
loops precess and never quite close. Reads as a few simple slow closed loops at
rest and a dense fast-precessing rosette of overlapping petals when pushed.

**Elegant↔energetic range:** simple `ratio` (near a small integer) + heavy
`damping` + thin `pen` = a couple of clean closed loops; complex ratio + light
damping + `trail: persist` + `glow` = a dense luminous rosette that fills the
frame with petals.

## Signal map

| Signal | Natural target |
|---|---|
| `brightness` | `ratio` — pitch height sets the frequency ratio (figure shape) |
| `energy` (any stem) | `amplitude`-via-`glow`/thickness — louder = bolder ink |
| `harmonic` | `damping` — tonal passages let the trail persist, noisy ones decay it |
| `chroma` | `hue` shift |

## Ports

| key | label | range | default | effect |
|---|---|---|---|---|
| `ratio` | ratio | 0.5..8 | 3.0 | frequency ratio of the two pendulum pairs |
| `damping` | damping | 0..1 | 0.3 | trail decay rate (how fast the ink fades/spirals in) |
| `phase` | phase | 0..1 | 0.0 | relative phase of the pendulum pairs |
| `thickness` | thickness | 0.5..6 px | 1.5 | pen line width |
| `glow` | glow | 0..1 | 0.4 | additive gaussian bloom on the trail |
| `hue` | hue | 0..1 | 0.55 | ink colour |
| `opacity` | opacity | 0..1 | 1.0 | layer alpha |

## Static data

- `pen`: `"single"` / `"dual"` — one traced point, or two (a second slightly
  detuned pen for a doubled interference figure).
- `trail`: `"persist"` (the whole curve stays lit) / `"fade"` (older segments
  dim with age) — the visual memory model.
- `seed`: int — perturbs the pendulum frequencies/phases.

## Backend algorithm

Stateless — the pen position `P(τ)` is a closed form, and the curve drawn up to
frame `i` is a pure function of `i` (no carried buffer), so it copies `backdrop`
(whole-clip + block handler, no `FluidClip`).

1. **Harmonograph position** at parameter `τ`:
   `x(τ) = Σ_k A_k · e^(−d·τ) · sin(f_k·τ + φ_k)` and similarly `y(τ)`, with two
   frequency pairs whose ratio is `ratio`, decay `d ∝ damping`, phases from
   `phase`/`seed`. `"dual"` pen adds a second detuned position.
2. **Sample the path** from `τ=0` to the current frame's `τ_i = i / fps · rate`
   at a fixed step (enough points per frame for a smooth line). The whole
   polyline up to `i` is recomputed from the closed form — no accumulation buffer
   carried between frames or blocks.
3. **Draw** the polyline with PIL `ImageDraw.line` (width `thickness`). For
   `trail: "fade"`, split into segments and scale each segment's alpha by its age
   (`exp(−damping·(τ_i − τ)/τ)`); for `"persist"`, draw at full alpha. Add a
   gaussian-blurred copy (`scipy.ndimage`) scaled by `glow`.
4. Colour from `hue`; alpha = trail coverage × `opacity`. Return
   `(nframes, h, w, 4)` uint8.

**Cost grows with trail length** — recomputing/redrawing the full path each frame
is O(points-so-far). Cap it: cap the sampled path length (e.g. a rolling window
of the last N seconds, which `"fade"` makes invisible anyway), or coarsen the
step for old segments. Note the cap in the spec so the implementer doesn't ship an
O(clip²) render.

## Frontend card

Copy `BackdropNode.tsx` + a `pen` `<select>` and a `trail` `<select>`.
Full-frame, no BoxPad.

## Template & effort

Copy **`backdrop`**. 🟡 for the path sampling + fading polyline + bloom, and the
trail-length cap; no sim state (the curve is a closed form), no asset.

## Playground demo

`spirograph` → `output`, `brightness` → `ratio`, `harmonic` → `damping`. No asset
needed.

## Variants / open questions

- Expose the number of frequency terms as static data — more pendulums = more
  ornate figures (at more compute).
- A `close_figure` mode that snaps `ratio` to a rational so the loop closes
  cleanly (spirograph vs harmonograph).
- Rainbow-along-length colouring (hue advances with `τ`) instead of a flat `hue`.
- Pair over `12-plasma` for a glowing ink-on-oil look.
