# 04 — Frontend graph lib

> The pure-JS foundation for the editor: node/edge factories, the fluid param spec
> (mirroring backend), graph hashing/validation, persistence wiring into
> `segments.js`, and the `api.renderGraph` call. No React yet — all unit-testable.

## Goal

Implement the `01` data model in JavaScript as small, tested, framework-free
modules that `05`–`07` consume. Make `segment.graph` round-trip through autosave.

## Files

- **Create** `frontend/src/lib/graphModel.js` — factories, mutation helpers, hash,
  validate.
- **Create** `frontend/src/lib/fluidParams.js` — the param spec (the `01` table).
- **Modify** `frontend/src/lib/segments.js` — carry `graph` through `serialize` /
  `hydrate`.
- **Modify** `frontend/src/lib/api.js` — add `renderGraph(payload)`.

## Design detail

### `fluidParams.js`

```js
// Mirrors backend animation_params.PARAMS + UI metadata (label/step/group).
export const FLUID_PARAMS = [
  { key: "emit", label: "emit", min: 0, max: 1, step: 0.02, def: 0.30, group: "source", fmt: v => v.toFixed(2) },
  { key: "radius", label: "radius", min: 0.02, max: 0.3, step: 0.01, def: 0.08, group: "source", fmt: v => v.toFixed(2) },
  { key: "force", label: "force", min: 0, max: 60, step: 1, def: 20, group: "source" },
  { key: "angle", label: "angle", min: 0, max: 360, step: 5, def: 270, group: "source", fmt: v => `${v|0}°` },
  { key: "rot_speed", label: "rot speed", min: -180, max: 180, step: 5, def: 0, group: "source", fmt: v => `${v|0}°/s` },
  { key: "rot_accel", label: "rot accel", min: -90, max: 90, step: 5, def: 0, group: "source", fmt: v => `${v|0}°/s²` },
  { key: "intensity", label: "intensity", min: 0, max: 3, step: 0.1, def: 1.0, group: "color", fmt: v => v.toFixed(1) },
  { key: "opacity", label: "opacity", min: 0, max: 1, step: 0.05, def: 1.0, group: "color", fmt: v => v.toFixed(2) },
  { key: "dissipation", label: "dissip.", min: 0.85, max: 0.995, step: 0.005, def: 0.95, group: "medium", fmt: v => v.toFixed(3) },
  { key: "velocity_dissipation", label: "vel diss.", min: 0.85, max: 0.995, step: 0.005, def: 0.97, group: "medium", fmt: v => v.toFixed(3) },
  { key: "viscosity", label: "viscosity", min: 0, max: 0.5, step: 0.02, def: 0.0, group: "medium", fmt: v => v.toFixed(2) },
  { key: "vorticity", label: "vorticity", min: 0, max: 10, step: 0.5, def: 6.0, group: "medium", fmt: v => v.toFixed(1) },
];
export const FLUID_PARAM_KEYS = FLUID_PARAMS.map(p => p.key);
export const fluidParam = k => FLUID_PARAMS.find(p => p.key === k);
```

### `graphModel.js`

```js
import { FLUID_PARAMS } from "./fluidParams.js";

const rid = (p) => `${p}-${(crypto.randomUUID?.() || Date.now().toString(36)).slice(0,8)}`;

export const mkNodeId = () => rid("n");
export const mkEdgeId = () => rid("e");

export function signalNode(signal, x, y) {
  return { id: mkNodeId(), type: "signal", x, y,
           data: { signalId: signal.id, label: signal.name } };
}
export function constantNode(x, y, value = 0.5) {
  return { id: mkNodeId(), type: "constant", x, y, data: { value, label: "const" } };
}
export function outputNode(x, y) {
  return { id: mkNodeId(), type: "output", x, y, data: { title: "preview" } };
}
export function fluidNode(x, y) {
  const ports = {};
  for (const p of FLUID_PARAMS) ports[p.key] = { binding: { kind: "const", value: p.def } };
  return { id: mkNodeId(), type: "fluid", x, y, data: {
    static: { duration: 8, grid: 96, fps: 24, color: [0.27,0.69,1], intensity: 1, opacity: 1,
              enabled: true, radial: false, points: [[0.5,0.5]], path_speed: 1,
              path_closed: false, path_pingpong: false },
    ports } };
}

export function emptyGraph() {
  return { version: 1, nodes: [], edges: [], view: { tx: 0, ty: 0, scale: 1 } };
}

// Wire a value-source node into a fluid param: writes BOTH the binding and the edge
// (keeps the §3.3 invariant). lo/hi default to the param range.
export function connect(graph, sourceId, fluidId, paramKey) {
  const p = FLUID_PARAMS.find(p => p.key === paramKey);
  const fluid = graph.nodes.find(n => n.id === fluidId);
  fluid.data.ports[paramKey].binding = { kind: "node", nodeId: sourceId, lo: p.min, hi: p.max };
  const edges = graph.edges.filter(e => !(e.target === fluidId && e.targetPort === paramKey));
  edges.push({ id: mkEdgeId(), source: sourceId, sourcePort: "out", target: fluidId, targetPort: paramKey });
  return { ...graph, edges };
}

export function disconnect(graph, fluidId, paramKey) {
  const p = FLUID_PARAMS.find(p => p.key === paramKey);
  const fluid = graph.nodes.find(n => n.id === fluidId);
  fluid.data.ports[paramKey].binding = { kind: "const", value: p.def };
  return { ...graph, edges: graph.edges.filter(e => !(e.target === fluidId && e.targetPort === paramKey)) };
}

export function removeNode(graph, nodeId) { /* drop node + its edges + reset any ports bound to it */ }
export function setPortRange(graph, fluidId, paramKey, lo, hi) { /* patch binding.lo/hi */ }

export function validate(graph) {
  // mirror 01 §3.7; return { ok: boolean, error?: string }
}

// 01 §3.6: stable hash over nodes(type,data minus view), edges, and bounds.
export function graphHash(graph, jobId, start, end) { /* sha-ish stable string */ }
```

> Use a small stable stringifier (sorted keys, exclude `x/y/view`) for `graphHash`.
> A tiny FNV-1a or `JSON.stringify` of a canonicalized object is enough for a cache
> key; it only needs to match *itself* between renders, not the backend (the backend
> computes the authoritative filename hash). Frontend hash is an optional
> short-circuit to avoid re-POSTing an unchanged graph.

### `segments.js` persistence

Extend the serialize/hydrate (currently `serializeSegments` / `hydrateSegments` at
`segments.js:194–215`) to carry `graph`, and **preserve signal ids on hydrate**
(Issue 2A) so graph `signalId` references survive a reload:

```js
// serialize: carry graph (a plain JSON object) untouched, null if absent
{ id, start, end, label, signals: serializeSignals(s.signals), graph: s.graph || null }

// hydrate: keep stored graph as-is. Graph node ids stay stable too (each segment
// owns its own graph, so they never collide across segments).
graph: s.graph || null
```

**The core fix — stop regenerating signal ids on load.** `hydrateSignals`
(`segments.js:89–101`) currently does `id: mkSigId()` for every signal. Change it
to keep the stored id, regenerating only when missing or (defensively) duplicated.
Safe because ids are UUIDs:

```js
function hydrateSignals(stored) {
  const seen = new Set();
  return (stored || []).map((s) => {
    let id = s.id;
    if (!id || seen.has(id)) id = mkSigId();   // keep stored id; only mint when absent/dup
    seen.add(id);
    return {
      id,
      name: s.name || "signal",
      stemKey: s.stemKey || "original",
      minHz: s.minHz ?? 20,
      maxHz: s.maxHz ?? 20000,
      ...SIGNAL_DEFAULTS,
      ...Object.fromEntries(
        Object.keys(SIGNAL_DEFAULTS).map((k) => [k, s[k] ?? SIGNAL_DEFAULTS[k]])
      ),
    };
  });
}
```

> Fresh proposals / default signals still get minted ids at creation (`seedSignal`,
> `defaultSignals`), so new signals are unaffected — only *stored* ids are now
> preserved.

**Structural edits must keep graph references intact** (`01` §3.8). Update the
clone helper to return an id-map, add a graph remapper, and use them in
`splitAt`/`mergeWithPrev`:

```js
// cloneSignals now also reports old->new id mapping
function cloneSignals(signals) {
  const idMap = {};
  const out = (signals || []).map((s) => {
    const id = mkSigId(); idMap[s.id] = id; return { ...s, id };
  });
  return { signals: out, idMap };
}

// rewrite a graph's signal-node references through an id map; deep-copy so halves
// don't share one object. Unknown ids pass through (will read as "missing" later).
function remapGraphSignals(graph, idMap) {
  if (!graph) return null;
  const g = structuredClone(graph);
  for (const n of g.nodes) {
    if (n.type === "signal" && idMap[n.data.signalId]) n.data.signalId = idMap[n.data.signalId];
  }
  return g;
}

export function splitAt(segments, t) {
  const out = [];
  for (const s of segments) {
    if (t > s.start + 0.5 && t < s.end - 0.5) {
      out.push({ ...s, end: t, graph: s.graph ? structuredClone(s.graph) : null });  // distinct object
      const { signals, idMap } = cloneSignals(s.signals);
      out.push({ ...s, id: mkSegId(), start: t, signals,
                 graph: remapGraphSignals(s.graph, idMap) });
    } else out.push(s);
  }
  return out;
}
```

`mergeWithPrev` keeps the earlier segment's graph (its signals are unchanged, so
its references stay valid) and lets the later segment's graph fall away with the
spliced-out segment — its current `{ ...out[i-1], end: out[i].end }` already does
exactly this, so **no change needed** beyond a comment noting the defined behavior.

### `api.js`

```js
export function renderGraph({ job_id, segment, graph }) {
  return jsonOrThrow(fetch("/animate", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ job_id, segment, graph }),
  }));
}
```
Follow the existing `runFluid` pattern (`api.js`), reusing `jsonOrThrow`.

## Reuse

- `rid`/id pattern, serialize/hydrate scaffolding — `segments.js`.
- `jsonOrThrow`, fetch conventions — `api.js`.
- Param ranges — kept identical to backend `animation_params.PARAMS` (`03`).

## Acceptance criteria

- [ ] Factories produce `01`-conformant nodes; a fresh `fluidNode` has a `const`
      binding per modulatable param.
- [ ] `connect`/`disconnect` keep the binding↔edge invariant; `removeNode` cleans
      up edges and resets dependent ports.
- [ ] `validate` matches `01` §3.7; `graphHash` is stable under node moves.
- [ ] `serializeSegments(hydrateSegments(x)).graph` round-trips; signal-node
      `signalId` still resolves after hydrate (per the chosen id strategy).
- [ ] `FLUID_PARAM_KEYS` equals the backend `PARAMS` keys (asserted in `09`).

## Verification (two-audience)

**Fixture/seed data:** reuse `fixtures/graph-*.json` from `01` as expected shapes.

**Agent check** — vitest (lands fully in `09`, but write the first cases here):
```bash
cd frontend && npm run test -- graphModel
```
Cases: factory shapes; `connect` then `disconnect` returns to a `const` binding +
no edge; `validate` rejects a dangling node and a missing output; `graphHash`
unchanged after mutating only `x/y`; serialize→hydrate round-trip equals input.

**User check:** none yet (pure lib). Confidence comes from the green vitest run;
`cd frontend && npm run build` stays green.

## Risks & open questions

- **Signal id stability vs. graph references** — RESOLVED (Issue 2A): hydrate
  preserves stored ids; `splitAt` remaps the cloned half's graph; `mergeWithPrev`
  keeps the earlier graph. Still the trickiest correctness point of the frontend
  chain — call it out in the PR and lock it with the round-trip + split tests (`09`).
- **`structuredClone` availability** — standard in the app's browser target; if a
  test env lacks it, fall back to `JSON.parse(JSON.stringify(...))` (graphs are pure
  JSON).
- **Frontend vs backend hash** — intentionally independent; frontend hash only
  gates redundant POSTs. Don't couple them.
