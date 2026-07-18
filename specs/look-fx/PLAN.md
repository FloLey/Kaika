# Look FX — five themed style cards (16 effects)

> Kaika's only `video → video` cards are transform (warp), stylize (AI), and
> extract (control maps). There is **no classic "look" effect anywhere** — no
> pixelate, no glitch, no halftone (verified: zero hits for
> pixelate/posterize/halftone/dither/glitch/scanline/ascii across backend and
> frontend). This wave adds 16 hand-picked effects as **five themed cards**, each
> with a mode dropdown like transform's. All are CPU frame ops on `(T,H,W,C)`
> uint8 in the executor — the exact machinery `_transform_frames` proved — and
> every headline parameter is a modulatable port, so **every effect is
> audio-reactive by construction** (wire a signal/LFO/gate and the look pumps
> with the music). Follow-up to `specs/playground-cards/03-video-fx-cards.md`
> (C2, the never-shipped grade card, ships here as part of Color Grade).

## The cards

| Spec | Card | type | Modes |
|------|------|------|-------|
| `01-echo.md` | Echo | `echo` | motion trails (single mode) |
| `02-color-grade.md` | Color Grade | `colorgrade` | thermal · duotone · neon |
| `03-retro-screen.md` | Retro Screen | `retro` | ascii · matrix · pixelate · led |
| `04-signal-fx.md` | Signal FX | `signalfx` | glitch · rgbsplit · crt · nightvision |
| `05-print-paint.md` | Print & Paint | `paint` | halftone · comic · sketch · oil |

## Locked decisions (shared by all five)

1. **One new module, `backend/look_fx.py`** — pure pixel math, no `Dag` import
   (the `sources.py` precedent), testable standalone. `graph_render.py` gets thin
   `_xxx_video` / `_xxx_block` handlers only. Every apply function takes
   `frame_offset` (the block's absolute start index) so the whole-clip and block
   paths run the SAME code and stay byte-identical — both feed the same
   `output_hash` mp4 cache.
2. **No upstream lookback in block streaming.** `Dag.stream_blocks` pulls
   contiguous increasing ranges (`graph_render.py:396-447`;
   `FluidClip.advance`'s contract), so a block handler can never re-pull earlier
   frames. Temporal effects use one of two sanctioned shapes:
   *stateful closure* (Echo — the accumulator carried across `produce(a, b)`
   calls; safe because `_block_producer`'s one-block cache + lock runs the inner
   closure once per block, in order) or *pure function of absolute frame index*
   (matrix rain, glitch — deterministic from `seed` + `frame_offset + i`).
3. **Determinism everywhere.** Randomness only via
   `np.random.default_rng(np.random.SeedSequence([seed, abs_frame_index]))`
   (`look_fx.rng_for_frame`). `seed` is a static data field, so it participates
   in `output_hash` automatically (`_node_for_hash` keeps full `node.data`).
   Renders are reproducible and block-independent; caches stay stable.
4. **Ports live in `SOURCE_PARAM_SPEC`** (`backend/animation_params.py`) — the
   transform pattern: one entry per card, `make gen-params`, an alias +
   `NODE_PARAMS` row in `frontend/src/lib/nodeParams.ts`. Ports are fixed per
   node type, so each card declares a small generic set that every mode
   reinterprets (each spec carries the port→mode mapping table; no-op ports for
   a mode are documented in paramHelp).
5. **FX rules inherited from transform** (`specs/improvement-batch/04`):
   `_VIDEO_HANDLERS` + `_BLOCK_HANDLERS` only, never `_EMITTER_HANDLERS` (can't
   feed a merge combine); category `compositing`, accent `var(--fx)`,
   `outFlow: "video"`, palette orders 3.61–3.69 (after stylize's 3.6); runs at
   sim/grid resolution (pre-upscale); add each type to frontend
   `lib/graph/core.ts` `VIDEO_FX`.
6. **The dye-on-black floor is documented per mode, not enforced.** Most modes
   keep black black (ascii/pixelate/halftone/echo/glitch…). The deliberate
   exceptions — duotone (shadow colour at black), thermal with jet/ocean maps,
   nightvision grain — **lift the floor by design**: they are grades meant to
   sit at the END of the chain (feeding the output, or the bottom of a stack).
   Docs say so; nothing breaks (`composite` just sees an opaque layer, like a
   backdrop).
7. **One `GRAPH_VERSION` bump 23 → 24** ("added the five look-FX cards — pure
   additions, no migration") with the FIRST card to land; the rest ride it. One
   `RENDER_VERSION` bump 6 → 7 likewise. Playground fixtures are exported only
   AFTER the v24 bump (stale stamps silently drop cards on UI load — see
   improvement-batch "found while building" #2).
8. **Naming**: palette label "Signal" is taken by the signal card, so card 4 is
   **"Signal FX"** (`signalfx`). Labels: Echo · Color Grade · Retro Screen ·
   Signal FX · Print & Paint.
9. **Perf budget**: preview must stay fluid at draft/normal quality. Everything
   is vectorized over `(H, W)` per frame (the `_transform_frames` loop-over-T
   norm). The two heavy modes (comic, oil) run through a shared
   `look_fx._at_reduced(frame, fn, max_side=320)` down-apply-up helper. Caches
   keyed by quantized int pixel sizes (glyph atlas, dot masks) are `lru_cache`
   bounded, so a modulated cell size can't allocate unboundedly.
10. **`cv2.xphoto` is absent** (the venv ships `opencv-python-headless`, no
    contrib — verified). `requirements.txt` swaps to
    `opencv-contrib-python-headless==5.0.0` for oil; the handler still guards
    with `hasattr(cv2, "xphoto")` and falls back to a numpy Kuwahara-style
    filter so the card never 500s (wheel availability is a spec 05 risk).

## Build order & commit sequence

Each commit green: `make test`, `make lint`, `cd frontend && npm run typecheck`.
Order chosen so the hardest invariants are proven first on the smallest cards.

| # | Commit | Spec | Proves |
|---|--------|------|--------|
| 1 | Echo card end-to-end (+ v24, + RENDER_VERSION 7, + `look_fx.py`) | 01 | the whole add-a-node seam + the stateful-block shape + stream ≡ sync test |
| 2 | Color Grade card | 02 | the `tint` colour-input plumbing on an FX card |
| 3 | Retro Screen card | 03 | glyph atlas + deterministic-trajectory shape |
| 4 | Signal FX card | 04 | seeded per-frame RNG shape; beat-gated demo |
| 5 | Print & Paint card (+ contrib swap) | 05 | reduced-res helper; the one dependency change, isolated |
| 6 | Playground demos ×5 + Docs prose | all | `make export-playground` after everything is in |

## Shared verification

- `make gen-params` re-run → no diff; `make test` (incl. the new
  `tests/test_look_fx.py`), `make lint`, `npm run typecheck`.
- `tests/test_look_fx.py` pins the two invariants for every temporal/seeded
  mode: **stream ≡ sync** (concatenated `stream_blocks` at block_frames=4 equals
  `Dag.video()` exactly) and **seed determinism** (same seed → identical, other
  seed → different).
- `test_card_impact.py` demo floors are `peak >= 32` and `lit >= 0.5%` — the
  dark-output modes (led, halftone, neon) need bright demo inputs/params (each
  spec names its demo pipeline).
- Live (`make dev`, Playground): flip every mode of every card; wire an LFO to
  the headline port and watch the streamed preview react; scrub across a ~5 s
  block seam on echo/matrix — no visible discontinuity.

## Out of scope

- GPU/shader rendering (no WebGL exists anywhere in the app; not adding it).
- Per-effect cards or per-mode port sets (ports are fixed per type; the generic
  sets are the trade-off accepted with the themed-card packaging).
- Time displacement / slit-scan and the other 10 unselected catalog ideas
  (strobe/freeze, posterize-alone, solarize, emboss, stained glass, contour,
  bloom, vintage film, scan sweep, watercolor) — same seams, later wave.
- Echo trails crossing segment cuts in the whole-song export (each segment
  styles through its own DAG; trails reset at the cut — documented in Docs).
