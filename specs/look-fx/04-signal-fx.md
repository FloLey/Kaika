# 04 — Signal FX card (`video → video`)

> Analog damage: datamosh-style glitch bursts, RGB channel splitting, a worn
> CRT/VHS screen, or night-vision goggles. THE music-video card — glitch is
> designed to be fired by a gate signal, so the image tears exactly on the
> kicks. (Palette label is **"Signal FX"** — plain "Signal" is taken by the
> signal card, and `card_demo.CARD_LABELS` must stay unique.)

## Locked decisions

1. **Four modes**: `glitch | rgbsplit | crt | nightvision` (default `glitch`).
2. **All randomness is per-frame seeded** (PLAN §3): `rng_for_frame(seed,
   frame_offset + i)`. A frame's corruption depends only on (seed, absolute
   index) — reproducible renders, stable caches, block-independent, and two
   Signal FX cards with different seeds glitch differently.
3. **Glitch is probability-gated per frame**: it fires when
   `rng.random() < amount`. An unwired `amount` (default 0.35) gives occasional
   tears; `amount` wired to a **gate** card gives clean bursts exactly on
   beats, with untouched frames in between (no residual shimmer).
4. **CRT's geometry is precomputed once**: the barrel-distortion coordinate
   grid (same `map_coordinates` backtrace as `_transform_frames`) and the
   scanline mask are built at closure setup for the frame size; per frame only
   the warp sampling + jitter roll run.
5. **Floor**: glitch/rgbsplit/crt keep black black (rolls and warps of black
   are black; `cval=0`). Nightvision's grain lifts it by design (PLAN §6) —
   end-of-chain mode, documented.

## Data + ports

```ts
export interface SignalFxData {
  mode: "glitch" | "rgbsplit" | "crt" | "nightvision";
  seed: number; // glitch band choice, crt jitter, nightvision grain
  ports: Record<string, FluidPort>;
}
```

`SOURCE_PARAM_SPEC["signalfx"]`:

| key | label | min | max | step | default | fmt |
|-----|-------|-----|-----|------|---------|-----|
| `amount` | amount | 0.0 | 1.0 | 0.01 | 0.35 | dp2 |
| `shift` | shift | 0.0 | 0.2 | 0.005 | 0.02 | dp2 |

Port → mode mapping:

| port | glitch | rgbsplit | crt | nightvision |
|------|--------|----------|-----|-------------|
| `amount` | fire probability + band count | dry ↔ split mix | scanline depth + bleed | grain + vignette strength |
| `shift` | band displacement (·W px) | channel offset (±·W px) | jitter amplitude + chroma offset | flicker amplitude |

## 1 — `backend/look_fx.py`

```python
def signalfx_apply(frames, static, fps, frame_offset, *, amount, shift):
```

- **glitch**: per fired frame, roll `N = 1 + int(amount·7)` random horizontal
  bands by `±rng.integers(shift·W)` (`np.roll` on row slices); above
  `amount > 0.6` also swap two channels inside one random rect. Unfired frames
  are returned untouched (same array, no copy).
- **rgbsplit**: `np.roll` R by `+dx`, B by `−dx` (`dx = round(shift·W)`,
  per-frame); lerp with the dry frame by `amount`. On RGBA, alpha is not
  rolled (the cut-out stays put; only colour fringes).
- **crt**: precomputed barrel warp with R/B sampled at ±small radial offsets
  (chroma bleed), × the scanline mask (`1 − amount·0.5` on odd rows), plus a
  seeded per-frame 1-px horizontal jitter roll scaled by `shift`.
- **nightvision**: luminance → green ramp (`(0.15, 1.0, 0.3)`), + seeded
  uniform grain × `amount`, × a precomputed radial vignette, × a seeded
  per-frame flicker `1 ± shift/2`.

## 2 — Backend handlers

Stateless transform pair — `_signalfx_video` / `_signalfx_block`
(`frame_offset=a`). Register in both dicts.

## 3–4 — Frontend

Standard wiring (spec 01 §3). `normalize.ts`: `mode: oneOf(...)`,
`seed: num(1)`. `SignalFxNode.tsx`: mode select + `seed` field (all modes) +
two `ParamRow`s. Registry label "Signal FX", order 3.63, help: "Glitch bursts,
RGB split, CRT scanlines or night vision. Wire amount to a gate — the image
tears exactly on the beat."

## 5 — Playground demo + tests

- `CARD_LABELS`: `"signalfx": "Signal FX"`. Demo: fluid → signalfx (glitch,
  `amount` ← gate on the kick signal) → output — the canonical beat-glitch.
- `tests/test_look_fx.py` additions:
  - seed determinism (same seed identical / different seed differs) for glitch
    and nightvision;
  - **stream ≡ sync** for glitch (block_frames=4) — the per-frame-RNG proof;
  - `amount=0` glitch → passthrough (bit-exact, no copy);
  - rgbsplit on RGBA: alpha channel untouched;
  - crt on black input → black output.

## Verification

Commit gates (PLAN). Live: the beat-glitch demo; flip all four modes; two
cards with different seeds glitch at different places; scrub across a block
seam — the corruption pattern doesn't restart.
