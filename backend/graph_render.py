"""The graph executor: `build_params`, the `Dag` resolver, the per-node-type
handler registries (whole-clip + block streaming), and the two public render
entry points (`render`, `render_stream`).

See graph.py (the thin public facade) for the package overview. Directory paths
(`paths.ANIM_DIR` / `paths.STREAM_DIR` / `paths.ASSETS_DIR`) are read late-bound
so tests patch ONE place: `backend.paths`.
"""

from __future__ import annotations

import logging
import os
import shutil
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

import numpy as np
from scipy.ndimage import map_coordinates

from . import fluid, fluid_cache, look_fx, paths, procgen, render_cache, sources
from .animation_params import PARAMS
from .graph_common import (
    _PORT_SPECS,
    FLUID_FPS,
    LEGACY_GRID,
    LOOSE_PORT,
    VIDEO_PRODUCERS,
    _POINT_CAP,
    _field_nodes,
    _fluid_for_output,
    _nodes_of,
    _output_params,
    _video_source,
    composite,
    resolve_port,
)
from .graph_hash import output_hash
from .graph_modulators import (
    _animate_point_specs,
    _gate_curve,
    _make_value_resolver,
    _pattern_points,
    _resolve_node_color,
    _source_statics,
    _static_point_spec,
)
from .graph_validate import validate

log = logging.getLogger("kaika.graph")

# Streaming renders emit the clip in front-to-back blocks of this many seconds, so a
# long segment previews in ~one block's time instead of after the whole render. The
# blocks concatenate losslessly into the same final mp4 the sync path produces.
RENDER_BLOCK_SECONDS = float(os.environ.get("RENDER_BLOCK_SECONDS", "5"))

# A merge combine has no fluid card, so its medium params fall back to the canonical
# `fluid`-group defaults (the single source of truth in animation_params.PARAMS).
_MERGE_MEDIUM_DEFAULTS = tuple(
    (k, default) for k, (group, _lo, _hi, default) in PARAMS.items() if group == "fluid"
)


def build_params(
    job_id: str,
    segment: dict,
    graph: dict,
    stem_audio_path: Callable,
    output: dict | None = None,
    output_id: str | None = None,
    fluid_node: dict | None = None,
) -> dict:
    """Resolve `graph` into a `simulate()` params dict (no render).

    Split out from `render` so tests can assert the per-frame arrays without
    encoding an mp4. Each modulatable port becomes a scalar (const binding) or a
    length-nframes native-unit array (node binding mapped lo + (hi-lo)*curve).

    `output_id` selects which output's fluid to build (N pipelines per graph);
    when omitted, the sole fluid is used (back-compat).
    `output` carries the project render settings (size/quality/fps/background);
    when present it drives the grid + fps (the legacy square `grid` is dropped).
    """
    output = output or {}
    nodes = {n["id"]: n for n in graph["nodes"]}
    if fluid_node is None:
        fluid_node = (
            _fluid_for_output(graph, output_id) if output_id else _nodes_of(graph, "fluid")[0]
        )
    start, end = float(segment["start"]), float(segment["end"])
    signals_by_id = {s["id"]: s for s in segment.get("signals", []) if "id" in s}
    static = fluid_node["data"].get("static", {})
    # The clip is ALWAYS the full segment — duration is not a graph/card setting.
    duration = max(0.5, end - start)
    fps = int(output.get("fps", FLUID_FPS))
    # Per-frame arrays must match simulate()'s frame count, which uses this fps.
    nframes = max(1, round(duration * fps))

    # Memoized, type-dispatched node resolution -> 0..1 curve, length nframes.
    resolve_source = _make_value_resolver(
        graph, nodes, job_id, start, end, nframes, fps, signals_by_id, stem_audio_path
    )

    ports = fluid_node["data"].get("ports", {})
    src_params: dict = {}
    fluid_params: dict = {}
    for key, (group, pmin, pmax, pdef) in PARAMS.items():
        target = src_params if group == "source" else fluid_params
        binding = (ports.get(key) or {}).get("binding")
        v = resolve_port(binding, pmin, pmax, pdef, resolve_source)
        target[key] = v.tolist() if hasattr(v, "tolist") else v  # native-unit array/scalar

    # Dye colour comes from a `color` card wired into the fluid's `color` input (or the
    # static fallback when unwired). Overrides the static `color` vector under source.
    src_params.update(_resolve_node_color(graph, fluid_node, "color", nodes, resolve_source))

    params = {
        "duration": duration,
        "fps": fps,
        "source": {**_source_statics(static), **src_params},
        "fluid": fluid_params,
    }
    if output:
        params["output"] = _output_params(output, fps)
    else:
        params["grid"] = int(static.get("grid", LEGACY_GRID))  # legacy square fallback
    return params


# --------------------------------------------------------------------------- #
# Render
# --------------------------------------------------------------------------- #
def _render_target(graph: dict, nodes: dict, output_id: str) -> str:
    """The producer node a render of `output_id` should resolve. An OUTPUT node
    renders the video wired into it (no input -> the classic ValueError, an HTTP
    400); any other id is a producer previewed directly (fluid / combine — the
    per-node card preview). ONE helper shared by the sync `render()` path and
    `stream_blocks` so the two contracts can never drift (lockstep invariant)."""
    node = nodes.get(output_id)
    if node is not None and node.get("type") == "output":
        target = _video_source(graph, output_id, "video")
        if target is None:
            raise ValueError(f"output '{output_id}' has no input")
        return target
    return output_id  # a producer node previewed directly


def _clip_dims(segment: dict, output: dict | None) -> tuple[float, int]:
    """(duration, fps) of a segment's clip — the ONE place the 0.5 s floor lives.

    Shared by `Dag.__init__` and `render_stream`'s cache-hit path, which needs the frame
    total to report progress but has nothing to resolve (the clip is already on disk)."""
    start, end = float(segment["start"]), float(segment["end"])
    return max(0.5, end - start), int((output or {}).get("fps", FLUID_FPS))


class Dag:
    """Resolves the video DAG feeding an output (spec 10).

    Two memoized resolvers walk the producers (fluid / combine / output-passthrough)
    upstream of an output, each dispatching on node `type`:

      video(id)    -> dye-on-transparent frames for ANY producer. fluid: run the
                      sim; output: pass its input through; combine: composite the
                      stacked layers (mode="stack") or sim the merged emitters.
      emitters(id) -> the flat emitter list a MERGE feeds into one shared sim.
                      fluid: its source(s); output: its input's emitters; combine:
                      the concatenated inputs (a layered/stack combine has no single
                      emitter set, so it can't feed a merge — raises).

    Per-render memo dicts (`_video`/`_emit`/`_params`) keep each node's resolution
    to once. The terminal (`render`) flattens `video` onto black — there is no project
    background; a backdrop is the bottom layer of a stack combine."""

    def __init__(self, job_id, segment, graph, stem_audio_path, output):
        self.job_id = job_id
        self.segment = segment
        self.graph = graph
        self.stem_audio_path = stem_audio_path
        self.output = output or {}
        self.nodes = {n["id"]: n for n in graph.get("nodes", []) if "id" in n}
        self.duration, self.fps = _clip_dims(segment, self.output)
        self._video: dict = {}
        self._emit: dict = {}
        self._params: dict = {}
        self._resolver = None  # lazily-built shared value resolver (one per render)
        self._block_fns: dict = {}  # node_id -> produce(a, b) (block streaming)
        self._executors: list = []  # per-combine branch pools, released by close()
        self._cache_writers: list = []  # discard() for incremental frame caches (cancel cleanup)
        self._closers: list = []  # persistent per-node resources (e.g. VideoClip decoders)

    # ---- resource lifetime ---------------------------------------------------
    # A DAG opens three kinds of thing: branch thread pools, incremental frame-cache
    # writers, and persistent ffmpeg decoders (slideshow / video / stylize register
    # `clip.close` on `_closers`). This drain used to live ONLY inside `stream_blocks`'
    # finally, so every other entry point — `render()`, `song_render`, the points and
    # stylize resolvers — leaked a decoder per video card, per call.
    #
    # `test_card_impact`'s whole-vs-streamed parity test could never catch it: it builds
    # a fresh `Dag` per call and goes through `.video()` / `.stream_blocks()` directly,
    # never through `render()`. So the leak was invisible to the one test that looks at
    # both paths at once.

    def close(self) -> None:
        """Release everything this DAG opened. Idempotent, and safe to call mid-render.

        Each item is drained independently: a decoder that raises on close must not
        strand the ones after it, and must not mask an exception already propagating
        (this runs from `finally` blocks).
        """
        for ex in self._executors:
            try:
                ex.shutdown(wait=False)
            except Exception as e:  # noqa: BLE001 — cleanup must not raise
                log.warning("dag close: executor shutdown failed (%s)", e)
        self._executors.clear()
        for discard in self._cache_writers:  # drop partial caches (no-op if committed)
            try:
                discard()
            except Exception as e:  # noqa: BLE001
                log.warning("dag close: discarding a partial frame cache failed (%s)", e)
        self._cache_writers.clear()
        for closer in self._closers:  # reap persistent decoders (also on cancel)
            try:
                closer()
            except Exception as e:  # noqa: BLE001
                log.warning("dag close: closing a decoder failed (%s)", e)
        self._closers.clear()

    def __enter__(self) -> "Dag":
        return self

    def __exit__(self, *exc) -> bool:
        self.close()
        return False  # never swallow the render's own exception

    def _fluid_params(self, fluid_node):
        # Memoized per fluid: a fluid with drawn points resolves params through both
        # the video path and the emitter path, and each build_params re-extracts the
        # node's signal curves — cache so the (expensive) resolution runs once.
        fid = fluid_node["id"]
        if fid not in self._params:
            self._params[fid] = build_params(
                self.job_id,
                self.segment,
                self.graph,
                self.stem_audio_path,
                self.output,
                fluid_node=fluid_node,
            )
        return self._params[fid]

    def _resolve_points(self, node_id, seen=None) -> list:
        """A points node -> a list of emitter source SPECS (each carries `points` + path
        fields). Dispatches on type and recurses through the points transforms
        (animate); a (validate-rejected) cycle degrades to []."""
        seen = seen if seen is not None else set()
        if node_id in seen:
            return []
        seen.add(node_id)
        node = self.nodes.get(node_id)
        if node is None:
            return []
        t = node.get("type")
        data = node.get("data", {})
        if t == "points":
            return [_static_point_spec(p) for p in (data.get("points") or [])]
        if t == "pattern":
            return [_static_point_spec(p) for p in _pattern_points(data)]
        if t == "animate-points":
            src = _video_source(self.graph, node_id, "in")
            return _animate_point_specs(self._resolve_points(src, seen) if src else [], data)
        if t == "merge-points":
            # Concatenate every wired input's point specs into one set (capped).
            merged: list = []
            for pid in data.get("inputs") or []:
                src = _video_source(self.graph, node_id, pid)
                if src:
                    merged.extend(self._resolve_points(src, seen))
            return merged[:_POINT_CAP]
        return []

    def _points_for(self, fluid_node):
        """The point SPECS wired into `fluid.positions` (any points-flow card), or None
        when nothing is wired — then the fluid keeps its single source (spec 11)."""
        pid = _video_source(self.graph, fluid_node["id"], "positions")
        specs = self._resolve_points(pid) if pid else []
        return specs or None

    def _fluid_emitters(self, fluid_node) -> list:
        """A fluid's emitter list: ONE source per resolved point (sharing the fluid's
        params; a spec overrides position + path), or the single source when none."""
        base = self._fluid_params(fluid_node)["source"]
        specs = self._points_for(fluid_node)
        if not specs:
            return [base]
        return [{**base, **spec} for spec in specs]

    def _fluid_video_params(self, fluid_node) -> dict:
        """simulate() params for one fluid — `sources` when points are wired, else
        the single `source` (byte-identical to the prior single-source path)."""
        params = self._fluid_params(fluid_node)
        if self._points_for(fluid_node):
            params = {**params, "sources": self._fluid_emitters(fluid_node)}
            params.pop("source", None)
        return params

    def _value_resolver(self):
        """The per-render memoized value resolver (node_id -> 0..1 curve). Built once
        and shared by every ported card (fluid params memoize separately), so a signal
        feeding two cards resolves its follower/shaper/math chain once."""
        if self._resolver is None:
            seg = self.segment
            nframes = max(1, round(self.duration * self.fps))
            signals_by_id = {s["id"]: s for s in seg.get("signals", []) if "id" in s}
            self._resolver = _make_value_resolver(
                self.graph,
                self.nodes,
                self.job_id,
                float(seg["start"]),
                float(seg["end"]),
                nframes,
                self.fps,
                signals_by_id,
                self.stem_audio_path,
            )
        return self._resolver

    def _fx_params(self, node, resolve=None) -> dict:
        """A non-fluid ported card's modulatable ports (FX or source) -> {key:
        length-nframes native array}. Reuses the shared value resolver, so a port wired
        to a signal/LFO/math resolves exactly like a fluid param does."""
        nframes = max(1, round(self.duration * self.fps))
        resolve = resolve or self._value_resolver()
        out = {}
        for key, (pmin, pmax, pdef) in _PORT_SPECS[node["type"]].items():
            b = (node.get("data", {}).get("ports", {}).get(key) or {}).get("binding")
            v = resolve_port(b, pmin, pmax, pdef, resolve)
            # FX/source handlers index per frame, so a const becomes a flat array too.
            out[key] = np.full(nframes, v, np.float32) if np.isscalar(v) else v.astype(np.float32)
        return out

    def _lyrics_params(self, node) -> dict:
        """The lyrics card's per-frame arrays: size/opacity + fill r/g/b (+ outline
        r/g/b). Fill colour comes from a `color` card wired into `fillColor` (else the
        r/g/b ports); the outline colour from one wired into `outlineColor` (else black).
        The outline is always drawn fully opaque, so it keeps occluding the fluid
        regardless of its colour."""
        nframes = max(1, round(self.duration * self.fps))
        resolve = self._value_resolver()
        out = self._fx_params(node, resolve)  # opacity (the only modulatable port)
        # Fill colour: a wired `color` card, else white. (r/g/b are no longer ports.)
        fill = _resolve_node_color(self.graph, node, "fillColor", self.nodes, resolve)
        if fill:
            inten = fluid._series(fill["intensity"], nframes)
            for ch in ("r", "g", "b"):
                out[ch] = np.clip(fluid._series(fill[ch], nframes) * inten, 0.0, 1.0).astype(
                    np.float32
                )
        else:
            for ch in ("r", "g", "b"):
                out[ch] = np.ones(nframes, np.float32)
        outline = _resolve_node_color(self.graph, node, "outlineColor", self.nodes, resolve)
        oint = (
            fluid._series(outline["intensity"], nframes)
            if outline
            else np.ones(nframes, np.float32)
        )
        for ch in ("r", "g", "b"):
            # Apply the outline card's `intensity` too (fill does), so equally-configured
            # fill/outline colour cards render at the same brightness.
            v = (
                fluid._series(outline[ch], nframes) * oint
                if outline
                else np.zeros(nframes, np.float32)
            )
            out[f"outline_{ch}"] = np.clip(v, 0.0, 1.0).astype(np.float32)
        return out

    def _backdrop_params(self, node) -> dict:
        """The backdrop card's per-frame arrays: `opacity` (the only modulatable port) +
        fill r/g/b from the card's colour swatch (`data.color` hex). A full-frame opaque
        layer for the bottom of a stack combine."""
        nframes = max(1, round(self.duration * self.fps))
        out = self._fx_params(node)  # {opacity}
        r, g, b = fluid._hex_rgb(node.get("data", {}).get("color", "#101418"))
        out["r"] = np.full(nframes, float(r), np.float32)
        out["g"] = np.full(nframes, float(g), np.float32)
        out["b"] = np.full(nframes, float(b), np.float32)
        return out

    def _merge_params(self, emitters, medium):
        # A fire card's emitter list smuggles its field settings on the first
        # emitter (`_fire`): strip it into params["fire"] so the shared sim
        # runs in fire mode (the combine's medium still governs the flow).
        fire_cfg = None
        srcs = []
        for e in emitters:
            if "_fire" in e:
                e = dict(e)
                fire_cfg = fire_cfg or e.pop("_fire")
            srcs.append(e)
        params = {
            "duration": self.duration,
            "fps": self.fps,
            "sources": srcs,
            "fluid": {k: float(medium.get(k, d)) for k, d in _MERGE_MEDIUM_DEFAULTS},
        }
        if fire_cfg is not None:
            params["fire"] = fire_cfg
        if self.output:
            params["output"] = _output_params(self.output, self.fps)
        else:
            params["grid"] = LEGACY_GRID
        return params

    def field_layers(self, output_id: str) -> list[dict]:
        """The raw-simulation fields feeding `output_id`, for the continuous song export:
        `[{node_id, layer, params}]` in video-chain order. A field is a `fluid` node or a
        `combine(merge)` node (a fluid feeding a merge is absorbed by the merge, so we
        stop there); stack/fx/output are pass-through, lyrics is a generated layer (no
        field). `layer` is the node's `data.layer` (the cross-segment continuity key) or
        its 1-based discovery order; `params` are the `simulate()` params for that field
        over this segment's window (grid/fps from the export output)."""
        out = []
        for k, nid in enumerate(_field_nodes(self.graph, output_id)):
            node = self.nodes[nid]
            if node.get("type") == "fluid":
                params = self._fluid_video_params(node)
            else:  # combine(merge)
                emitters = self.emitters(nid)
                if any("_kind" in e for e in emitters):
                    # a generative-sim merge (waves/rain/...) is not a fluid
                    # field — it renders per segment through the video path
                    continue
                params = self._merge_params(emitters, node.get("data", {}).get("medium", {}))
            layer = int(node.get("data", {}).get("layer", k + 1))
            out.append({"node_id": nid, "layer": layer, "params": params})
        return out

    def emitters(self, node_id) -> list:
        """The flat emitter list a MERGE feeds into one shared sim. Dispatches on
        node type via `_EMITTER_HANDLERS`; memoized per render."""
        if node_id in self._emit:
            return self._emit[node_id]
        node = self.nodes[node_id]
        handler = _EMITTER_HANDLERS.get(node.get("type"))
        if handler is None:
            raise ValueError(f"node '{node_id}' has no emitter")
        out = handler(self, node)
        self._emit[node_id] = out
        return out

    def video(self, node_id) -> np.ndarray:
        """Dye-on-transparent frames for any producer. Dispatches on node type via
        `_VIDEO_HANDLERS`; memoized per render."""
        if node_id in self._video:
            return self._video[node_id]
        node = self.nodes[node_id]
        handler = _VIDEO_HANDLERS.get(node.get("type"))
        if handler is None:
            raise ValueError(f"node '{node_id}' is not a video producer")
        frames = handler(self, node)
        self._video[node_id] = frames
        return frames

    # ----------------------------------------------------------------------- #
    # Block streaming (progressive render): the same DAG, produced in contiguous
    # front-to-back frame blocks so a long clip previews in ~5s chunks. Mirrors
    # `video()` but every handler yields frames for a range [a, b) instead of the
    # whole clip; the only stateful producer (fluid/merge) carries its `FluidClip`
    # across blocks (block K+1's field IS block K's — it can't be parallelised in
    # time). Downstream ops (composite/fx/lyrics) are per-frame stateless, so they
    # just operate on the block + the sliced param arrays.
    def _block_producer(self, node_id):
        """A `produce(a, b) -> frames[a:b]` callable for a node, memoized so a
        producer shared by two consumers computes each block once. Callers must
        pull contiguous, increasing ranges (front-to-back)."""
        if node_id in self._block_fns:
            return self._block_fns[node_id]
        node = self.nodes[node_id]
        handler = _BLOCK_HANDLERS.get(node.get("type"))
        if handler is None:
            raise ValueError(f"node '{node_id}' is not a video producer")
        inner = handler(self, node)
        cache: dict = {"key": None, "val": None}  # last block, so re-pulls are free
        lock = threading.Lock()  # a diamond graph can pull one producer from 2 branches

        def produce(a, b):
            with lock:  # serialise concurrent pulls of the SAME producer (stateful sim)
                if cache["key"] != (a, b):
                    cache["key"] = (a, b)
                    cache["val"] = inner(a, b)
                return cache["val"]

        self._block_fns[node_id] = produce
        return produce

    def stream_blocks(self, output_id, block_frames):
        """Yield `(a, b, total, frames)` dye-on-transparent blocks for `output_id`.
        `total` is the clip's frame count. The terminal (`render_stream`) applies the
        background per block and streams it to the encoder. Owns the lifetime of the
        per-combine branch pools built while wiring the producers — shut down on exit.

        `output_id` may be an OUTPUT node (stream the video wired into it) OR any
        video-producing node directly (fluid / combine — for the per-node card preview)."""
        target = _render_target(self.graph, self.nodes, output_id)
        produce = self._block_producer(target)  # builds the producer chain (+ branch pools)
        total = max(1, round(self.duration * self.fps))
        block_frames = max(1, int(block_frames))
        try:
            a = 0
            while a < total:
                b = min(a + block_frames, total)
                yield a, b, total, produce(a, b)
                a = b
        finally:
            self.close()


def resolve_node_points(job_id, segment, graph, node_id, stem_audio_path) -> dict:
    """Resolve a points node's positions for a card preview -> ``{points: [[x,y],…]}``
    (each emitter's base position, 0..1). No render, no DB — mirrors
    `resolve_node_curve` for the value cards, so points/pattern/animate/merge can show
    a live scatter in the editor."""
    with Dag(job_id, segment, graph, stem_audio_path, {}) as dag:
        specs = dag._resolve_points(node_id)
    pts = [[float(s["points"][0][0]), float(s["points"][0][1])] for s in specs if s.get("points")]
    return {"points": pts}


def stylize_source(job_id, segment, graph, node_id, stem_audio_path, output=None) -> tuple:
    """Render the clips feeding a `stylize` node → (frames, strength, fps, control).
    `frames` = the `video` input (the img2img base), `control` = the `control` input's frames
    (an Extract card's edges/depth) or None. Reuses the whole render DAG — no duplicate pipeline."""
    with Dag(job_id, segment, graph, stem_audio_path, output or {}) as dag:
        src = _video_source(graph, node_id, "video")
        if src is None:
            raise ValueError("stylize node has no video input wired")

        def _clip(sid):
            c = dag.video(sid)
            if c.shape[-1] == 4:  # a layer -> flatten onto black to a 3-channel clip
                c = fluid.flatten(c)
            return np.ascontiguousarray(c)

        frames = _clip(src)
        ctrl_src = _video_source(graph, node_id, "control")
        control = _clip(ctrl_src) if ctrl_src is not None else None
        node = dag.nodes[node_id]
        strength = float(np.mean(dag._fx_params(node)["strength"]))
    return frames, strength, dag.fps, control


# --------------------------------------------------------------------------- #
# Node-type handler registry (spec 10)
# --------------------------------------------------------------------------- #
# One video handler (and, where it can feed a merge, one emitter handler) per node
# type. A handler is `(dag, node) -> frames | emitters` and may recurse through
# `dag.video` / `dag.emitters`. Adding a producing node type = write a handler +
# register it here; `_Dag.video`/`emitters` and `_VIDEO_PRODUCERS` pick it up.


# The stateful fluid sim is the expensive part of a render, so its raw output is
# cached by `fluid.params_hash` (see fluid_cache): a downstream-only edit (a stacked
# layer's opacity, a lyrics/FX tweak) leaves the fluid params — hence the key —
# unchanged, so we reuse the frames and only the cheap per-frame ops re-run. Both the
# whole-clip and block paths go through these so the cache is shared across renders.
def _fluid_cache_key(params: dict) -> str:
    """Cache key for a fluid node's raw dye-on-transparent frames (grid/fps/quality all
    matter; there is no background in the params any more)."""
    return fluid.params_hash(params)


def _sim_video(params: dict) -> np.ndarray:
    """Fluid frames for `params`, from the cache when hot else simulate + store.
    Always dye-on-transparent (apply_bg=False); the terminal flattens onto black."""
    key = _fluid_cache_key(params)
    cached = fluid_cache.load(key)
    if cached is not None:
        # Serve the read-only mmap as-is: every downstream op (composite/flatten/
        # encode) allocates its own output, so copying the whole clip (~50-100MB/min)
        # into RAM here just to make it writable was pure waste.
        return cached
    frames, _, _ = fluid.simulate(params, apply_bg=False)
    fluid_cache.store(key, frames)
    return frames


def _sim_blocks(dag: "_Dag", params: dict):
    """A `produce(a, b)` fluid block source backed by the frame cache: a hit slices
    the cached array (no sim); a miss runs a resumable FluidClip and streams the frames
    straight into the cache (memmap) as blocks are produced. Registers a `discard` on
    the dag so an abandoned (cancelled) render drops its partial cache file."""
    key = _fluid_cache_key(params)
    cached = fluid_cache.load(key)
    if cached is not None:
        return lambda a, b: cached[a:b]  # read-only mmap slice; downstream allocates
    clip = fluid.FluidClip(params, apply_bg=False)
    # Stream frames straight into the cache as they're produced (O(1) memory) instead
    # of holding the whole clip to write at the end; finalize on the last block.
    mm, finalize, discard = fluid_cache.frame_writer(key, (clip.nframes, clip.gh, clip.gw, 3))
    dag._cache_writers.append(discard)

    def produce(a, b):
        blk = clip.advance(a, b)
        if mm is not None:
            mm[a:b] = blk
            if b >= clip.nframes:  # last block done -> commit the cached clip
                finalize()
        return blk

    return produce


def _fluid_video(dag: "_Dag", node: dict) -> np.ndarray:
    return _sim_video(dag._fluid_video_params(node))


def _output_video(dag: "_Dag", node: dict) -> np.ndarray:
    src = _video_source(dag.graph, node["id"], "video")
    if src is None:
        raise ValueError(f"output '{node['id']}' has no input to pass through")
    return dag.video(src)


def _combine_video(dag: "_Dag", node: dict) -> np.ndarray:
    data = node.get("data", {})
    srcs = [(_video_source(dag.graph, node["id"], s.get("id")), s) for s in data.get("inputs", [])]
    srcs = [(s, slot) for (s, slot) in srcs if s is not None]
    if not srcs:
        raise ValueError(f"combine '{node['id']}' has no inputs")
    if data.get("mode") == "stack":
        layers = [dag.video(s) for (s, _) in srcs]
        opac = [float(slot.get("opacity", 1.0)) for (_, slot) in srcs]
        return composite(layers, opac)
    # merge: one shared physical field. Gen-sim cards dispatch to their shared-
    # field renderer (same-kind only); fluids + fires share one solver sim, each
    # emitter keeping its OWN `wrap` — see fluid.simulate().
    kind, layers, base_src = _gen_merge_split(dag, node)
    if kind is not None:
        gh, gw = _grid_dims(dag)
        n = max(1, round(dag.duration * dag.fps))
        base = _flatten_rgb(dag.video(base_src)) if base_src else None
        fn = getattr(sources, kind)
        if kind == "rain":
            frames, _ = fn(n, gh, gw, dag.fps, layers, base=base)
            return frames
        if kind == "waves":
            return fn(n, gh, gw, dag.fps, layers, base=base)
        return fn(n, gh, gw, dag.fps, layers)
    params = dag._merge_params(layers, data.get("medium", {}))
    return _sim_video(params)


def _fluid_emitters_h(dag: "_Dag", node: dict) -> list:
    return dag._fluid_emitters(node)


def _output_emitters_h(dag: "_Dag", node: dict) -> list:
    src = _video_source(dag.graph, node["id"], "video")
    return dag.emitters(src) if src else []


def _combine_emitters_h(dag: "_Dag", node: dict) -> list:
    if node.get("data", {}).get("mode") == "stack":
        raise ValueError("a layered (stack) combine can't feed a merge combine")
    out: list = []
    for slot in node.get("data", {}).get("inputs", []):
        src = _video_source(dag.graph, node["id"], slot.get("id"))
        if src:
            out.extend(dag.emitters(src))
    return out


# Node types whose frames are genuinely EXPENSIVE to produce (physics solvers /
# spectral sims / diffusion) — their presence anywhere in the graph keeps the render
# on the coarse simulation grid. Everything else (video/image/montage/lyrics/stack
# compositing/per-frame FX) is decode + numpy, cheap enough for the native grid.
_HEAVY_TYPES = {"fluid", "waves", "lightning", "fire", "aurora", "rain", "clouds", "stylize"}

# Cap on the native-resolution preview's SHORT side: a full 1080p block stream would
# hold ~1 GB of frames in flight per producer; 540p stays sharp (≈30× the draft
# pixel count) at a quarter of that.
#
# An `output["nativeShort"]` OVERRIDES this cap and, unlike the plain preview path,
# takes the native branch even when `gridCells` is set. That combination is exactly
# the single-segment HD render (`/export/segment`): it carries the export's
# `gridCells` for sim graphs, but a sim-FREE graph must render at the export's true
# native size — pinning it to a 216-cell sim grid would make "HD" LOOK WORSE than the
# 540p preview. The key is opt-in: no preview ever sends it (so no preview's
# `_grid_dims` or `output_hash` changes), and the whole-song export must never set it
# — `song_render` pushes every segment into ONE fixed-size encoder.
_NATIVE_SHORT = 540


def _graph_is_light(graph: dict) -> bool:
    """True when nothing in the graph needs a simulation grid: no heavy producer and
    no merge combine (a merge shares one physical sim). Whole-graph, not per-target —
    one render must use ONE frame size, and a mixed segment keeps the sim grid."""
    for n in graph.get("nodes", []):
        t = n.get("type")
        if t in _HEAVY_TYPES:
            return False
        if t == "combine" and (n.get("data") or {}).get("mode") != "stack":
            return False
    return True


def _grid_dims(dag: "_Dag"):
    """The (gh, gw) frame size for a synthesised source. Normally the project output's
    SIMULATION grid (quality preset → 64/96/144 short-side cells — sims are expensive);
    but a graph with nothing to simulate (pure video/image/montage layers) renders at
    the output's NATIVE resolution, capped at `nativeShort` or _NATIVE_SHORT, so clips
    stay sharp. An explicit `gridCells` (the HD song export) otherwise wins; no output
    settings falls back to the legacy square."""
    if not dag.output:
        return LEGACY_GRID, LEGACY_GRID
    native = dag.output.get("nativeShort")
    if (native or not dag.output.get("gridCells")) and _graph_is_light(dag.graph):
        w = max(2, int(dag.output.get("width", 1080)))
        h = max(2, int(dag.output.get("height", 1920)))
        cap = max(2, int(native or _NATIVE_SHORT))
        scale = min(1.0, cap / max(1, min(w, h)))
        # Even dims — the yuv420p encoders require them.
        return max(2, round(h * scale / 2) * 2), max(2, round(w * scale / 2) * 2)
    return fluid.grid_from_output(dag.output)


def _lyrics_static(d: dict) -> dict:
    """The lyrics card's static (non-modulatable) fields -> sources.lyrics kwargs."""
    return dict(
        align=d.get("align", "center"),
        case=d.get("case", "none"),
        reveal=d.get("reveal", "word"),
        font=d.get("font", "inter"),
        box_x=float(d.get("box_x", 0.05)),
        box_y=float(d.get("box_y", 0.08)),
        box_w=float(d.get("box_w", 0.9)),
        box_h=float(d.get("box_h", 0.84)),
        outline=bool(d.get("outline", True)),
        outline_width=float(d.get("outlineWidth", 0.12)),
    )


def _lyrics_video(dag: "_Dag", node: dict) -> np.ndarray:
    d = node.get("data", {})
    nframes = max(1, round(dag.duration * dag.fps))
    gh, gw = _grid_dims(dag)
    lines = dag.segment.get("lyric_lines") or []
    return sources.lyrics(
        nframes,
        gh,
        gw,
        dag.fps,
        lines=lines,
        seg_start=float(dag.segment.get("start", 0.0)),
        **_lyrics_static(d),
        **dag._lyrics_params(node),
    )


def _asset_path(dag: "_Dag", node: dict) -> str:
    """The on-disk path for an image/video node's `assetUrl` (`/assets/<job>/<name>`),
    or "" if unset/missing (-> a transparent layer)."""
    p = paths.asset_file_for_url((node.get("data") or {}).get("assetUrl"), paths.ASSETS_DIR)
    return str(p) if p is not None and p.exists() else ""


def _box_static(d: dict) -> dict:
    """The placement-box fields shared by image/video (fractions 0..1, default full-frame)."""
    return dict(
        box_x=float(d.get("box_x", 0.0)),
        box_y=float(d.get("box_y", 0.0)),
        box_w=float(d.get("box_w", 1.0)),
        box_h=float(d.get("box_h", 1.0)),
        fit=d.get("fit", "cover"),
    )


def _video_static(d: dict) -> dict:
    """The video node's non-modulatable fields (box/fit + source crop + loop). `start`/
    `sync` feed the source-time origin (`_video_src0`); `speed` is now a modulatable
    port, not static."""
    return {
        **_box_static(d),
        "loop": bool(d.get("loop", True)),
        "crop_x": float(d.get("crop_x", 0.0)),
        "crop_y": float(d.get("crop_y", 0.0)),
        "crop_w": float(d.get("crop_w", 1.0)),
        "crop_h": float(d.get("crop_h", 1.0)),
    }


def _feeds_a_montage(dag: "_Dag", node_id: str) -> bool:
    """Whether this card's stream ends up in a montage SLOT (directly or through an
    FX / combine chain). Slot chains are exclusive (validate enforces it), so one
    forward walk over the video edges is unambiguous."""
    downstream: dict[str, list[str]] = {}
    for e in dag.graph.get("edges", []):
        if e.get("targetPort") != LOOSE_PORT:
            downstream.setdefault(e.get("source"), []).append(e.get("target"))
    seen, stack = {node_id}, list(downstream.get(node_id, ()))
    while stack:
        nid = stack.pop()
        if nid in seen:
            continue
        seen.add(nid)
        if dag.nodes.get(nid, {}).get("type") == "montage":
            return True
        stack.extend(downstream.get(nid, ()))
    return False


def _video_src0(
    d: dict, speed_full: np.ndarray, seg_start: float, montage_slot: bool = False
) -> float:
    """Source time (s) at segment-frame 0: `start` plus, for `sync="song"`, a pre-roll of
    `seg_start` seconds advanced at the initial speed (so a background clip stays roughly
    phase-continuous across segments). Variable speed is integrated segment-locally.

    `montage_slot` drops that pre-roll: a montage RE-TIMES its inputs (local frame 0
    lands on the cut), so the song clock is already accounted for. Keeping it would
    seek `seg_start` seconds into a clip that only plays for the slot's length — on a
    30 s phone clip in a segment starting at 1:20, straight past the end, i.e. a
    frozen last frame for the whole slot. A montage input therefore always starts at
    its in-point, whatever its `sync`."""
    song_clock = d.get("sync", "song") == "song" and not montage_slot
    base_offset = seg_start if song_clock else 0.0
    return float(d.get("start", 0.0)) + base_offset * float(speed_full[0])


def _slideshow_kind(url: str) -> str:
    """Infer an item's kind from its URL extension (mirrors the frontend `slideshowKind`
    and `paths.ASSET_EXTS`). Only a fallback — the card sets `kind` at add-time; legacy
    `assetUrls` data has none."""
    ext = (url or "").rsplit(".", 1)[-1].lower()
    return "video" if ext in paths.ASSET_EXTS["video"] else "image"


def _slideshow_url_path(url: str) -> str:
    """`/assets/...` url -> on-disk path, or "" if unset/missing (a blank slot keeps the
    item count — and thus the trigger cycling — stable even if an asset vanished)."""
    p = paths.asset_file_for_url(url, paths.ASSETS_DIR)
    return str(p) if p is not None and p.exists() else ""


def _slideshow_items(dag: "_Dag", node: dict) -> list:
    """The slideshow's ordered items -> `[{path, kind, start}]`: the card's OWN picks
    (images + videos, each with its in-point) plus the IMAGE items wired into its
    `images` input (an Image gen card's generated list). A video item's `start` is its
    in-point seconds; images use 0."""
    d = node.get("data") or {}
    raw = list(d.get("items") or [])
    # Legacy fallback: a pre-v23 save/export may still carry `assetUrls: [str]` — treat
    # each as an image item (kind inferred from the ext for robustness).
    if not raw and d.get("assetUrls"):
        raw = [{"url": u} for u in d.get("assetUrls") or []]
    out = []
    for it in raw:
        if not isinstance(it, dict):
            continue
        url = it.get("url") or ""
        kind = it.get("kind")
        if kind not in ("image", "video"):
            kind = _slideshow_kind(url)
        out.append(
            {
                "path": _slideshow_url_path(url),
                "kind": kind,
                "start": float(it.get("start", 0.0) or 0.0),
            }
        )
    gen_id = _video_source(dag.graph, node["id"], "images")
    gen = dag.nodes.get(gen_id) if gen_id else None
    if gen is not None and gen.get("type") == "imagegen":
        # imagegen assetUrls align 1:1 with its prompts. A wired gate caps it via
        # `activeCount` (take the first N rows); then keep only real images so empty
        # rows never become blank slideshow slots.
        gen_data = gen.get("data") or {}
        gen_urls = gen_data.get("assetUrls") or []
        cap = gen_data.get("activeCount")
        if isinstance(cap, (int, float)):
            # floor at 0: a negative cap must mean "none", not a from-the-end slice
            gen_urls = gen_urls[: max(0, int(cap))]
        out += [
            {"path": _slideshow_url_path(u), "kind": "image", "start": 0.0} for u in gen_urls if u
        ]
    return out


def _slideshow_index(trigger: "np.ndarray", n_assets: int, d: dict) -> "np.ndarray":
    """Whole-segment per-frame image index: the trigger curve is gated through the
    card's built-in hysteresis threshold (reusing the gate card's `_gate_curve`),
    and each RISING edge advances to the next image (wrapping). Frame 0 always
    shows image 0 — a trigger that starts high counts from its next rise."""
    gate = _gate_curve(
        trigger, {"threshold": d.get("threshold", 0.5), "hysteresis": d.get("hysteresis", 0.1)}
    )
    rises = np.diff(gate) > 0
    idx = np.concatenate([[0], np.cumsum(rises)])
    return idx % max(1, n_assets)


def _slideshow_video(dag: "_Dag", node: dict) -> np.ndarray:
    gh, gw = _grid_dims(dag)
    nframes = max(1, round(dag.duration * dag.fps))
    d = node.get("data", {})
    params = dag._fx_params(node)  # {opacity, trigger} full-segment arrays
    items = _slideshow_items(dag, node)
    index = _slideshow_index(params["trigger"], len(items), d)
    clip = sources.SlideshowClip(gh, gw, dag.fps, items=items, index=index, **_box_static(d))
    try:
        return clip.frames(0, nframes, params["opacity"])
    finally:
        clip.close()


def _montage_srcs(dag: "_Dag", node: dict) -> list:
    """The montage's wired slots as `(source_id, span)` pairs, in slot order (unwired
    slots are skipped, combine-style, so the k-th WIRED input plays the k-th musical
    slot). `span` (default 1) is how many trigger cuts the slot swallows — a ×2 slot
    plays through two gate intervals before the montage moves on."""
    out = []
    for sl in (node.get("data") or {}).get("inputs", []):
        s = _video_source(dag.graph, node["id"], sl.get("id"))
        if s is not None:
            out.append((s, max(1, int(sl.get("span", 1) or 1))))
    return out


def _montage_starts(trigger: "np.ndarray", spans: list[int], d: dict) -> list[int]:
    """Absolute start frame of each PLAYED slot. Frame 0 always starts slot 0; each
    rising edge of the trigger (gated through the card's built-in hysteresis
    threshold, exactly like the slideshow) is a cut, and slot k swallows `spans[k]`
    cuts before the next slot starts. Rises beyond the wired slots are IGNORED — as
    is a slot whose starting cut never arrives — so the last STARTED input HOLDS to
    the segment end, its clock running on (no restart). Slot k is active on
    [starts[k], starts[k+1])."""
    gate = _gate_curve(
        trigger, {"threshold": d.get("threshold", 0.5), "hysteresis": d.get("hysteresis", 0.1)}
    )
    rises = np.nonzero(np.diff(gate) > 0)[0] + 1  # frame index where each cut lands
    starts = [0]
    consumed = 0
    for span in spans[:-1]:  # the last slot never hands over — its span is moot
        consumed += span
        if consumed - 1 >= len(rises):
            break  # not enough cuts left — the slot that just played holds
        starts.append(int(rises[consumed - 1]))
    return starts


def _to_rgba(frames: np.ndarray) -> np.ndarray:
    """Normalise a producer's frames to straight-alpha RGBA, compositing-exact.

    Handlers emit either RGBA (video/image/lyrics/slideshow) or 3-channel
    dye-on-black, which `composite` treats as premultiplied with max-channel
    brightness as coverage. The montage's output must be ONE uniform format, so
    3-channel frames become RGBA with `a = max channel` and un-premultiplied rgb
    (`f / a`) — `composite` then yields the same contribution (`rgb * a == f`)
    and the same occlusion, so a fluid inside a montage renders identically to
    the same fluid wired direct."""
    if frames.shape[-1] == 4:
        return frames
    f = frames.astype(np.float32) / 255.0
    a = f.max(axis=-1, keepdims=True)
    rgb = np.divide(f, a, out=np.zeros_like(f), where=a > 0)
    return (np.clip(np.concatenate([rgb, a], axis=-1), 0.0, 1.0) * 255).astype(np.uint8)


def _montage_slot_key(dag: "_Dag", src_id: str, gh: int, gw: int) -> str:
    """Frame-cache key for ONE montage slot, in that slot's LOCAL time.

    The montage re-times every input (local frame 0 lands on the cut), so a slot's
    frames depend ONLY on its own upstream chain — not on where its cut falls, nor on
    how long the slot lasts. `output_hash` over that chain already covers its nodes,
    edges, referenced signals, the segment window, the output settings and
    RENDER_VERSION; the grid is appended because `_grid_dims` decides it graph-wide
    (a fluid elsewhere in the graph switches every card to the sim grid).

    So: retiming the trigger reuses EVERY cached slot, and appending a slot renders
    only the new one — the earlier ones are memcpy'd out of the cache."""
    h = output_hash(dag.job_id, dag.segment, dag.graph, src_id, dag.output)
    return f"montage-{h}-{gh}x{gw}"


def _montage_video(dag: "_Dag", node: dict) -> np.ndarray:
    """The montage switcher: slot k shows its input's frames RE-TIMED to start at the
    cut — input k's local frame 0 lands on `starts[k]`, so an upstream video card
    (sync=segment, start=S) begins at its in-point exactly on the beat. Note the
    whole-song export styles each segment through THIS whole-clip path, and montage
    is deliberately NOT in `_field_nodes`: a fluid upstream re-simulates per segment,
    which matches the local-clock semantic."""
    slots = _montage_srcs(dag, node)
    if not slots:
        raise ValueError(f"montage '{node['id']}' has no inputs")
    d = node.get("data", {})
    params = dag._fx_params(node)  # {opacity, trigger} full-segment arrays
    nframes = max(1, round(dag.duration * dag.fps))
    gh, gw = _grid_dims(dag)
    starts = _montage_starts(params["trigger"], [span for _, span in slots], d)
    bounds = starts + [nframes]
    out = np.zeros((nframes, gh, gw, 4), np.uint8)
    for k, r in enumerate(starts):
        end = bounds[k + 1]
        if end <= r:
            continue
        need, src = end - r, slots[k][0]
        key = _montage_slot_key(dag, src, gh, gw)
        cached = fluid_cache.load(key)
        if cached is not None and cached.shape[1:] == (gh, gw, 4) and len(cached) >= need:
            out[r:end] = cached[:need]  # unchanged slot — no decode, no simulation
            continue
        frames = _to_rgba(dag.video(src))
        out[r:end] = frames[:need]
        fluid_cache.store(key, frames)
    return sources.apply_video_opacity(out, params["opacity"])


def _video_video(dag: "_Dag", node: dict) -> np.ndarray:
    gh, gw = _grid_dims(dag)
    nframes = max(1, round(dag.duration * dag.fps))
    d = node.get("data", {})
    params = dag._fx_params(node)  # {opacity, speed} full-segment arrays
    src0 = _video_src0(
        d,
        params["speed"],
        float(dag.segment.get("start", 0.0)),
        montage_slot=_feeds_a_montage(dag, node["id"]),
    )
    return sources.video(
        nframes,
        gh,
        gw,
        dag.fps,
        asset_path=_asset_path(dag, node),
        src0=src0,
        **_video_static(d),
        **params,
    )


# ── Generative source cards (waves / lightning / fire) ────────────────────────
# Each mirrors the backdrop pattern: `_fx_params` resolves the modulatable ports;
# the colour comes from a static `data.palette` preset or, if a `color` card is
# wired into the "color" input, that card's ramp overrides the preset.


def _wired_stops(dag: "_Dag", node: dict):
    """The ramp from a `color` card wired into the card's "color" input, or None.
    A gradient colour card supplies its stops directly; a swatch/rgb card becomes a
    dark->colour two-stop ramp so the field still reads as a gradient."""
    cid = _video_source(dag.graph, node["id"], "color")
    cnode = dag.nodes.get(cid) if cid else None
    if not cnode or cnode.get("type") != "color":
        return None
    data = cnode.get("data", {})
    if data.get("mode") == "gradient" and data.get("stops"):
        st = sorted(data["stops"], key=lambda s: float(s.get("t", 0.0)))
        return [
            (
                float(s.get("t", 0.0)),
                tuple(float(c) for c in fluid._hex_rgb(s.get("color", "#000000"))),
            )
            for s in st
        ]
    col = _resolve_node_color(dag.graph, node, "color", dag.nodes, dag._value_resolver())
    if not col:
        return None
    r, g, b = (float(np.mean(np.asarray(col[ch], np.float32))) for ch in ("r", "g", "b"))
    return [(0.0, (r * 0.15, g * 0.15, b * 0.15)), (1.0, (r, g, b))]


def _gen_stops(dag: "_Dag", node: dict, fallback: str) -> list:
    return _wired_stops(dag, node) or procgen.palette_stops(
        node.get("data", {}).get("palette", fallback), fallback
    )


def _gen_seed(node: dict) -> int:
    return int(node.get("data", {}).get("seed", 1))


_GEN_FALLBACK = {
    "waves": "ocean",
    "lightning": "electric",
    "aurora": "aurora",
    "rain": "downpour",
    "clouds": "sky",
}


def _gen_points(dag: "_Dag", node: dict):
    """The emitter-source SPECS from a points-flow card wired into `positions`,
    or None — the same resolver as fluid.positions (points / pattern /
    animate-points / merge-points). Full specs pass through, path and gate
    fields included, so ANIMATED points (orbit / drift / chase) drive the sim
    cards exactly like they drive fluid emitters: fire flames ride their paths,
    rain drips and lightning origins sample the moving position at each event."""
    pid = _video_source(dag.graph, node["id"], "positions")
    if not pid:
        return None
    return dag._resolve_points(pid) or None


def _gen_layer(dag: "_Dag", node: dict, fallback: str) -> dict:
    """One simulation card's layer dict (the sources.py contract): FULL-length
    port arrays + seed + palette stops + optional points positions. A merge
    passes one of these per merged card into ONE shared field."""
    layer = dict(dag._fx_params(node))
    layer["seed"] = _gen_seed(node)
    layer["stops"] = _gen_stops(dag, node, fallback)
    pts = _gen_points(dag, node)
    if pts:
        layer["points"] = pts
    return layer


def _flatten_rgb(clip: np.ndarray) -> np.ndarray:
    return fluid.flatten(clip) if clip.shape[-1] == 4 else clip


def _waves_block(dag: "_Dag", node: dict):
    gh, gw = _grid_dims(dag)
    layers = [_gen_layer(dag, node, "ocean")]  # full-length ports + frame_offset
    src = _video_source(dag.graph, node["id"], "video")
    producer = dag._block_producer(src) if src is not None else None

    def produce(a, b):
        base = _flatten_rgb(producer(a, b)) if producer is not None else None
        return sources.waves(b - a, gh, gw, dag.fps, layers, frame_offset=a, base=base)

    return produce


def _flicker_curve(nframes: int, fps: float, seed: int) -> np.ndarray:
    """Smoothed ~4 Hz noise in 0..1 modulating a fire's heat emission — the slow
    organic breathing of a real flame (never per-frame randomness, which reads
    as jitter). Deterministic from the card seed."""
    rng = np.random.default_rng(seed * 31 + 7)
    n_ctrl = max(3, int(np.ceil(nframes / max(fps, 1.0) * 4.0)) + 2)
    ctrl = rng.random(n_ctrl).astype(np.float32)
    xs = np.linspace(0.0, n_ctrl - 1.0, nframes)
    i0 = np.minimum(np.floor(xs).astype(np.int64), n_ctrl - 2)
    fr = (xs - i0).astype(np.float32)
    fr = fr * fr * (3.0 - 2.0 * fr)
    return ctrl[i0] * (1.0 - fr) + ctrl[i0 + 1] * fr


def _fire_sources(dag: "_Dag", node: dict):
    """A fire card -> (fluid HEAT-emitter dicts, fire field settings, ports).
    The emitters are genuine fluid sources (fire rides the solver), so a fire
    merges with other fires — and even with dye fluids — through the existing
    combine machinery; the field settings ride `params["fire"]`."""
    p = dag._fx_params(node)
    seed = _gen_seed(node)
    flick = _flicker_curve(len(p["intensity"]), dag.fps, seed)
    emit = p["intensity"] * (1.0 - p["flicker"] * 0.55 * (1.0 - flick))
    radius = 0.03 + 0.13 * p["width"]
    force = 2.0 + 8.0 * p["expansion"]  # add_radial: the combustion-expansion term
    base = dict(
        heat=True,
        radial=True,
        wrap=False,
        enabled=True,
        emit=emit.tolist(),
        radius=radius.tolist(),
        force=force.tolist(),
    )
    specs = _gen_points(dag, node)
    if specs:  # a points card: one flame per spec — path/gate fields ride along,
        # so animate-points orbits/drifts/chases move and gate the flames
        # exactly like fluid emitters
        emitters = [dict(base, **spec) for spec in specs]
    else:  # modulatable origin ports (an LFO can glide the flame around)
        emitters = [dict(base, px=p["origin_x"].tolist(), py=p["origin_y"].tolist())]
    fire_cfg = {
        "buoyancy": 1.1,
        "direction": p["direction"].tolist(),
        "cooling": p["cooling"].tolist(),
        "glow": p["glow"].tolist(),
        "opacity": p["opacity"].tolist(),
        "stops": [[float(t), [float(c) for c in col]] for t, col in _gen_stops(dag, node, "flame")],
    }
    return emitters, fire_cfg, p


def _fire_params(dag: "_Dag", node: dict) -> dict:
    """simulate() params for ONE fire card (the single-card path — a merge goes
    through `_merge_params` with the combine's medium instead)."""
    emitters, fire_cfg, p = _fire_sources(dag, node)
    params = {
        "duration": dag.duration,
        "fps": dag.fps,
        "sources": emitters,
        "fluid": {
            "dissipation": 0.95,
            "velocity_dissipation": 0.94,
            "viscosity": 0.0,
            "vorticity": (2.0 + 10.0 * p["turbulence"]).tolist(),
        },
        "fire": fire_cfg,
    }
    if dag.output:
        params["output"] = _output_params(dag.output, dag.fps)
    else:
        params["grid"] = LEGACY_GRID
    return params


def _fire_video(dag: "_Dag", node: dict) -> np.ndarray:
    return _sim_video(_fire_params(dag, node))  # fluid path: frame cache + all


def _fire_block(dag: "_Dag", node: dict):
    return _sim_blocks(dag, _fire_params(dag, node))


def _lightning_block(dag: "_Dag", node: dict):
    # Ports stay FULL-length (the strike schedule is absolute-frame-keyed); the
    # bolt cache carries each strike's DBM geometry + glow stacks across blocks
    # so a flash spanning a block seam doesn't regrow its discharge.
    gh, gw = _grid_dims(dag)
    layers = [_gen_layer(dag, node, "electric")]
    cache: dict = {}

    def produce(a, b):
        return sources.lightning(b - a, gh, gw, dag.fps, layers, frame_offset=a, bolt_cache=cache)

    return produce


def _aurora_block(dag: "_Dag", node: dict):
    gh, gw = _grid_dims(dag)
    layers = [_gen_layer(dag, node, "aurora")]  # full-length (drift integrates)

    def produce(a, b):
        return sources.aurora(b - a, gh, gw, dag.fps, layers, frame_offset=a)

    return produce


def _rain_block(dag: "_Dag", node: dict):
    # STATEFUL sim: the spectral surface (ĥ, ĥ⁻) carries across produce() calls.
    # Safe because `stream_blocks` pulls contiguous front-to-back blocks from
    # frame 0 (a restart builds a fresh Dag) and `_block_producer`'s one-block
    # memo + lock serve diamond consumers without re-invoking — the same
    # contract `_echo_block` documents. Ports stay FULL-length (the drop
    # schedule is absolute-frame-keyed) — the lightning convention. No frame
    # cache on purpose: a partial writer is the only place stale sim state
    # could ever leak, and the encoded-clip cache already covers replays.
    gh, gw = _grid_dims(dag)
    layers = [_gen_layer(dag, node, "downpour")]
    src = _video_source(dag.graph, node["id"], "video")
    producer = dag._block_producer(src) if src is not None else None
    state = {"s": None}

    def produce(a, b):
        base = _flatten_rgb(producer(a, b)) if producer is not None else None
        frames, state["s"] = sources.rain(
            b - a, gh, gw, dag.fps, layers, frame_offset=a, base=base, state=state["s"]
        )
        return frames

    return produce


def _clouds_block(dag: "_Dag", node: dict):
    gh, gw = _grid_dims(dag)
    layers = [_gen_layer(dag, node, "sky")]  # full-length (drift integrates)

    def produce(a, b):
        return sources.clouds(b - a, gh, gw, dag.fps, layers, frame_offset=a)

    return produce


# ── merge dispatch for the simulation cards ──────────────────────────────────
# A combine(merge) whose inputs are gen-sim cards shares ONE physical field:
# waves superpose height spectra, rains drip into one surface, bolts light one
# sky, curtains fill one sky, cloud densities shade under one sun. Fire is NOT
# here — its emitters are fluid sources, so fire merges ride the fluid branch.


def _gen_emitters_h(dag: "_Dag", node: dict) -> list:
    t = node.get("type")
    e = {"_kind": t, "layer": _gen_layer(dag, node, _GEN_FALLBACK[t])}
    if t in ("waves", "rain"):
        src = _video_source(dag.graph, node["id"], "video")
        if src:
            e["base_src"] = src
    return [e]


def _fire_emitters_h(dag: "_Dag", node: dict) -> list:
    emitters, fire_cfg, _ = _fire_sources(dag, node)
    return [dict(e, _fire=fire_cfg) if i == 0 else e for i, e in enumerate(emitters)]


def _gen_merge_split(dag: "_Dag", node: dict):
    """A merge combine's emitters -> ('gen kind', layers, base_src) for a
    homogeneous gen-sim merge, or (None, emitters, None) for the fluid/fire
    branch. Mixed kinds raise — a merge shares ONE physical medium."""
    emitters = dag.emitters(node["id"])
    kinds = sorted({e["_kind"] for e in emitters if "_kind" in e})
    if not kinds:
        return None, emitters, None
    if len(kinds) > 1 or any("_kind" not in e for e in emitters):
        mixed = kinds + (["fluid/fire"] if any("_kind" not in e for e in emitters) else [])
        raise ValueError(
            f"combine(merge) '{node['id']}' mixes different simulations "
            f"({', '.join(mixed)}) — a merge shares one physical field, so merge "
            "same-kind cards, or switch this combine to layered (stack)"
        )
    base_src = next((e["base_src"] for e in emitters if e.get("base_src")), None)
    return kinds[0], [e["layer"] for e in emitters], base_src


def _transform_static(d: dict) -> tuple:
    """The transform card's non-modulatable fields: fold mode, wedge count, edge rule."""
    mode = d.get("mode", "transform")
    if mode not in ("transform", "mirror", "kaleidoscope"):
        mode = "transform"
    raw = d.get("segments")
    # `or 6` would swallow a literal 0 — clamp it to the 2-wedge minimum instead.
    segments = int(np.clip(int(6 if raw is None else raw), 2, 12))
    return mode, segments, bool(d.get("wrap", False))


def _transform_frames(
    frames: np.ndarray, mode: str, segments: int, wrap: bool, *, zoom, rotate, pan_x, pan_y
) -> np.ndarray:
    """Warp `frames` (T, H, W, C) uint8, C in {3, 4} — an RGBA layer's alpha warps with
    its colour, so lyrics stay correctly cut out. Params are per-frame float arrays.

    The mapping is built BACKWARDS (dest pixel -> source pixel), the same backtrace
    `fluid._advect` does: undo the pan, unrotate, then un-zoom. Sampling outside the
    frame yields 0 (`cval=0`), so the dye-on-black floor survives every mode and
    downstream `composite`/`flatten` alpha still works. `wrap` tiles instead."""
    t, h, w, c = frames.shape
    cy, cx = (h - 1) / 2.0, (w - 1) / 2.0
    # Pixel-space centered coords: the grid cells are square, so rotating here is
    # aspect-correct on a portrait/landscape canvas alike.
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    dy0, dx0 = yy - cy, xx - cx
    # Fold modes (mirror/kaleidoscope) fill the out-of-frame wedge by MIRRORING the frame
    # at its edge, so a non-square canvas / rotation never leaves black gaps — reflection is
    # the fold's own aesthetic, and every sample lands on a real, full-res pixel (no crop, no
    # zoom). `wrap` still tiles for that look; a plain transform stays black-outside (cval=0),
    # the conventional pan/zoom/rotate behaviour, unless wrapped.
    if wrap:
        edge = "grid-wrap"
    elif mode in ("mirror", "kaleidoscope"):
        edge = "mirror"
    else:
        edge = "constant"
    out = np.empty_like(frames)
    wedge = 2.0 * np.pi / max(2, segments)

    for i in range(t):
        z = max(1e-3, float(zoom[i]))
        th = np.deg2rad(float(rotate[i]))
        # Undo the pan (normalized to the frame's own size), then the rotation, then
        # the zoom — the inverse of "zoom, rotate, pan" as the user reads the card.
        dx = dx0 - float(pan_x[i]) * w
        dy = dy0 - float(pan_y[i]) * h
        cos, sin = np.cos(th), np.sin(th)
        sx = (cos * dx + sin * dy) / z
        sy = (-sin * dx + cos * dy) / z
        if mode == "mirror":
            sx = -np.abs(sx)  # both halves sample the left half
        elif mode == "kaleidoscope":
            r = np.hypot(sx, sy)
            a = np.mod(np.arctan2(sy, sx), wedge)
            a = np.where(a > wedge / 2.0, wedge - a, a)  # mirror inside the wedge
            sx, sy = r * np.cos(a), r * np.sin(a)
        coords = np.stack([sy + cy, sx + cx])
        for ch in range(c):
            warped = map_coordinates(
                frames[i, :, :, ch].astype(np.float32), coords, order=1, mode=edge, cval=0.0
            )
            out[i, :, :, ch] = np.clip(warped, 0, 255).astype(np.uint8)
    return out


def _transform_video(dag: "_Dag", node: dict) -> np.ndarray:
    src = _video_source(dag.graph, node["id"], "video")
    if src is None:
        raise ValueError(f"transform '{node['id']}' has no video input")
    mode, segments, wrap = _transform_static(node.get("data", {}))
    return _transform_frames(dag.video(src), mode, segments, wrap, **dag._fx_params(node))


def _stylize_video(dag: "_Dag", node: dict) -> np.ndarray:
    """AI Stylize (video→video): if a stylized clip was generated (`data.assetUrl`), decode
    it; otherwise pass the upstream fluid through (the 'not generated yet' preview)."""
    ap = _asset_path(dag, node)
    if ap:
        gh, gw = _grid_dims(dag)
        nframes = max(1, round(dag.duration * dag.fps))
        dec = sources.video(
            nframes,
            gh,
            gw,
            dag.fps,
            asset_path=ap,
            src0=0.0,
            speed=1.0,
            opacity=np.ones(nframes, np.float32),
        )
        return np.ascontiguousarray(dec[..., :3])  # dye-on-black convention (drop coverage alpha)
    src = _video_source(dag.graph, node["id"], "video")
    if src is None:
        raise ValueError(f"stylize '{node['id']}' has no video input")
    return dag.video(src)


def _extract_static(d: dict) -> str:
    """The Extract card's control kind: canny / soft / density (OpenCV) or depth (a model)."""
    kind = d.get("kind", "canny")
    return kind if kind in ("canny", "soft", "density", "depth") else "canny"


def _extract_apply(frames: np.ndarray, kind: str) -> np.ndarray:
    """A video clip [T,h,w,3] → a control-image clip (white structure on black), for feeding
    a ControlNet. `canny`/`soft`/`density` are pure OpenCV (real-time); `depth` runs a small
    depth model per frame (downloads on first use). `density` = the input's own luminance —
    the right 'volume' control for a fluid (a real depth model only fits real 3D scenes)."""
    if kind == "depth":
        from . import imagegen  # lazy: keep torch off the render path unless depth is used

        return imagegen.depth_frames(frames)
    try:
        import cv2
    except ImportError as e:  # pragma: no cover
        raise RuntimeError(
            "the Extract card needs opencv — `pip install -r requirements.txt`"
        ) from e
    out = np.empty_like(frames)
    for i in range(len(frames)):
        f = np.ascontiguousarray(frames[i])
        if kind == "density":
            e = f.max(axis=2)  # value = the dye's density (bright where there's matter)
        else:
            g = cv2.cvtColor(f, cv2.COLOR_RGB2GRAY)
            if kind == "soft":
                gx = cv2.Sobel(g.astype(np.float32), cv2.CV_32F, 1, 0, ksize=5)
                gy = cv2.Sobel(g.astype(np.float32), cv2.CV_32F, 0, 1, ksize=5)
                e = np.clip(cv2.GaussianBlur(np.sqrt(gx * gx + gy * gy), (0, 0), 1.5) / 2, 0, 255)
                e = e.astype(np.uint8)
            else:
                e = cv2.Canny(g, 80, 160)
        out[i] = cv2.cvtColor(e, cv2.COLOR_GRAY2RGB)
    return out


def _extract_video(dag: "_Dag", node: dict) -> np.ndarray:
    src = _video_source(dag.graph, node["id"], "video")
    if src is None:
        raise ValueError(f"extract '{node['id']}' has no video input")
    frames = dag.video(src)
    if frames.shape[-1] == 4:
        frames = fluid.flatten(frames)
    return _extract_apply(frames, _extract_static(node.get("data", {})))


def _echo_static(d: dict) -> str:
    """The echo card's trail memory: ghost (EMA afterimages), bright (decayed max),
    or dark (bright's mirror — shadow trails)."""
    mode = d.get("mode", "ghost")
    return mode if mode in ("ghost", "bright", "dark") else "ghost"


def _echo_video(dag: "_Dag", node: dict) -> np.ndarray:
    src = _video_source(dag.graph, node["id"], "video")
    if src is None:
        raise ValueError(f"echo '{node['id']}' has no video input")
    mode = _echo_static(node.get("data", {}))
    out, _acc = look_fx.echo_scan(dag.video(src), None, dag.fps, mode, **dag._fx_params(node))
    return out


def _colorgrade_static(d: dict) -> tuple:
    """The Color Grade card's non-modulatable fields: mode, thermal map, swatches."""
    mode = d.get("mode", "thermal")
    if mode not in ("thermal", "duotone", "neon"):
        mode = "thermal"
    cmap = d.get("map", "turbo")
    if cmap not in look_fx._THERMAL_MAPS:
        cmap = "turbo"
    return mode, cmap, d.get("colorA", "#0b1030"), d.get("colorB", "#ff5ac8")


def _colorgrade_setup(dag: "_Dag", node: dict) -> tuple:
    """Shared whole-clip/block setup: statics + the PER-FRAME (nframes,3) grade colour.
    A `color` card wired into `tint` overrides the colorB swatch (its intensity folded
    in, the `_lyrics_params` convention) — a gradient tint with a bound `position`
    sweeps the grade's colour with the music."""
    mode, cmap, color_a_hex, color_b_hex = _colorgrade_static(node.get("data", {}))
    nframes = max(1, round(dag.duration * dag.fps))
    tint = _resolve_node_color(dag.graph, node, "tint", dag.nodes, dag._value_resolver())
    if tint:
        inten = fluid._series(tint["intensity"], nframes)
        color_b = np.stack(
            [np.clip(fluid._series(tint[ch], nframes) * inten, 0.0, 1.0) for ch in ("r", "g", "b")],
            axis=-1,
        ).astype(np.float32)
    else:
        color_b = np.tile(fluid._hex_rgb(color_b_hex), (nframes, 1))
    return mode, cmap, fluid._hex_rgb(color_a_hex), color_b


def _colorgrade_video(dag: "_Dag", node: dict) -> np.ndarray:
    src = _video_source(dag.graph, node["id"], "video")
    if src is None:
        raise ValueError(f"colorgrade '{node['id']}' has no video input")
    mode, cmap, color_a, color_b = _colorgrade_setup(dag, node)
    return look_fx.colorgrade_apply(
        dag.video(src), mode, cmap, color_a, color_b, dag.fps, 0, **dag._fx_params(node)
    )


def _whole_from_block(card: str):
    """Derive a whole-clip handler from the block one: `produce(0, nframes)`.

    For most cards the two handlers were literal restatements of each other — the block
    version with `frame_offset=0` and no carried state. Keeping both meant every new card
    cost two handlers and two chances to diverge, and a divergence here shows up as "the
    export doesn't look like the preview", the worst bug class in this engine. Cards whose
    block handler carries genuine cross-block state (fluid/combine/montage/echo and the
    FX that accumulate) still define both, and `test_card_impact` asserts whole == streamed
    for EVERY card so the two paths can never drift apart unnoticed."""

    def whole(dag: "Dag", node: dict) -> np.ndarray:
        return _BLOCK_HANDLERS[card](dag, node)(0, max(1, round(dag.duration * dag.fps)))

    return whole


_VIDEO_HANDLERS = {
    "fluid": _fluid_video,
    "output": _output_video,
    "combine": _combine_video,
    "lyrics": _lyrics_video,
    "image": _whole_from_block("image"),
    "slideshow": _slideshow_video,
    "montage": _montage_video,
    "video": _video_video,
    "backdrop": _whole_from_block("backdrop"),
    "transform": _transform_video,
    "stylize": _stylize_video,
    "extract": _extract_video,
    "echo": _echo_video,
    "colorgrade": _colorgrade_video,
    "waves": _whole_from_block("waves"),
    "lightning": _whole_from_block("lightning"),
    "fire": _fire_video,
    "aurora": _whole_from_block("aurora"),
    "rain": _whole_from_block("rain"),
    "clouds": _whole_from_block("clouds"),
}
_EMITTER_HANDLERS = {
    "fluid": _fluid_emitters_h,
    "output": _output_emitters_h,
    "combine": _combine_emitters_h,
    "fire": _fire_emitters_h,
    "waves": _gen_emitters_h,
    "lightning": _gen_emitters_h,
    "aurora": _gen_emitters_h,
    "rain": _gen_emitters_h,
    "clouds": _gen_emitters_h,
}


# --------------------------------------------------------------------------- #
# Block-streaming handlers: `(dag, node) -> produce(a, b)`. Each mirrors the
# matching `_VIDEO_HANDLERS` entry but produces one frame block. Setup (params,
# FluidClip, upstream producers) runs ONCE when the closure is built; `produce`
# is called per block. Keep these in lockstep with the video handlers above.
def _fluid_block(dag: "_Dag", node: dict):
    return _sim_blocks(dag, dag._fluid_video_params(node))


def _output_block(dag: "_Dag", node: dict):
    src = _video_source(dag.graph, node["id"], "video")
    if src is None:
        raise ValueError(f"output '{node['id']}' has no input to pass through")
    return dag._block_producer(src)


def _combine_block(dag: "_Dag", node: dict):
    data = node.get("data", {})
    srcs = [(_video_source(dag.graph, node["id"], s.get("id")), s) for s in data.get("inputs", [])]
    srcs = [(s, slot) for (s, slot) in srcs if s is not None]
    if not srcs:
        raise ValueError(f"combine '{node['id']}' has no inputs")
    if data.get("mode") == "stack":
        producers = [dag._block_producer(s) for (s, _) in srcs]
        opac = [float(slot.get("opacity", 1.0)) for (_, slot) in srcs]
        # One pool per combine, built ONCE and reused for every block (not per-block);
        # its own pool per combine keeps nested stack-combines deadlock-free. The dag
        # owns shutdown (stream_blocks' finally). numpy releases the GIL for the
        # FFT/advection, so the branches are genuinely parallel.
        ex = ThreadPoolExecutor(max_workers=len(producers)) if len(producers) > 1 else None
        if ex is not None:
            dag._executors.append(ex)

        def produce(a, b):
            if ex is None:
                return composite([producers[0](a, b)], opac)
            layers = list(ex.map(lambda p: p(a, b), producers))  # map preserves order
            return composite(layers, opac)

        return produce
    # merge: one shared sim over the concatenated emitters (see _combine_video).
    kind, layers, base_src = _gen_merge_split(dag, node)
    if kind is not None:
        gh, gw = _grid_dims(dag)
        producer = dag._block_producer(base_src) if base_src else None
        fn = getattr(sources, kind)
        if kind == "rain":
            state = {"s": None}

            def produce_rain(a, b):
                base = _flatten_rgb(producer(a, b)) if producer is not None else None
                frames, state["s"] = fn(
                    b - a, gh, gw, dag.fps, layers, frame_offset=a, base=base, state=state["s"]
                )
                return frames

            return produce_rain
        if kind == "lightning":
            cache: dict = {}
            return lambda a, b: fn(b - a, gh, gw, dag.fps, layers, frame_offset=a, bolt_cache=cache)
        if kind == "waves":

            def produce_waves(a, b):
                base = _flatten_rgb(producer(a, b)) if producer is not None else None
                return fn(b - a, gh, gw, dag.fps, layers, frame_offset=a, base=base)

            return produce_waves
        return lambda a, b: fn(b - a, gh, gw, dag.fps, layers, frame_offset=a)
    return _sim_blocks(dag, dag._merge_params(layers, data.get("medium", {})))


def _lyrics_block(dag: "_Dag", node: dict):
    d = node.get("data", {})
    gh, gw = _grid_dims(dag)
    lines = dag.segment.get("lyric_lines") or []
    params = dag._lyrics_params(node)  # size/opacity/r/g/b + outline_r/g/b, sliced per block
    kw = dict(
        lines=lines,
        seg_start=float(dag.segment.get("start", 0.0)),
        **_lyrics_static(d),
    )

    def produce(a, b):
        return sources.lyrics(
            b - a, gh, gw, dag.fps, frame_offset=a, **kw, **{k: v[a:b] for k, v in params.items()}
        )

    return produce


def _image_block(dag: "_Dag", node: dict):
    gh, gw = _grid_dims(dag)
    ap, static = _asset_path(dag, node), _box_static(node.get("data", {}))
    params = dag._fx_params(node)  # {opacity} sliced per block

    def produce(a, b):
        return sources.image(
            b - a,
            gh,
            gw,
            asset_path=ap,
            frame_offset=a,
            **static,
            **{k: v[a:b] for k, v in params.items()},
        )

    return produce


def _slideshow_block(dag: "_Dag", node: dict):
    gh, gw = _grid_dims(dag)
    d = node.get("data", {})
    params = dag._fx_params(node)  # {opacity, trigger} full-segment arrays
    items = _slideshow_items(dag, node)
    # The per-frame index (and the SlideshowClip's run-relative timing) is computed over
    # the WHOLE segment once, so slicing it by block keeps the slideshow continuous across
    # block seams — and one persistent VideoClip per video item is held across blocks
    # (video-card pattern), reopening only on the backward jump of a run restart.
    index = _slideshow_index(params["trigger"], len(items), d)
    clip = sources.SlideshowClip(gh, gw, dag.fps, items=items, index=index, **_box_static(d))
    dag._closers.append(clip.close)

    def produce(a, b):
        return clip.frames(a, b, params["opacity"][a:b])

    return produce


def _montage_block(dag: "_Dag", node: dict):
    """Block mirror of `_montage_video`. Each slot's producer is pulled with LOCAL
    frame ranges (absolute − slot start): slots are sequential and never revisited,
    so every producer still sees contiguous front-to-back ranges starting at 0 —
    the FluidClip/echo/rain contract holds. Two costs, both deliberate:
    - a producer feeding a montage slot must feed NOTHING else (validate enforces
      it — `_block_producer` memoizes one producer per node, and a second consumer
      would pull conflicting absolute ranges into the same stateful sim);
    - an upstream fluid's own raw-frame cache never finalizes under local pulls (that
      writer commits only when b reaches nframes) — but the montage caches each
      slot's FINISHED frames itself (`_montage_slot_key`), so the re-simulation
      happens once, not once per edit."""
    slots = _montage_srcs(dag, node)
    if not slots:
        raise ValueError(f"montage '{node['id']}' has no inputs")
    d = node.get("data", {})
    gh, gw = _grid_dims(dag)
    params = dag._fx_params(node)  # {opacity, trigger} full-segment arrays
    nframes = max(1, round(dag.duration * dag.fps))
    starts = _montage_starts(params["trigger"], [span for _, span in slots], d)
    bounds = np.array(starts + [nframes])

    def _slot_producer(src: str, length: int):
        """`produce_local(a, b) -> RGBA frames` for one slot: served straight from the
        slot frame cache when it holds enough frames (no decoder, no sim, no upstream
        producer BUILT at all), else the real producer teed into the cache so the next
        edit reuses it. The cache is written in local time, so it survives a retimed
        trigger; only a slot that grew LONGER than its cached run re-renders."""
        key = _montage_slot_key(dag, src, gh, gw)
        cached = fluid_cache.load(key)
        if cached is not None and cached.shape[1:] == (gh, gw, 4) and len(cached) >= length:
            return lambda a, b: np.ascontiguousarray(cached[a:b])
        inner = dag._block_producer(src)
        mm, finalize, discard = fluid_cache.frame_writer(key, (length, gh, gw, 4))
        if mm is None:  # cache disabled/unopenable — render straight through
            return lambda a, b: _to_rgba(inner(a, b))
        dag._closers.append(discard)  # a cancelled stream drops the partial file

        def produce_local(a, b):
            blk = _to_rgba(inner(a, b))
            mm[a:b] = blk
            if b >= length:  # the montage knows each slot's length up front
                finalize()
            return blk

        return produce_local

    # Producers only for slots that actually play — no idle FluidClips.
    producers = [
        _slot_producer(s, int(bounds[k + 1]) - int(bounds[k]))
        for k, (s, _) in enumerate(slots[: len(starts)])
    ]

    def produce(a, b):
        out = np.zeros((b - a, gh, gw, 4), np.uint8)
        # A block may straddle one or more cuts: split it per slot bucket.
        k0 = int(np.searchsorted(bounds, a, side="right")) - 1
        k1 = int(np.searchsorted(bounds, b - 1, side="right")) - 1
        for k in range(k0, k1 + 1):
            s, e = max(a, int(bounds[k])), min(b, int(bounds[k + 1]))
            if e > s:
                r = int(bounds[k])
                out[s - a : e - a] = producers[k](s - r, e - r)  # already RGBA
        return sources.apply_video_opacity(out, params["opacity"][a:b])

    return produce


def _video_block(dag: "_Dag", node: dict):
    gh, gw = _grid_dims(dag)
    d = node.get("data", {})
    ap, static = _asset_path(dag, node), _video_static(d)
    params = dag._fx_params(node)  # {opacity, speed} full-segment arrays
    speed_full = params["speed"]
    # Integrate speed over the WHOLE segment up front so the source-time origin stays
    # continuous across stream blocks — and hold ONE persistent decoder across them
    # (mirrors the fluid producer's resumable FluidClip) instead of spawning a fresh
    # seek+decode ffmpeg per block. The dag reaps it on stream end/cancel.
    src_base = _video_src0(
        d,
        speed_full,
        float(dag.segment.get("start", 0.0)),
        montage_slot=_feeds_a_montage(dag, node["id"]),
    )
    src_t = sources.video_src_times(len(speed_full), dag.fps, src_base, speed_full)
    clip = sources.VideoClip(gh, gw, dag.fps, asset_path=ap, **static)
    dag._closers.append(clip.close)

    def produce(a, b):
        return sources.apply_video_opacity(clip.frames(src_t[a:b]), params["opacity"][a:b])

    return produce


def _backdrop_block(dag: "_Dag", node: dict):
    gh, gw = _grid_dims(dag)
    params = dag._backdrop_params(node)  # {opacity, r, g, b} sliced per block

    def produce(a, b):
        return sources.backdrop(
            b - a, gh, gw, frame_offset=a, **{k: v[a:b] for k, v in params.items()}
        )

    return produce


def _transform_block(dag: "_Dag", node: dict):
    src = _video_source(dag.graph, node["id"], "video")
    if src is None:
        raise ValueError(f"transform '{node['id']}' has no video input")
    mode, segments, wrap = _transform_static(node.get("data", {}))
    params = dag._fx_params(node)  # {zoom, rotate, pan_x, pan_y} sliced per block
    producer = dag._block_producer(src)

    def produce(a, b):
        return _transform_frames(
            producer(a, b), mode, segments, wrap, **{k: v[a:b] for k, v in params.items()}
        )

    return produce


def _stylize_block(dag: "_Dag", node: dict):
    """Block mirror of `_stylize_video`: decode the generated clip (persistent VideoClip)
    or pass the upstream producer through when nothing is generated yet."""
    ap = _asset_path(dag, node)
    if ap:
        gh, gw = _grid_dims(dag)
        nframes = max(1, round(dag.duration * dag.fps))
        src_t = np.arange(nframes, dtype=np.float64) / float(dag.fps)
        clip = sources.VideoClip(gh, gw, dag.fps, asset_path=ap, loop=True)
        dag._closers.append(clip.close)

        def produce(a, b):
            return np.ascontiguousarray(clip.frames(src_t[a:b])[..., :3])

        return produce
    src = _video_source(dag.graph, node["id"], "video")
    if src is None:
        raise ValueError(f"stylize '{node['id']}' has no video input")
    return dag._block_producer(src)


def _extract_block(dag: "_Dag", node: dict):
    src = _video_source(dag.graph, node["id"], "video")
    if src is None:
        raise ValueError(f"extract '{node['id']}' has no video input")
    kind = _extract_static(node.get("data", {}))
    producer = dag._block_producer(src)

    def produce(a, b):
        f = producer(a, b)
        if f.shape[-1] == 4:
            f = fluid.flatten(f)
        return _extract_apply(f, kind)

    return produce


def _echo_block(dag: "_Dag", node: dict):
    """The wave's one STATEFUL block handler: the trail accumulator is carried across
    `produce(a, b)` calls. Exact, not an approximation — decay folds every past frame
    into `acc`, so carrying it IS the whole-history scan (blocks can't re-pull earlier
    upstream frames). Safe because `_block_producer`'s one-block cache + lock runs this
    closure once per block, in contiguous front-to-back order (the FluidClip contract)."""
    src = _video_source(dag.graph, node["id"], "video")
    if src is None:
        raise ValueError(f"echo '{node['id']}' has no video input")
    mode = _echo_static(node.get("data", {}))
    params = dag._fx_params(node)  # {length, amount} full-segment arrays
    producer = dag._block_producer(src)
    state: dict = {"acc": None}

    def produce(a, b):
        out, state["acc"] = look_fx.echo_scan(
            producer(a, b), state["acc"], dag.fps, mode, **{k: v[a:b] for k, v in params.items()}
        )
        return out

    return produce


def _colorgrade_block(dag: "_Dag", node: dict):
    src = _video_source(dag.graph, node["id"], "video")
    if src is None:
        raise ValueError(f"colorgrade '{node['id']}' has no video input")
    mode, cmap, color_a, color_b = _colorgrade_setup(dag, node)  # color_b: full-segment (n,3)
    params = dag._fx_params(node)  # {intensity, shift} full-segment arrays
    producer = dag._block_producer(src)

    def produce(a, b):
        return look_fx.colorgrade_apply(
            producer(a, b),
            mode,
            cmap,
            color_a,
            color_b[a:b],
            dag.fps,
            a,
            **{k: v[a:b] for k, v in params.items()},
        )

    return produce


_BLOCK_HANDLERS = {
    "fluid": _fluid_block,
    "output": _output_block,
    "combine": _combine_block,
    "lyrics": _lyrics_block,
    "image": _image_block,
    "slideshow": _slideshow_block,
    "montage": _montage_block,
    "video": _video_block,
    "backdrop": _backdrop_block,
    "transform": _transform_block,
    "stylize": _stylize_block,
    "extract": _extract_block,
    "echo": _echo_block,
    "colorgrade": _colorgrade_block,
    "waves": _waves_block,
    "lightning": _lightning_block,
    "fire": _fire_block,
    "aurora": _aurora_block,
    "rain": _rain_block,
    "clouds": _clouds_block,
}
# The producer set lives in graph_common (the leaf) so validate needn't import this
# module. Assert the two agree at import: a card added to one and not the other would
# otherwise fail late, as a confusing "not a video producer" on a card that renders fine.
assert set(_VIDEO_HANDLERS) == set(VIDEO_PRODUCERS), (
    f"handler table and graph_common.VIDEO_PRODUCERS disagree: "
    f"{set(_VIDEO_HANDLERS) ^ set(VIDEO_PRODUCERS)}"
)
_VIDEO_PRODUCERS = VIDEO_PRODUCERS  # back-compat name for existing importers


def render(
    job_id: str,
    segment: dict,
    graph: dict,
    stem_audio_path: Callable,
    output: dict | None = None,
    output_id: str | None = None,
) -> str:
    """Resolve one output's video DAG for `segment`, render an mp4, return its URL.

    Walks the producers feeding `output_id` (fluid / combine / output-passthrough),
    rendering dye-on-transparent frames, then flattens them onto black at the terminal
    (`fluid.flatten`). There is no project background — a non-black backdrop is the bottom
    layer of a stack combine (a `backdrop` card). `output_id` selects which output.
    Cached by the per-output contributing-subgraph hash. Raises ValueError on a bad
    graph (HTTP 400). `stem_audio_path(job_id, stem)` is injected from app.py.
    """
    output = output or {}
    # The target gates which rules apply: a producer previewed directly needs no output
    # node in the graph (see graph_validate.validate / the _render_target contract).
    validate(graph, output_id)
    if output_id is None:
        output_id = _nodes_of(graph, "output")[0]["id"]
    out_path = paths.ANIM_DIR / f"{output_hash(job_id, segment, graph, output_id, output)}.mp4"
    url = f"/fluid/{out_path.name}"
    if out_path.exists():
        render_cache.touch(out_path)  # keep this hot clip from aging out (LRU)
        return url

    # `with`: the sync path opens the same decoders the streaming path does (slideshow /
    # video / stylize register clip.close on the DAG), and used to leak every one of them.
    with _Dag(job_id, segment, graph, stem_audio_path, output) as dag:
        src = _render_target(graph, dag.nodes, output_id)  # output OR direct producer preview
        frames = dag.video(src)
        frames = fluid.flatten(frames)  # RGBA -> RGB on black (backgrounds are now layers)
        out_w = int(output.get("width", 0)) or None
        out_h = int(output.get("height", 0)) or None
        fluid.render_mp4(frames, dag.fps, out_path, out_w, out_h)
    render_cache.evict(paths.ANIM_DIR)  # bound the cache after adding a clip
    return url


def render_stream(
    job_id: str,
    segment: dict,
    graph: dict,
    stem_audio_path: Callable,
    output: dict | None = None,
    output_id: str | None = None,
    *,
    on_progress: Callable | None = None,
    should_cancel: Callable | None = None,
    block_seconds: float = RENDER_BLOCK_SECONDS,
) -> str | None:
    """Progressive render: encode `output_id`'s clip in front-to-back blocks into ONE
    growing (fragmented) mp4, and return the final clip URL.

    A single persistent ffmpeg is fed each block's frames on its stdin (see
    `fluid.open_stream_encoder`); the fragmented layout means the file is playable
    while it grows, so the preview appears after ~one block instead of the whole clip.
    Same `output_hash` / cache path as `render()`, so a finished stream is a normal
    cache hit for the sync path and vice-versa. `on_progress(frames_done, total,
    preview_url)` fires per block (the URL carries a `?n=` cache-buster so the client
    reloads the grown file), and once more with the final URL on completion.
    `should_cancel()` is polled between blocks; True stops early — the encoder is
    killed, the scratch dir dropped, and None returned.
    """
    output = output or {}
    # The target gates which rules apply: a producer previewed directly needs no output
    # node in the graph (see graph_validate.validate / the _render_target contract).
    validate(graph, output_id)
    if output_id is None:
        output_id = _nodes_of(graph, "output")[0]["id"]
    out_path = paths.ANIM_DIR / f"{output_hash(job_id, segment, graph, output_id, output)}.mp4"
    url = f"/fluid/{out_path.name}"
    if out_path.exists():  # already rendered — nothing to stream, and no Dag to build
        render_cache.touch(out_path)
        if on_progress:
            d, fps = _clip_dims(segment, output)
            total = max(1, round(d * fps))
            on_progress(total, total, url)
        return url
    dag = _Dag(job_id, segment, graph, stem_audio_path, output)
    total = max(1, round(dag.duration * dag.fps))

    out_w = int(output.get("width", 0)) or None
    out_h = int(output.get("height", 0)) or None
    gh, gw = _grid_dims(dag)
    block_frames = max(1, round(block_seconds * dag.fps))
    # Unique per render (not just per output hash) so two concurrent renders of the
    # same output can't share — and rmtree — one scratch dir.
    render_id = out_path.stem + uuid.uuid4().hex[:8]
    scratch = paths.STREAM_DIR / render_id
    scratch.mkdir(parents=True, exist_ok=True)
    preview = scratch / "preview.mp4"
    enc = fluid.StreamEncoder(preview, dag.fps, gw, gh, out_w, out_h)  # opens on first write
    wrote = False
    # A NAMED generator, closed explicitly in the finally: a cancel/error mid-stream
    # returns out of the for-loop, and stream_blocks' own finally (branch pools,
    # decoder closers, partial-cache discards) must run NOW, not whenever the GC
    # finalizes the abandoned generator.
    gen = dag.stream_blocks(output_id, block_frames)
    try:
        for k, (_a, b, tot, block) in enumerate(gen):
            if should_cancel and should_cancel():
                return None
            enc.write(fluid.flatten(block))
            wrote = True
            if on_progress:
                on_progress(b, tot, f"/fluid/stream/{render_id}/preview.mp4?n={k}")
        enc.finalize()
        if wrote:  # promote the finished preview to the cache path
            shutil.move(str(preview), str(out_path))
            render_cache.evict(paths.ANIM_DIR)
        if on_progress:
            on_progress(total, total, url)
        return url
    finally:
        gen.close()  # run stream_blocks' cleanup (pools/decoders/partial caches)
        enc.close()  # no-op unless cancelled / errored mid-stream
        shutil.rmtree(scratch, ignore_errors=True)


# Back-compat alias (annotations + existing imports say `_Dag`).
_Dag = Dag
