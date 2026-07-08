# 04 — Transform / Kaleidoscope card (`video → video`)

> Ships C1 of `specs/playground-cards/03-video-fx-cards.md` — the only card of
> that wave never implemented. One card, one commit, following the
> `DEVELOPMENT.md` add-a-node checklist end to end. **This is a re-add, not a
> new type**: a transform/grade FX pair existed and was removed at GRAPH_VERSION
> v10 (`lib/graph/factories.ts:96-98` history comments), which drives one
> migration subtlety (§3). Helpfully the codebase still anticipates it:
> `lib/graph/core.ts:53-54` documents exactly how to re-add an FX card, and
> `backend/graph_common._field_nodes` (~:158) **already** treats
> `"transform"`/`"grade"` as pass-through for the whole-song export.

## Locked decisions

1. **Ports and ranges** (from the original spec): modulatable `zoom` (0.5–2,
   default 1), `rotate` (0–360°, default 0), `pan_x`/`pan_y` (−0.5–0.5, default
   0). Static data: `mode: "transform" | "mirror" | "kaleidoscope"`, `segments`
   (2–12, default 6, kaleidoscope only), `wrap` (bool, default false — edges
   clamp to black vs loop).
2. **Black floor preserved**: sampling outside the frame yields 0 (`cval=0`), so
   dye-on-black transparency survives and `composite`/backdrops stay correct.
3. **No emitter handler** — FX produce frames, not emitters, so a transform can
   never feed a **merge** combine (backend validate already rejects non-emitter
   sources with the "switch to layered" error; frontend `isEmitterSource` is
   false by default). Stack combines and outputs are fine.
4. **No `RENDER_VERSION` bump** — existing graphs render byte-identically, and
   any graph containing a transform hashes fresh by construction. **GRAPH_VERSION
   bumps 20 → 21** (new persisted node shape).
5. **Runs at sim/grid resolution** (pre-upscale), like every other frame op — the
   v1 choice from the original spec.
6. **Param family lives in `SOURCE_PARAM_SPEC`** (`backend/animation_params.py`
   ~:162): a `"transform"` key there flows automatically into
   `sources.SOURCE_PARAMS` → `graph_common._PORT_SPECS` (so `Dag._fx_params` and
   `graph_validate` handle transform ports with zero new code) **and** into the
   generated `frontend/src/lib/fluidParams.js` via `make gen-params`. The fluid
   codegen test is unaffected (separate table).

## 1 — Param spec + codegen

- `backend/animation_params.py`: add the `"transform"` family (4 port dicts:
  `label/min/max/step/default/fmt`; `rotate` formats as degrees).
- `make gen-params` → commit the regenerated `fluidParams.js` (never hand-edit).
- `frontend/src/lib/nodeParams.ts`:
  `export const TRANSFORM_PARAMS: FluidParam[] = SOURCE_PARAMS.transform;` and a
  `transform: TRANSFORM_PARAMS` entry in `NODE_PARAMS`.

## 2 — Backend handlers (`backend/graph_render.py`)

Shared core:

```python
def _transform_frames(frames, mode, segments, wrap, zoom, rotate, pan_x, pan_y):
    """(T,H,W,C) uint8, C in {3,4} — RGBA warps alpha along with colour.
    Params are scalars or per-frame float32 arrays (Dag._fx_params output)."""
```

Per frame: normalized centered coords → inverse affine (rotate deg→rad, divide
by zoom, subtract pan); `mirror` reflects x < 0.5; `kaleidoscope` folds the
`atan2` angle into a mirrored `2π/segments` wedge; sample each channel with
`scipy.ndimage.map_coordinates(order=1, mode="wrap" if wrap else "constant",
cval=0.0)` — the same machinery `fluid._advect` already uses; no new dependency.

- `_transform_video(dag, node)`: `src = _video_source(dag.graph, node["id"],
  "video")`; `ValueError` if unwired (mirror `_output_block`'s message style);
  `frames = dag.video(src)`; `params = dag._fx_params(node)` (full-segment,
  via spec 02's `resolve_port`); return `_transform_frames(...)`.
- `_transform_block(dag, node)`: resolve params once for the full segment;
  `producer = dag._block_producer(src)`; the returned `produce(a, b)` applies
  `_transform_frames` to `producer(a, b)` with params sliced `[a:b]` — the
  `_image_block`/`_lyrics_block` pattern. **Both registrations are mandatory**
  (whole-clip + streaming lockstep invariant): `_VIDEO_HANDLERS["transform"]`
  (~:723) and `_BLOCK_HANDLERS["transform"]` (~:864).
- `_VIDEO_PRODUCERS` and the output-wiring check pick the type up from the
  registry automatically; `output_hash`'s contributing-DAG walk is edge-generic
  — no hashing edits.

## 3 — Frontend graph model

- **`lib/types.ts`**: `TransformData { mode: "transform" | "mirror" |
  "kaleidoscope"; segments: number; wrap: boolean; ports: Record<string,
  FluidPort> }`; `TransformNode` member in the `GraphNode` union.
- **`lib/graph/factories.ts`**: `transformNode(x, y)` (ports seeded from
  `TRANSFORM_PARAMS` defaults); **GRAPH_VERSION 20 → 21** with a history
  comment: *v21: re-added the transform video-FX card (removed at v10);
  pre-v10 transform/grade nodes are still dropped explicitly.*
- **`lib/graph/normalize.ts`** — two parts:
  1. `DATA_SCHEMAS.transform`: mode enum-coerce, `segments` int-clamp 2–12,
     `wrap` bool, `ports: coercePorts("transform", …)` (follow the video-card
     branch, ~:238). Add `transform` to `KNOWN_NODE_TYPES`.
  2. **The re-add migration**: today pre-v10 `transform`/`grade` nodes are
     dropped by the unknown-type filter (~:265-267). Re-adding `transform` to
     the known set would silently resurrect pre-v10 nodes with an incompatible
     data shape. Where `legacy = version < 8` is computed (~:185), add a
     `version < 10` branch that renames those nodes to a retired sentinel type
     (e.g. `"transform-legacy"`) so the unknown-type filter still removes them —
     preserving the v10 migration's semantics. Keep `normalizeGraph` idempotent.
- **`lib/graph/core.ts`**: add `"transform"` to `VIDEO_PRODUCERS` — **not**
  `VIDEO_SOURCES` (it consumes a video input); this is what the :53 comment
  prescribes.
- **`lib/graph/validate.ts` + `hash.ts`**: `nodeRenderable`/the contributing
  walk treat transform like the output pass-through — renderable iff its
  `video` input is wired to a renderable producer; recurse into the source
  (mirrors backend `_field_nodes`).
- **`lib/graphModel.ts`** barrel: re-export `transformNode`. Wiring needs no new
  code — `connectVideo` for the video edge, `connect`/`disconnect` for ports
  (generic over `NODE_PARAMS`, which now knows `transform`), binding↔edge
  invariant untouched.

## 4 — Card + registry

- **New `components/animation/nodes/TransformNode.tsx`** (`CombineNode` is the
  closest template): `NodeFrame` with a `video` in-port and `out` port;
  `StreamPreview` body (live preview works automatically once the type is in
  `VIDEO_PRODUCERS`); mode `<select>`; `segments` input rendered only in
  kaleidoscope mode; `wrap` toggle (`ui/Ctl`); four `FluidParamRow`s from
  `TRANSFORM_PARAMS`; `ArgInfo` on the statics pointing at the Docs section.
- **`nodes/registry.ts`**: one `NODE_TYPES` entry — `Component`, `chrome`
  (`title: "transform"`, an unused accent, `outFlow: "video"`), `factory`, and a
  `palette` entry (label "Transform", category `compositing` after combine,
  help: "Pan, zoom, rotate, mirror or kaleidoscope the video — wire rotate to a
  signal for beat-locked motion.", `io: { in: "video", out: "video" }`). The
  single entry wires palette, canvas dispatch, and compact card.
- **`lib/paramHelp.ts`**: one-liners for `zoom`, `rotate`, `pan_x`, `pan_y`,
  `mode`, `segments`, `wrap` — the paramHelp test fails on any port without
  help.

## 5 — Docs (part of the deliverable, per CLAUDE.md)

- **`Docs.tsx`**: a `animation-transform` block in the animation section — what
  each mode does, the black-edges-vs-wrap choice, and that it can't feed a merge
  (only layered combines / outputs). Add the id to `DOC_SECTION_IDS` if a
  dedicated anchor is used (anchor-guard test keeps it honest).
- **`ARCHITECTURE.md` / `DEVELOPMENT.md`**: add the card to the card counts /
  flow diagram line; **`README.md`** feature sentence if the card list there is
  updated by convention.

## 6 — Playground pipeline + tests

- `backend/card_demo.py` `CARD_LABELS` (~:27): `"transform": "Transform"`.
- Build the demo live: `make dev` → Playground → a segment labelled
  **Transform** with `fluid → transform(kaleidoscope, rotate ← LFO) → output` →
  `make export-playground` (never hand-edit `playground_pipelines.json`) →
  `make seed-playground` to confirm. `tests/test_card_impact.py` then enforces
  the demo renders non-blank forever.
- **New `tests/test_graph_transform.py`**:
  - whole-clip vs block **parity**: same graph via `Dag.video` and via the
    block producer path, frames equal (the lockstep invariant, tested directly);
  - **black floor**: all-black input stays all-black in all three modes, wrap
    on and off;
  - **validate**: transform → merge combine raises `ValueError`; transform →
    stacked combine and → output pass; transform with no video input raises;
  - **hash stability**: a static-param transform graph yields the same
    `output_hash` twice (cache-hit guarantee).
- **Frontend**: registry round-trip + paramHelp tests auto-cover the new entry;
  add `graphModel.test.ts` cases — `normalizeGraph` drops a `version: 9`
  transform node but keeps a v21 one (ports coerced); `VIDEO_PRODUCERS`
  contains `transform`.

## Gotcha found while building

**The kaleidoscope fold samples only the source's first wedge.** Every destination pixel
maps back into an angular slice of width `2π/segments` measured from the centre, so dye
living outside that slice is never sampled and the whole frame renders black. The
Playground demo's emitter must sit *inside* the wedge (it does: `[0.72, 0.56]`, right of
centre and slightly below). A misplaced emitter rendered `max=2` and still passed the old
`frames.max() > 0` blankness check — which is why that check was tightened (see PLAN.md).

## Verification

Single green commit: `make gen-params` (re-run → no diff), `make test`,
`make lint`, `npx tsc --noEmit`, `make export-playground` output committed
together with the code. Live: drop a Transform between a fluid and its output,
wire `rotate` to a signal — the streaming preview spins with the music; switch
detailed/compact views; run one whole-song HD export containing it (exercises
the `_field_nodes` pass-through, §Locked 4's no-bump claim).

## Out of scope

- **C2 Color/Hue grade** from the original spec — the shipped `color` card is
  the *dye* card (colours at emission), not a video→video grade; a true
  hue-shift FX remains unshipped. Do it as a follow-up card reusing this card's
  `_fx_params`/`SOURCE_PARAM_SPEC` plumbing once transform proves the seam.
- Post-upscale FX rendering (v1 runs at sim resolution, per the original spec).
