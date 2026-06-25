# 01 — Data model & persistence contract

> Foundational. Defines every shape the other steps consume: nodes, ports, edges,
> bindings, the per-segment `graph`, graph hashing, validation, and the fluid
> **param spec** that is the shared source of truth for both backend and frontend.
> This step writes **no executable code** beyond a tiny optional JSON Schema /
> fixture; it is the contract everything else implements against.

## Goal

Lock the graph data model so backend (`02`, `03`) and frontend (`04`–`07`) agree
byte-for-byte on what flows over `/animate` and what gets persisted in
`segment.graph`. Produce the canonical fixtures the backend chain is tested with
before any UI exists.

## Why / context

Two independent implementations (Python executor, JS editor) must serialize and
interpret the same graph. If the shapes drift, nothing renders. This spec is the
single place that defines them; `02`–`07` reference it rather than re-deriving.

## Files

- **Create** `specs/create-animation/fixtures/graph-min.json` — a full `/animate`
  **request body** (`{ job_id, segment:{start,end,signals}, graph }`) whose graph is
  minimal (one fluid + one output, all-constant inputs). `signals` may be `[]`.
- **Create** `specs/create-animation/fixtures/graph-modulated.json` — a full request
  body whose graph drives the fluid `force` from a signal node mapped to `[0, 45]`;
  `segment.signals` includes that signal's full def (Issue 1A — defs ride in the
  request).
- **Create** `specs/create-animation/fixtures/README.md` — what each fixture is for
  and the `job_id`/segment they assume (see Verification).

> These are request bodies (not bare graphs) so `03` can `curl --data @fixture`
> directly. The graph object lives under the `graph` key.
- *(No app code in this step.)* The shapes here are **implemented** in `04`
  (`graphModel.js`) and consumed in `03` (`graph.py`).

## Design detail

### 3.1 Node

```jsonc
{
  "id": "n-3f9a12bc",          // stable, unique within the graph; "n-" + 8 hex
  "type": "signal",            // "signal" | "constant" | "fluid" | "output"
  "x": 120, "y": 80,            // canvas position (px, in graph space)
  "data": { /* type-specific, see below */ }
}
```

`data` by type:

- **signal** — references one of the *segment's* signals:
  ```jsonc
  { "signalId": "sig-ab12cd34", "label": "drums kick energy" }
  ```
  `signalId` matches an `id` in `segment.signals[]` (see `segments.js`). `label`
  is a denormalized display copy (the node still resolves live from the signal).
- **constant** — a flat value source:
  ```jsonc
  { "value": 0.5, "label": "half" }   // value in 0..1 (normalized)
  ```
- **fluid** — the artifact. Holds **static** params inline and declares which
  params are exposed as input ports (all modulatable ones). Static params (color,
  path, toggles, duration, grid, fps) are not ports in v1:
  ```jsonc
  {
    "static": {
      "duration": 8.0, "grid": 96, "fps": 24,
      "color": [0.27, 0.69, 1.0], "intensity": 1.0, "opacity": 1.0,
      "enabled": true, "radial": false,
      "points": [[0.5, 0.5]], "path_speed": 1.0,
      "path_closed": false, "path_pingpong": false
    },
    "ports": {                       // one entry per modulatable param input
      "force":  { "binding": { "kind": "const", "value": 20.0 } },
      "angle":  { "binding": { "kind": "const", "value": 270.0 } },
      "emit":   { "binding": { "kind": "const", "value": 0.30 } }
      // ...every modulatable param key gets an entry; default kind "const"
    }
  }
  ```
- **output** — a sink; no data beyond an optional title:
  ```jsonc
  { "title": "preview" }
  ```

### 3.2 Binding (what fills a fluid input port)

A port's `binding` is **either** an inline constant **or** a reference to a wired
value-source node:

```jsonc
// inline constant (default; value in the param's NATIVE units, e.g. force 0..60)
{ "kind": "const", "value": 20.0 }

// wired from a node (signal or constant). lo/hi map the source 0..1 into native units.
{ "kind": "node", "nodeId": "n-3f9a12bc", "lo": 0.0, "hi": 45.0 }
```

> **Why both `kind:"const"` on a port AND a `constant` node type?** The inline
> const makes a fresh fluid card render immediately with sane values (no wiring
> required). The `constant` node is the draggable card the user wires when they
> want one value to fan out to several ports. Both resolve to the same thing in the
> executor. Keep the resolver generic — it takes a binding and returns native
> units; it must not care whether the source is a signal or a constant node (so a
> future `combine` node slots in as just another `nodeId`).

### 3.3 Edge

Edges are the visual wires. They are **derived from bindings** but stored
explicitly so the canvas can draw/select/delete them without walking every port:

```jsonc
{
  "id": "e-77d0",
  "source": "n-3f9a12bc",   // value-source node id
  "sourcePort": "out",       // value sources have a single "out" port in v1
  "target": "n-fluid01",     // the fluid node
  "targetPort": "force"      // the param key
}
```

**Invariant:** an edge `(source → target.targetPort)` exists **iff**
`fluidNode.data.ports[targetPort].binding == { kind:"node", nodeId:source }`. `04`
keeps them in sync (adding an edge rewrites the binding; deleting clears it back
to a `const`). The executor (`03`) reads **bindings**, not edges; edges are a
UI/persistence convenience.

### 3.4 Graph (per segment)

```jsonc
{
  "version": 1,
  "nodes": [ /* ... */ ],
  "edges": [ /* ... */ ],
  "view": { "tx": 0, "ty": 0, "scale": 1 }   // optional saved pan/zoom
}
```

Stored at `segment.graph`. `null`/absent = no animation built yet.

### 3.5 Fluid param spec (shared source of truth)

The canonical table below is implemented twice — `backend/animation_params.py`
(or a const in `graph.py`) and `frontend/src/lib/fluidParams.js` (`04`). Keep them
identical; `09` adds a test asserting the key sets match. Ranges mirror
`FluidLab.jsx` controls.

| key | label | min | max | step | default | modulatable | group |
|---|---|---|---|---|---|---|---|
| `emit` | emit | 0 | 1 | 0.02 | 0.30 | ✅ | source |
| `radius` | radius | 0.02 | 0.3 | 0.01 | 0.08 | ✅ | source |
| `force` | force | 0 | 60 | 1 | 20 | ✅ | source |
| `angle` | angle | 0 | 360 | 5 | 270 | ✅ | source |
| `rot_speed` | rot speed | -180 | 180 | 5 | 0 | ✅ | source |
| `rot_accel` | rot accel | -90 | 90 | 5 | 0 | ✅ | source |
| `intensity` | intensity | 0 | 3 | 0.1 | 1.0 | ✅ | color |
| `opacity` | opacity | 0 | 1 | 0.05 | 1.0 | ✅ | color |
| `dissipation` | dissip. | 0.85 | 0.995 | 0.005 | 0.95 | ✅ | medium |
| `velocity_dissipation` | vel diss. | 0.85 | 0.995 | 0.005 | 0.97 | ✅ | medium |
| `viscosity` | viscosity | 0 | 0.5 | 0.02 | 0.0 | ✅ | medium |
| `vorticity` | vorticity | 0 | 10 | 0.5 | 6.0 | ✅ | medium |

Static (not ports in v1, set on the fluid card): `duration` (2–30), `grid` (96
fixed), `fps` (24 fixed), `color` `[r,g,b]` 0..1, `enabled`, `radial`, `points`,
`path_speed`, `path_closed`, `path_pingpong`.

> Note the nesting in `simulate()`: `source.{emit,radius,force,angle,rot_speed,
> rot_accel,intensity,opacity,color,enabled,radial,points,path_speed,path_closed,
> path_pingpong}` and `fluid.{dissipation,velocity_dissipation,viscosity,
> vorticity}`. The spec table is flat; the executor (`03`) maps each key to its
> nested location. Record that mapping here so both sides agree:
> `emit,radius,force,angle,rot_speed,rot_accel,intensity,opacity` → `source.*`;
> `dissipation,velocity_dissipation,viscosity,vorticity` → `fluid.*`.

### 3.6 Graph hashing (for render cache)

`hash(...)` = stable SHA-1 over a canonical JSON of:
- `nodes` (id, type, data **excluding** `view`/transient),
- `edges`,
- the segment `start/end` and `job_id`,
- **the defining fields of every signal referenced by a `signal` node** — for each
  referenced `signalId`, the tuple `(stemKey, minHz, maxHz, feature, attack,
  release, invert, gamma, gain, offset, threshold)`.

Exclude `x/y/view` (moving a node must not invalidate the cache).

> **Decided (Issue 1 = send signals in the request).** Signal definitions travel in
> the `/animate` request (`segment.signals`, see `03`), so they are render *inputs*:
> changing a referenced signal's band or shaping changes the output. They must be in
> the hash, or editing a signal then re-rendering would serve the **stale** cached
> mp4. Hash only the *referenced* signals (not all of `segment.signals`) so unrelated
> signal edits don't needlessly bust the cache.

Backend computes the authoritative hash for the file name; frontend may compute the
same to short-circuit redundant renders. Reuse the SHA-1 pattern from
`fluid.params_hash` (`backend/fluid.py`).

### 3.7 Validation rules

A graph is renderable iff:
1. Exactly one `output` node and at least one `fluid` node (v1: exactly one fluid,
   wired into the output via an edge `fluid → output.video`).
2. Every `node` binding referencing a `nodeId` resolves to an existing node.
3. No cycles (v1 graphs are trees; still assert acyclic for forward-compat).
4. Every `signal` node's `signalId` exists in `segment.signals`; if not, the
   executor treats it as a flat 0 and the UI flags it (don't hard-fail a render
   because one signal was deleted).

### 3.8 Signal-id stability (Issue 2 = preserve stored ids — a hard contract)

A `signal` node references a signal by `signalId`. For that wire to survive a
reload, **signal ids must be stable across hydrate.** Today `hydrateSignals`
(`segments.js`) regenerates every id on load — a leftover guard from when ids were
a collision-prone session counter; with UUIDs it is now pure downside and would
orphan every graph reference. The contract this model depends on:

- **Hydrate preserves stored signal ids** (regenerate only if missing or, defensively,
  duplicated). Safe because ids are UUIDs (`crypto.randomUUID`) — a freshly-added
  signal cannot collide with a resumed one. Implemented in `04`.
- **Structural edits keep references intact** so no wire dangles:
  - `splitAt` clones the second half's signals with **fresh** ids → its copied graph
    must **remap** `signalId` (old→new) via the clone's id-map. The first half keeps
    its original signal ids (graph valid) but gets a **distinct** graph object (no
    shared-mutation with the clone).
  - `mergeWithPrev` keeps the earlier segment's graph (its signals are unchanged →
    valid) and drops the later segment's graph. This is the defined behavior.
  Spec'd concretely in `04`; both are covered by the round-trip test in `09`.

## Reuse

- `fluid.params_hash` / SHA-1 pattern — `backend/fluid.py`.
- Signal id/shape — `segments.js` (`mkSigId`, `SIGNAL_FIELDS`).
- Param ranges — `FluidLab.jsx` control definitions.

## Acceptance criteria

- [ ] `graph-min.json` and `graph-modulated.json` exist and conform to the shapes
      above; `graph-modulated.json` drives `force` from a signal over `[0,45]`.
- [ ] The param spec table is complete and the `source.*` / `fluid.*` nesting map
      is recorded.
- [ ] Hashing inputs/exclusions and validation rules are written down.
- [ ] `fixtures/README.md` states which `job_id` + segment the fixtures assume and
      how to obtain one.

## Verification (two-audience)

**Fixture/seed data:** a real project `job_id` with separated stems and at least
one segment. Get one via the running app (`make dev` → upload a short track), then
`GET /projects` to read its `job_id`, and pick a segment's `start/end` + a
`signalId` from `GET /projects/<job_id>`. Record these in `fixtures/README.md`.

**Agent check:** `python -c "import json,glob;[json.load(open(f)) for f in glob.glob('specs/create-animation/fixtures/*.json')]"`
parses both fixtures without error; manually confirm each field matches §3.

**User check:** open `graph-modulated.json` and read it against this spec — you can
trace a signal node → an edge → the fluid `force` port binding `{kind:"node", lo:0,
hi:45}`, and see exactly one output node. (It becomes runnable in `03`.)

## Risks & open questions

- **lo/hi placement** — kept on the binding (not a separate "map" node) for v1; a
  future explicit `map`/`combine` node can supersede it. Resolver stays generic so
  this is non-breaking.
- **Color/path modulation** — deliberately static in v1. If wanted later, add
  `color`/path keys to the spec as modulatable; executor already handles arrays.
- **Multiple outputs / fluids** — out of scope; validation enforces one each, but
  the executor walks the DAG generically so lifting the limit is a validation
  change, not an architecture change.
