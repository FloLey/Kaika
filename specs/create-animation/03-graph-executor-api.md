# 03 — Backend: graph executor + `/animate` route

> Turn a per-segment graph (`01`) into a rendered, cached, looping mp4 by resolving
> value sources, mapping them through `[lo,hi]`, building the `params` dict, and
> calling the time-varying `simulate()` (`02`). Exposed at `POST /animate`. This
> closes **Milestone M1**: the whole feature is exercisable with `curl` + a
> hand-written graph, no frontend.

## Goal

`POST /animate { job_id, segment, graph }` → `{ url }` of a looping mp4 where each
fluid parameter is a constant or a signal-driven per-frame array. Cached by graph
hash so identical requests are instant.

## Why / context

This is the heart of the feature on the backend. It reuses `signals.extract`
(`backend/signals.py`) for signal nodes and `fluid.simulate`/`render_mp4`
(`backend/fluid.py`, time-varying after `02`). It must resolve nodes **generically**
(by id, memoized) so future `combine` nodes drop in without reshaping the executor.

## Files

- **Create** `backend/graph.py` — the executor.
- **Create** `backend/animation_params.py` — the fluid param spec (the `01` table)
  + the `source.*` / `fluid.*` nesting map. (Or place the spec as a const in
  `graph.py`; a separate module keeps it importable by tests.)
- **Modify** `backend/app.py` — add the `/animate` route + serving (reuse the
  existing `/fluid/<name>` static serving, since output is also under `data/fluid/`
  or a new `data/animations/` dir).

## Design detail

### Param spec module

```python
# backend/animation_params.py
# key -> (nested_group, min, max, default)   nested_group in {"source","fluid"}
PARAMS = {
  "emit": ("source", 0.0, 1.0, 0.30),
  "radius": ("source", 0.02, 0.3, 0.08),
  "force": ("source", 0.0, 60.0, 20.0),
  "angle": ("source", 0.0, 360.0, 270.0),
  "rot_speed": ("source", -180.0, 180.0, 0.0),
  "rot_accel": ("source", -90.0, 90.0, 0.0),
  "intensity": ("source", 0.0, 3.0, 1.0),
  "opacity": ("source", 0.0, 1.0, 1.0),
  "dissipation": ("fluid", 0.85, 0.995, 0.95),
  "velocity_dissipation": ("fluid", 0.85, 0.995, 0.97),
  "viscosity": ("fluid", 0.0, 0.5, 0.0),
  "vorticity": ("fluid", 0.0, 10.0, 6.0),
}
```

### Executor

```python
# backend/graph.py
from . import signals, fluid
from .animation_params import PARAMS

FLUID_FPS = 24

def render(job_id: str, segment: dict, graph: dict, stem_audio_path) -> str:
    """Resolve `graph` for `segment`, render an mp4, return its public URL.
    `stem_audio_path(job_id, stem)` is injected from app.py (its existing helper)."""
    validate(graph)                                  # raise ValueError on bad graph
    out_path = ANIM_DIR / f"{graph_hash(job_id, segment, graph)}.mp4"
    url = f"/fluid/{out_path.name}"                  # served by existing route
    if out_path.exists():
        return url

    nodes = {n["id"]: n for n in graph["nodes"]}
    fluid_node = _one(nodes, "fluid")
    start, end = float(segment["start"]), float(segment["end"])
    signals_by_id = {s["id"]: s for s in segment.get("signals", [])}   # posted defs (Issue 1A)
    static = fluid_node["data"].get("static", {})
    duration = float(static.get("duration", max(0.5, end - start)))
    nframes = max(1, round(duration * FLUID_FPS))

    # memoized node resolution -> 0..1 curve of length nframes
    cache = {}
    def resolve_source(node_id):
        if node_id in cache: return cache[node_id]
        node = nodes[node_id]
        if node["type"] == "constant":
            v = float(node["data"].get("value", 0.0))
            out = np.full(nframes, v, np.float32)
        elif node["type"] == "signal":
            out = _signal_curve(node, job_id, start, end, nframes, signals_by_id, stem_audio_path)
        # elif node["type"] == "combine":   # <- future: resolve inputs, mix
        else:
            out = np.zeros(nframes, np.float32)
        cache[node_id] = out
        return out

    # build params: each port -> scalar or per-frame array in NATIVE units
    src_params, fluid_params = dict(static_source_part(static)), {}
    for key, (group, pmin, pmax, pdef) in PARAMS.items():
        binding = fluid_node["data"].get("ports", {}).get(key, {}).get("binding")
        target = src_params if group == "source" else fluid_params
        if not binding or binding["kind"] == "const":
            target[key] = float(binding["value"]) if binding else pdef
        else:  # kind == "node"
            lo = float(binding.get("lo", pmin)); hi = float(binding.get("hi", pmax))
            curve = resolve_source(binding["nodeId"])           # 0..1, len nframes
            target[key] = (lo + (hi - lo) * curve).tolist()     # native-unit array

    params = {"duration": duration, "fps": FLUID_FPS, "grid": int(static.get("grid",96)),
              "source": {**source_statics(static), **src_params},
              "fluid": fluid_params}
    frames, fps, n = fluid.simulate(params)
    fluid.render_mp4(frames, fps, out_path)
    return url
```

`_signal_curve` reuses `extract` at the fluid fps so no resample is needed:

```python
def _signal_curve(node, job_id, start, end, nframes, signals_by_id, stem_audio_path):
    sig = signals_by_id.get(node["data"]["signalId"])   # posted segment.signals, indexed by id
    if sig is None:
        return np.zeros(nframes, np.float32)     # deleted/missing signal -> flat 0 (validation §3.7)
    stem_path = stem_audio_path(job_id, sig["stemKey"])
    d = signals.extract(stem_path, start, end, sig["minHz"], sig["maxHz"],
                        feature=sig["feature"], fps=FLUID_FPS,
                        attack=sig["attack"], release=sig["release"],
                        invert=sig["invert"], gamma=sig["gamma"], gain=sig["gain"],
                        offset=sig["offset"], threshold=sig["threshold"])
    curve = np.asarray(d["curve"], np.float32)
    return fluid._series(curve, nframes)         # exact length
```

> **Resolving a signal's params — DECIDED (Issue 1 = send signals in the request).**
> The graph stores only `signalId`; the full definition (`stemKey/minHz/.../
> threshold`) travels in the request as `segment.signals`. The executor builds
> `signals_by_id = {s["id"]: s for s in segment["signals"]}` and looks up there —
> **no DB access at all**. This keeps the executor self-contained and makes a render
> reflect live (even unsaved) signal edits. Because these defs are render inputs,
> they are part of the cache hash (see "Hashing & validation" below and `01` §3.6).
> `render(...)` therefore takes the posted `segment` (with `signals`) and threads
> `signals_by_id` into `_signal_curve`.

### Route

```python
# backend/app.py
@app.post("/animate")
def animate():
    body = request.get_json(force=True)
    job_id = body["job_id"]; graph = body["graph"]
    # segment carries start/end AND the live signal defs (Issue 1A): no DB read.
    segment = body["segment"]            # { start, end, signals: [...] }
    try:
        url = graphmod.render(job_id, segment, graph, stem_audio_path)
    except ValueError as e:
        return {"error": str(e)}, 400
    return {"url": url}
```

- **Sync** like `/fluid` (renders in ~1–2 s at grid 96; signal extraction is
  cached by `signals.py` LRU). If a heavy graph ever blocks, moving to the job
  manager (`backend/jobs.py`) is a follow-up — out of scope for v1.
- **Output dir + serving:** write to `DATA_DIR/"fluid"` (reuse the existing
  `/fluid/<name>` GET route + Range support) so no new serving code is needed.
  Name the file `<graph_hash>.mp4`.

### Hashing & validation

Implement `graph_hash(job_id, segment, graph)` and `validate(graph)` per `01` §3.6
/ §3.7. Reuse the SHA-1 pattern from `fluid.params_hash`.

`graph_hash` **must include the defining fields of every referenced signal** (Issue
1A): for each `signal` node, pull its def from `signals_by_id` and fold
`(stemKey, minHz, maxHz, feature, attack, release, invert, gamma, gain, offset,
threshold)` into the hashed payload. Without this, editing a referenced signal's
band/shaping and re-rendering would return the stale cached mp4.

`validate` raises `ValueError` with a human message (surfaced as HTTP 400) on:
no/many output nodes, no/many fluid nodes, dangling `nodeId`, or a cycle.

## Reuse

- `signals.extract` — `backend/signals.py` (and its internal STFT/HPSS/beat LRU
  caches make repeated renders cheap).
- `fluid.simulate` (time-varying after `02`), `fluid.render_mp4`,
  `fluid._series`, `fluid.params_hash` pattern — `backend/fluid.py`.
- `stem_audio_path`, `DATA_DIR`, the `/fluid/<name>` serving route — `backend/app.py`.

## Acceptance criteria

- [ ] `POST /animate` with `graph-min.json` returns `{url}` to a playable looping
      mp4 (all-constant fluid).
- [ ] `POST /animate` with `graph-modulated.json` returns a clip whose `force`
      visibly pulses with the chosen drum signal.
- [ ] Identical re-POST returns instantly (file already exists; same hash).
- [ ] Bad graph (no output / dangling node) → HTTP 400 with a clear message.
- [ ] Deleting a referenced signal degrades to flat 0, not a 500.

## Verification (two-audience)

**Fixture/seed data:** `fixtures/graph-min.json`, `fixtures/graph-modulated.json`
(from `01`) edited to embed a real `job_id`, segment `start/end`, and the segment's
`signals` (Issue 1A — they ride in the request). Get them from `GET /projects` +
`GET /projects/<id>`.

**Agent check:**
```bash
curl -s localhost:5000/animate -H 'content-type: application/json' \
  --data @specs/create-animation/fixtures/graph-modulated.json | tee /tmp/anim.json
# -> {"url":"/fluid/<hash>.mp4"}
curl -s -o /tmp/anim.mp4 "localhost:5000$(jq -r .url /tmp/anim.json)"
ffprobe /tmp/anim.mp4   # shows a valid h264 512x512 clip
# re-run the same curl: second call returns the same url instantly (cache hit)
```
Also a `pytest` (in `09`) that calls `graphmod.render` directly with a fixture and
asserts the output file exists and the param arrays have length `nframes`.

**User check:** run the two `curl`s above, then `open /tmp/anim.mp4`. The modulated
clip's jet should pulse in time with the drum signal; the min clip should be a
steady plume. Change `lo/hi` in the fixture and re-render to see the range affect
the motion.

## Risks & open questions

- **Signal defs source** — DECIDED: client posts `segment.signals` (Issue 1A);
  executor is DB-free and renders reflect unsaved edits. Trade accepted: referenced
  signal defs must be in the cache hash (handled above).
- **Cache dir growth** — animations accumulate under `data/fluid/`; a cleanup
  utility is a later nicety (mention in `09`).
- **DAG generality** — keep `resolve_source` memoized + type-dispatched so a
  `combine` node is a 5-line addition, not a refactor.
