# Playground cards — new node types for the animation graph

> The animation **playground** (`GraphCanvas`) wires **cards** along three flows —
> `value` (a 0–1 curve), `video` (dye-on-transparent frames), and `points` (a list
> of normalised positions). Today only five cards exist (signal, fluid, points,
> combine, output), which leaves the graph thin in three places: the **only `value`
> source is a studio signal** (you can't blend, generate, or re-shape signals in the
> graph), **points are hand-drawn only**, and **every pixel comes from the fluid
> sim** (no post-FX, no non-fluid sources). This spec set adds **14 cards** to close
> those gaps, grouped by the infrastructure they share so each group is one doc.

## Why now

The five existing cards prove the extension model end-to-end (registry → component →
factory → backend handler), and two seams in the backend were left explicitly open
for exactly this:

- `backend/graph.py` `build_params.resolve_source` resolves a node to a 0–1 curve and
  carries the hint `# elif node["type"] == "combine":   # <- future: resolve inputs, mix`.
  Only `signal` is handled today; new `value` cards slot in here.
- `backend/graph.py` `_VIDEO_HANDLERS` / `_EMITTER_HANDLERS` are a `type -> handler`
  registry with the note *"Adding a producing node type = write a handler + register
  it here."* New `video` cards slot in here.

So the cards below are additive: no rewrite of the canvas, the renderer, or the
existing five cards.

## The cards (9)

| Spec | Group | Cards |
|------|-------|-------|
| `01-signal-modulator-cards.md` | A · `value` | Math/Blend, LFO/Oscillator, Noise, Shaper/Remap |
| `02-points-cards.md` | B · `points` | Pattern/Shape, Animate Points |
| `03-video-fx-cards.md` | C · `video→video` | Transform/Kaleidoscope, Color/Hue |
| `04-source-cards.md` | D · `→video` | Lyrics/Text |

## The extension recipe (every card follows this)

The single source of truth for a card is its `NODE_TYPES` entry in
`frontend/src/components/animation/nodes/registry.ts`. Adding a card is:

1. **Type** — add a `data` interface + a member to the `GraphNode` discriminated
   union in `frontend/src/lib/types.ts` (keyed on `type`). `PortFlow` already covers
   `value | video | points`; no new flow is needed.
2. **Factory** — a `(x, y) => GraphNode` in `frontend/src/lib/graphModel.ts` (use
   `mkNodeId()`), and teach `normalizeGraph()` the card's default `data` so older
   saves upgrade cleanly. Bump `GRAPH_VERSION` (currently `2`) once per shipped batch.
3. **Component** — a `.tsx` implementing `NodeProps` (`./nodeProps.ts`), built from
   `NodeFrame` + `Port` (`./NodeFrame.tsx`). Each `Port` declares `kind` (`in`/`out`)
   and `flow`; the canvas validates drops with `connectIssue`/`canConnect`
   (`frontend/src/components/animation/ports.ts`) — flows must match.
4. **Registry** — one `NODE_TYPES` entry: `Component`, `chrome` (`title`, `accent`,
   `outFlow`), `factory`, and a `palette` entry (`label`, `order`, `category`). The
   `PaletteCategory` set is `sources | generators | compositing | output`; this batch
   adds a **`modulators`** category for Group A (see spec 01).
5. **Backend handler** — for `value` cards, a branch in `resolve_source`; for `video`
   cards, an entry in `_VIDEO_HANDLERS`. Points cards are consumed by other nodes, so
   they need no handler of their own (a fluid/source reads `node.data.points`).
6. **Docs** — a `<h3 id="animation-<card>">` under the `<section id="animation">` in
   `frontend/src/components/Docs.tsx`, plus the matching `?`/`Info.jsx` section id.

## Two cross-cutting pieces this batch introduces (defined once, reused)

These are the only genuinely new infrastructure; each spec references them rather
than re-deriving.

### P1 — `value → value` wiring (plain value edges)

Today a `value` edge **only** exists as a fluid-port binding (`graphModel.connect`
writes both a `{kind:"node", lo, hi}` binding *and* an edge — the §3.3 invariant).
The `lo/hi` mapping (0–1 → native units) is a property of the **consuming fluid
param**, not of the wire. Group A introduces value cards that consume other value
nodes (Math takes 2 inputs, Shaper takes 1), so we need **plain value edges** that
carry no `lo/hi` — the 0–1 curve passes through unchanged.

- **Frontend:** reuse the generic edge writer `graphModel.connectVideo` shape (a bare
  `{source, sourcePort, target, targetPort}` edge) for value→value, targeting a named
  input port (`"a"`, `"b"`, `"in"`). Keep the binding model **only** at the
  fluid-param boundary, where `lo/hi` is meaningful.
- **Backend:** make `resolve_source(node_id)` recurse — a value card reads its incoming
  value edges, resolves each via `resolve_source`, and combines them. The existing
  `cache` dict memoises (each node resolves once) and `validate`'s `hasCycle` already
  guarantees acyclicity, so **no topological reordering is needed** — recursion + memo
  mirrors how `_Dag.video` already resolves the video DAG.

### P2 — port-binding resolution for non-fluid cards (`resolve_ports`)

`build_params` resolves a **fluid** node's modulatable ports (const → scalar, node →
length-`nframes` native-unit array via `lo + (hi-lo)*curve`). Group C/D cards also
have modulatable params, so factor that loop (`backend/graph.py:459-468`) into a
reusable `resolve_ports(node_data, params_spec, resolve_source, nframes)` and call it
from `build_params`, the FX handlers, and the source handlers alike. Each such card
declares its own param spec in the **same shape** as
`backend/animation_params.py:FLUID_PARAM_SPEC` (`key/min/max/default/step/label`), and
keeps `data.ports[key].binding` exactly like a fluid (so the frontend reuses the
range-slider UI and `connect/disconnect` verbatim).

## Build order (dependency-correct)

1. **P1 + P2 infra**, then **spec 01** (Group A) — the value layer everything else
   modulates against; smallest blast radius, no new render path.
2. **spec 02** (Group B) — points generators/transforms; only touches the points input
   that the fluid consumes.
3. **spec 03** (Group C) — video→video FX; depends on P2 for modulation, reuses
   `fluid.composite`/`_tonemap`.
4. **spec 04** (Group D) — non-fluid sources; **Lyrics** adds a new render path (text
   rasterisation), with a minimal v1.

## Verification (whole batch)

- `npm run lint && npm run build` (frontend) and `pytest` (backend) stay green; the
  fluid-param codegen test (`tests/test_fluid_params_codegen.py`) is unaffected since
  new param specs are per-card, not in `FLUID_PARAM_SPEC`.
- Round-trip each new card through `normalizeGraph` (a v2 save with the card loads
  unchanged) and through `validate` (frontend `graphModel.validate` + backend
  `graph.validate`) — ports use only `value | video | points`, and FX/source cards are
  **not** emitter sources (they must not be wirable into a merge combine).
- For each card: build a one-card graph → `output` and confirm `render` produces an
  mp4 (the existing `/animate` path), driving at least one modulatable port from a
  signal to confirm P2 resolution.
- Each spec's cited symbols exist: `registry.ts NODE_TYPES`, `graph.py`
  `resolve_source` / `_VIDEO_HANDLERS` / `build_params`, `fluid.py`
  `composite`/`_tonemap`/`apply_background`, `signals.py` `shape`/`raw_beat`/`raw_bar`,
  `Docs.tsx` `<section id="animation">`.
