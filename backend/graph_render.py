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
from .optional_deps import require_cv2
from .graph_common import (
    _PORT_SPECS,
    FLUID_FPS,
    LEGACY_GRID,
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
    resolve_node_curve,
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

    def __init__(self, job_id, segment, graph, stem_audio_path, output, pool=None):
        self.job_id = job_id
        self.segment = segment
        self.graph = graph
        self.stem_audio_path = stem_audio_path
        self.output = output or {}
        # The composition pool — read ONLY by the montage handler, which builds a
        # child Dag per extract through this same constructor (recursion is free).
        self.pool = pool
        self.nodes = {n["id"]: n for n in graph.get("nodes", []) if "id" in n}
        self.duration, self.fps = _clip_dims(segment, self.output)
        self._video: dict = {}
        self._emit: dict = {}
        self._params: dict = {}
        self._resolver = None  # lazily-built shared value resolver (one per render)
        self._block_fns: dict = {}  # node_id -> produce(a, b) (block streaming)
        self._block_memos: list = []  # every producer's one-block memo (drop_stale_blocks)
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
        self._block_memos.append(cache)
        return produce

    def drop_stale_blocks(self, a: int) -> None:
        """Free every memoized block that ended at or before frame `a`.

        The memo above exists so a diamond consumer pulling the same (a, b) twice
        computes it once — it only ever needs the CURRENT block. Nothing dropped it,
        though, so every producer held its last block until `close()`. A montage is
        where that bites: one 4K RGBA block per slot, all alive at once, is gigabytes of
        frames the playhead will never look at again (measured: 5.7 GB retained on a
        59 s chorus, RSS climbing linearly with the segment). Producers are contract-
        bound to be pulled contiguously front-to-back, so a block that ended at or
        before the new block's start can never be asked for again.

        Slot producers inside a montage are keyed in slot-LOCAL frames, so `a` compares
        across coordinate systems for them and drops more than it strictly must. That is
        deliberate and safe: a dropped block is RECOMPUTED on a re-pull (the key is
        cleared with the value, so nothing is ever served a stale None), never wrong.
        """
        for memo in self._block_memos:
            key = memo["key"]
            if key is not None and key[1] <= a:
                memo["key"] = None
                memo["val"] = None

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
                # Release the previous block's frames BEFORE allocating this one, so the
                # peak is one block deep, not one block per producer.
                self.drop_stale_blocks(a)
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


def stylize_describe(job_id, segment, graph, node_id, stem_audio_path, output=None) -> tuple:
    """Everything about a `stylize` node's inputs EXCEPT the pixels →
    `(src_id, ctrl_id, strength, fps)`.

    The cheap half of `stylize_source`. Opening a `Dag` and resolving one node's params is
    not what costs — the `dag.video()` calls are: measured on a 15 s segment at export
    grid, this is **0.1 ms against `stylize_source`'s 676 ms**.

    That gap is the whole point. The HD export used to call `stylize_source`, sample the
    rendered frames into a content key, and then throw every one of them away whenever the
    keyed clip already existed. Splitting the describe half out lets the caller build the
    key, check the cache, and only render on a miss.
    """
    with Dag(job_id, segment, graph, stem_audio_path, output or {}) as dag:
        src = _video_source(graph, node_id, "video")
        if src is None:
            raise ValueError("stylize node has no video input wired")
        ctrl = _video_source(graph, node_id, "control")
        strength = float(np.mean(dag._fx_params(dag.nodes[node_id])["strength"]))
        return src, ctrl, strength, dag.fps


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
# register it here; `Dag.video`/`emitters` and `_VIDEO_PRODUCERS` pick it up.


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


def _sim_blocks(dag: "Dag", params: dict):
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


def _fluid_video(dag: "Dag", node: dict) -> np.ndarray:
    return _sim_video(dag._fluid_video_params(node))


def _output_video(dag: "Dag", node: dict) -> np.ndarray:
    src = _video_source(dag.graph, node["id"], "video")
    if src is None:
        raise ValueError(f"output '{node['id']}' has no input to pass through")
    return dag.video(src)


def _fluid_emitters_h(dag: "Dag", node: dict) -> list:
    return dag._fluid_emitters(node)


def _output_emitters_h(dag: "Dag", node: dict) -> list:
    src = _video_source(dag.graph, node["id"], "video")
    return dag.emitters(src) if src else []


def _combine_emitters_h(dag: "Dag", node: dict) -> list:
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
# takes the native branch even when `gridCells` is set. That combination is exactly the
# HD render: it carries the export's `gridCells` for sim graphs, but a sim-FREE graph
# must render at the export's true native size — pinning it to a 216-cell sim grid would
# make "HD" LOOK WORSE than the 540p preview. The key is opt-in: no preview ever sends it,
# so no preview's `_grid_dims` or `output_hash` changes.
#
# BOTH HD paths set it (`song_render.output_from_export`). This comment used to say the
# whole-song export must NEVER set it, because one fixed-size encoder spans every segment —
# and that restriction is what made a master a nearest-neighbour upscale of a sim-grid
# render while the segment HD render of the same bars was native. `build_plan` now sizes
# that encoder from the largest grid in the plan instead of from a constant, and
# `iter_song_windows` upscales any smaller segment to match, so the restriction is gone.
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


def _grid_dims(dag: "Dag"):
    """The (gh, gw) frame size for a synthesised source. Normally the project output's
    SIMULATION grid (quality preset → 64/96/144 short-side cells — sims are expensive);
    but a graph with nothing to simulate (pure video/image/montage layers) renders at
    the output's NATIVE resolution, capped at `nativeShort` or _NATIVE_SHORT, so clips
    stay sharp. An explicit `gridCells` otherwise wins; no output settings falls back to
    the legacy square. Both HD paths send `nativeShort`, so both resolve a given segment to
    the same size — a test pins it (`test_both_hd_paths_use_one_output_dict`)."""
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
        # Auto-fit clamps, fractions of the frame height. Absent (older cards) = the
        # unclamped fit, byte-identical to before the fields existed — no version bump.
        size_min=float(d.get("sizeMin", 0.0)),
        size_max=float(d.get("sizeMax", 1.0)),
    )


def _asset_path(dag: "Dag", node: dict) -> str:
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


def _video_src0(d: dict, speed_full: np.ndarray, seg_start: float) -> float:
    """Source time (s) at segment-frame 0: `start` plus, for `sync="song"`, a pre-roll of
    `seg_start` seconds advanced at the initial speed (so a background clip stays roughly
    phase-continuous across segments). Variable speed is integrated segment-locally.

    (The old `montage_slot` special case — dropping the pre-roll for a card wired into
    a montage slot, RENDER_VERSION v12 — died with slot wiring: an extract's child
    composition renders in its OWN Dag whose segment IS the extract's window, so a
    sync="song" card inside it pre-rolls to the extract's true song position, which is
    now the CORRECT behavior rather than a footgun; leaf compositions are created
    sync="segment" and start at their in-point.)"""
    song_clock = d.get("sync", "song") == "song"
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


def _slideshow_items(dag: "Dag", node: dict) -> list:
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


def _montage_extracts(node: dict) -> list:
    """The montage's extracts as `(composition_id, span, in_point)` triples, in strip
    order. `span` (default 1) is how many effective cuts the extract swallows — a ×2
    extract plays through two intervals before the montage moves on. `in_point` is
    seconds into the child's local clock at the cut (subsumes specs/montage-resume:
    "resume where the previous occurrence left off" = set the in-point there)."""
    out = []
    for ex in (node.get("data") or {}).get("extracts", []):
        cid = (ex or {}).get("compositionId")
        if cid:
            out.append(
                (
                    cid,
                    max(1, int(ex.get("span", 1) or 1)),
                    max(0.0, float(ex.get("inPoint", 0.0) or 0.0)),
                )
            )
    return out


def _effective_cuts(trigger: "np.ndarray", d: dict, fps: int, nframes: int) -> list[int]:
    """The montage's effective cut frames: GATE rises (the trigger through the card's
    built-in hysteresis threshold, exactly like the slideshow) minus the individually
    DISABLED ones, unioned with the MANUAL breakpoints — sorted, deduped at frame
    granularity, clamped inside (0, nframes).

    `disabledCuts` stores composition-LOCAL seconds; an entry suppresses ANY cut
    within HALF A FRAME of it — gate or manual — so the match is deterministic and a
    gate cut that MOVED (threshold edit) re-enables itself. Suppressing manuals too
    matters (v17): a manual breakpoint sharing a disabled gate cut's frame used to
    resurrect the cut the user just clicked off, while the timeline (where the gate
    mark wins the collision pixel) showed it silenced — the render cut where the UI
    said it wouldn't. The editor's gestures keep such data rare (disabling sweeps
    same-frame manuals, placing a manual clears a stale disable), but saved projects
    carry it. Manual breakpoints are local seconds too (frontend mirror:
    lib/montageCuts.ts — the two must agree or the strip preview lies about where
    the render will cut)."""
    gate = _gate_curve(
        trigger, {"threshold": d.get("threshold", 0.5), "hysteresis": d.get("hysteresis", 0.1)}
    )
    rises = np.nonzero(np.diff(gate) > 0)[0] + 1  # frame index where each cut lands
    disabled = []
    for t in d.get("disabledCuts") or []:
        try:
            disabled.append(float(t) * fps)
        except (TypeError, ValueError):
            continue

    def silenced(frame: int) -> bool:
        return any(abs(frame - f) <= 0.5 for f in disabled)

    cuts = {int(r) for r in rises if not silenced(int(r))}
    for bp in d.get("manualBreakpoints") or []:
        try:
            f = int(round(float((bp or {}).get("t")) * fps))
        except (TypeError, ValueError):
            continue
        if not silenced(f):
            cuts.add(f)
    return sorted(c for c in cuts if 1 <= c < nframes)


def _montage_starts(cuts: list[int], spans: list[int]) -> list[int]:
    """Absolute start frame of each PLAYED extract. Frame 0 always starts extract 0;
    extract k swallows `spans[k]` effective cuts before the next starts. Cuts beyond
    the extracts are IGNORED — as is an extract whose starting cut never arrives — so
    the last STARTED extract HOLDS to the segment end, its clock running on (no
    restart). Extract k is active on [starts[k], starts[k+1])."""
    starts = [0]
    consumed = 0
    for span in spans[:-1]:  # the last extract never hands over — its span is moot
        consumed += span
        if consumed - 1 >= len(cuts):
            break  # not enough cuts left — the extract that just played holds
        starts.append(int(cuts[consumed - 1]))
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


def _window_sensitive(pool: dict | None, graph: dict, seen: set | None = None) -> bool:
    """Whether a composition's pixels depend on WHERE its window sits in the song:
    its closure (through nested extracts) holds a `signal` or `lyrics` node, or a
    `video`/`slideshow` card on the song clock (`sync=="song"`). A sensitive child
    renders over its true absolute window (two extracts of the same composition =
    two renders — decision 1); an INsensitive one (leaf videos, const/LFO
    generative) renders on the host window regardless of where its cut falls, so
    retiming the trigger reuses every cached extract."""
    seen = seen if seen is not None else set()
    for n in (graph or {}).get("nodes") or []:
        t = n.get("type")
        if t in ("signal", "lyrics"):
            return True
        if t in ("video", "slideshow") and (n.get("data") or {}).get("sync", "song") == "song":
            return True
    from .compositions import referenced_composition_ids

    for cid in referenced_composition_ids(graph):
        if cid in seen:
            continue
        seen.add(cid)
        child = (pool or {}).get(cid)
        if child and _window_sensitive(pool, child.get("graph") or {}, seen):
            return True
    return False


def _fit_frames(blk: np.ndarray, gh: int, gw: int) -> np.ndarray:
    """Bring a child composition's RGBA block to the HOST's frame size. Each
    composition resolves its own grid (`_grid_dims` over its own graph — a sim-free
    leaf renders native while a fluid child sims coarse), so the composition boundary
    is where sizes reconcile."""
    if blk.shape[1:3] == (gh, gw):
        return blk
    cv2 = require_cv2("montage extract resize")
    interp = cv2.INTER_AREA if blk.shape[1] > gh else cv2.INTER_LINEAR
    out = np.empty((blk.shape[0], gh, gw, 4), np.uint8)
    for i in range(blk.shape[0]):
        out[i] = cv2.resize(blk[i], (gw, gh), interpolation=interp)
    return out


# ── Generative source cards (waves / lightning / fire) ────────────────────────
# Each mirrors the backdrop pattern: `_fx_params` resolves the modulatable ports;
# the colour comes from a static `data.palette` preset or, if a `color` card is
# wired into the "color" input, that card's ramp overrides the preset.


def _wired_stops(dag: "Dag", node: dict):
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


def _gen_stops(dag: "Dag", node: dict, fallback: str) -> list:
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

# The shared-field renderer for each gen-sim kind, as an EXPLICIT table rather than
# `getattr(sources, kind)`. `kind` originates from a graph node's `type`, so the old form
# let a graph value index a module namespace — the one place in this codebase that
# happened. It also failed as an AttributeError from somewhere confusing rather than
# saying which kind was unknown, and it made the legal set ungreppable: nothing tied it to
# `_GEN_FALLBACK` above, which is the same list.
_GEN_MERGE_FN = {
    "waves": sources.waves,
    "lightning": sources.lightning,
    "aurora": sources.aurora,
    "rain": sources.rain,
    "clouds": sources.clouds,
}
assert set(_GEN_MERGE_FN) == set(_GEN_FALLBACK), "gen-sim kind tables disagree"


def _gen_points(dag: "Dag", node: dict):
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


def _gen_layer(dag: "Dag", node: dict, fallback: str) -> dict:
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


def _waves_block(dag: "Dag", node: dict):
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


def _fire_sources(dag: "Dag", node: dict):
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


def _fire_params(dag: "Dag", node: dict) -> dict:
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


def _fire_video(dag: "Dag", node: dict) -> np.ndarray:
    return _sim_video(_fire_params(dag, node))  # fluid path: frame cache + all


def _fire_block(dag: "Dag", node: dict):
    return _sim_blocks(dag, _fire_params(dag, node))


def _lightning_block(dag: "Dag", node: dict):
    # Ports stay FULL-length (the strike schedule is absolute-frame-keyed); the
    # bolt cache carries each strike's DBM geometry + glow stacks across blocks
    # so a flash spanning a block seam doesn't regrow its discharge.
    gh, gw = _grid_dims(dag)
    layers = [_gen_layer(dag, node, "electric")]
    cache: dict = {}

    def produce(a, b):
        return sources.lightning(b - a, gh, gw, dag.fps, layers, frame_offset=a, bolt_cache=cache)

    return produce


def _aurora_block(dag: "Dag", node: dict):
    gh, gw = _grid_dims(dag)
    layers = [_gen_layer(dag, node, "aurora")]  # full-length (drift integrates)

    def produce(a, b):
        return sources.aurora(b - a, gh, gw, dag.fps, layers, frame_offset=a)

    return produce


def _rain_block(dag: "Dag", node: dict):
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


def _clouds_block(dag: "Dag", node: dict):
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


def _gen_emitters_h(dag: "Dag", node: dict) -> list:
    t = node.get("type")
    e = {"_kind": t, "layer": _gen_layer(dag, node, _GEN_FALLBACK[t])}
    if t in ("waves", "rain"):
        src = _video_source(dag.graph, node["id"], "video")
        if src:
            e["base_src"] = src
    return [e]


def _fire_emitters_h(dag: "Dag", node: dict) -> list:
    emitters, fire_cfg, _ = _fire_sources(dag, node)
    return [dict(e, _fire=fire_cfg) if i == 0 else e for i, e in enumerate(emitters)]


def _gen_merge_split(dag: "Dag", node: dict):
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
        out[i] = _warp_frame(
            frames[i], (sy + cy).astype(np.float32), (sx + cx).astype(np.float32), edge
        )
    return out


# scipy mode -> the cv2 border that reproduces it. `mirror` is REFLECT_101 (abc|ba), NOT
# REFLECT (abc|cb) — picking the wrong one costs ~5.6 levels of mean error, which looks like
# a rounding difference until you plot it.
_CV_BORDER = {
    "constant": "BORDER_CONSTANT",
    "mirror": "BORDER_REFLECT_101",
    "grid-wrap": "BORDER_WRAP",
}

# Resolved ONCE, not per frame. `_warp_frame` runs per frame and can run inside the combine
# branch pool (`ThreadPoolExecutor`, :1581), and a per-call `import` in that position takes
# the module lock on every frame from every thread for a result that never changes.
# `None` = opencv is absent and the scipy fallback stands; `False` = not yet looked up.
_cv2_mod: object = False


def _cv2_or_none():
    global _cv2_mod
    if _cv2_mod is False:
        try:
            import cv2

            _cv2_mod = cv2
        except ImportError:  # pragma: no cover — exercised only without opencv installed
            _cv2_mod = None
    return _cv2_mod


def _warp_frame(frame: np.ndarray, mapy: np.ndarray, mapx: np.ndarray, edge: str) -> np.ndarray:
    """One (H,W,C) uint8 frame resampled at (mapy, mapx), bilinear, `edge` boundary.

    `cv2.remap` does all C channels in ONE vectorised call; the scipy path it replaced ran
    `map_coordinates` per channel, which at 1080p RGBA was 92 of the 105 ms each frame cost —
    the single most expensive per-frame operation on the HD export path. Measured 1080p RGBA:
    98 ms -> 0.4 ms.

    OpenCV is a pinned requirement but a soft dependency elsewhere (`optional_deps`), and the
    Transform card used to work without it, so the scipy path stays as a fallback rather than
    turning a missing wheel into a broken card. The two agree to +/-1 (see below), and the
    render cache is per-install, so one machine consistently takes one path.
    """
    cv2 = _cv2_or_none()
    if cv2 is None:  # pragma: no cover — exercised only without opencv installed
        out = np.empty_like(frame)
        for ch in range(frame.shape[2]):
            warped = map_coordinates(
                frame[:, :, ch].astype(np.float32),
                np.stack([mapy, mapx]),
                order=1,
                mode=edge,
                cval=0.0,
            )
            out[:, :, ch] = np.clip(warped, 0, 255).astype(np.uint8)
        return out

    warped = cv2.remap(
        frame,
        mapx,
        mapy,
        cv2.INTER_LINEAR,
        borderMode=getattr(cv2, _CV_BORDER[edge]),
        borderValue=0,
    )
    if edge == "constant":
        # scipy's `constant` returns cval for ANY coordinate outside [0, n-1] — a hard
        # cutoff. cv2 instead blends the edge pixel against a virtual border pixel, so a
        # sample half a pixel out reads 100 where scipy reads 0. That is a one-pixel band,
        # invisible in a mean and up to 200 levels wide in it. Restore the cutoff.
        h, w = frame.shape[:2]
        warped[(mapy < 0) | (mapy > h - 1) | (mapx < 0) | (mapx > w - 1)] = 0
    return warped


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
    cv2 = require_cv2("the Extract card")
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


def _echo_static(d: dict) -> str:
    """The echo card's trail memory: ghost (EMA afterimages), bright (decayed max),
    or dark (bright's mirror — shadow trails)."""
    mode = d.get("mode", "ghost")
    return mode if mode in ("ghost", "bright", "dark") else "ghost"


def _colorgrade_static(d: dict) -> tuple:
    """The Color Grade card's non-modulatable fields: mode, thermal map, swatches."""
    mode = d.get("mode", "thermal")
    if mode not in ("thermal", "duotone", "neon"):
        mode = "thermal"
    cmap = d.get("map", "turbo")
    if cmap not in look_fx._THERMAL_MAPS:
        cmap = "turbo"
    return mode, cmap, d.get("colorA", "#0b1030"), d.get("colorB", "#ff5ac8")


def _colorgrade_setup(dag: "Dag", node: dict) -> tuple:
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
    "combine": _whole_from_block("combine"),
    "lyrics": _whole_from_block("lyrics"),
    "text": _whole_from_block("text"),
    "image": _whole_from_block("image"),
    "slideshow": _whole_from_block("slideshow"),
    "montage": _whole_from_block("montage"),
    "video": _whole_from_block("video"),
    "backdrop": _whole_from_block("backdrop"),
    "transform": _whole_from_block("transform"),
    "stylize": _whole_from_block("stylize"),
    "extract": _whole_from_block("extract"),
    "echo": _whole_from_block("echo"),
    "colorgrade": _whole_from_block("colorgrade"),
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
def _fluid_block(dag: "Dag", node: dict):
    return _sim_blocks(dag, dag._fluid_video_params(node))


def _output_block(dag: "Dag", node: dict):
    src = _video_source(dag.graph, node["id"], "video")
    if src is None:
        raise ValueError(f"output '{node['id']}' has no input to pass through")
    return dag._block_producer(src)


def _combine_block(dag: "Dag", node: dict):
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
        fn = _GEN_MERGE_FN.get(kind)
        if fn is None:  # a card type that grew a `_kind` but no shared-field renderer
            raise ValueError(
                f"combine(merge) got gen kind '{kind}', which has no shared-field "
                f"renderer (known: {', '.join(sorted(_GEN_MERGE_FN))})"
            )
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


def _lyrics_block(dag: "Dag", node: dict):
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


def _text_block(dag: "Dag", node: dict):
    """The TEXT card — a free-typed caption (the Instagram-sticker use), rendered
    through the LYRICS machinery (same wrap/fit/outline/colour pipeline, same
    size clamps) as ONE synthetic line covering the whole window: always on,
    timed to nothing, its text living in the card's own data (so it hashes with
    the graph — no segment lyric lines involved). `reveal` is forced to "line":
    the word-by-word write-on only means something against a sung line."""
    d = node.get("data", {})
    gh, gw = _grid_dims(dag)
    seg_start = float(dag.segment.get("start", 0.0))
    seg_end = float(dag.segment.get("end", seg_start))
    text = str(d.get("text") or "").strip()
    lines = [{"t0": seg_start - 1.0, "t1": seg_end + 1.0, "text": text}] if text else []
    params = dag._lyrics_params(node)  # opacity + fill/outline colour arrays
    kw = dict(lines=lines, seg_start=seg_start, **_lyrics_static(d))
    kw["reveal"] = "line"

    def produce(a, b):
        return sources.lyrics(
            b - a, gh, gw, dag.fps, frame_offset=a, **kw, **{k: v[a:b] for k, v in params.items()}
        )

    return produce


def _image_block(dag: "Dag", node: dict):
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


def _slideshow_block(dag: "Dag", node: dict):
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


def _montage_cut_frames(dag: "Dag", node: dict, d: dict, trigger, nframes: int) -> list[int]:
    """The montage's effective cut frames at the RENDER fps — computed at the
    SCHEDULE fps when the output dict carries one (`schedule_fps`, the project's
    editing fps — song_render.export_with_schedule sets it on HD exports whose fps
    differs). Gate-rise detection is sampling-dependent: a 30fps export once found
    one more rise than the 24fps editor timeline had shown, so every later extract
    played one slot early and the export "wasn't aligned like the montage". Cuts are
    therefore detected on the trigger resolved at the EDITOR's rate — the same
    `resolve_node_curve` the timeline's /resolve uses, so the rise set is identical
    by construction — then converted to render-fps frames as seconds."""
    sched = float((dag.output or {}).get("schedule_fps") or 0.0)
    if not sched or abs(sched - dag.fps) < 1e-6:
        return _effective_cuts(trigger, d, dag.fps, nframes)
    n_s = max(1, round(dag.duration * sched))
    b = ((d.get("ports") or {}).get("trigger") or {}).get("binding") or {}
    if b.get("kind") == "node" and b.get("nodeId"):
        r = resolve_node_curve(
            dag.job_id, dag.segment, dag.graph, b["nodeId"], dag.stem_audio_path, fps=int(sched)
        )
        trig_s = np.asarray(r.get("curve") or [], np.float32)
        if len(trig_s) < n_s:  # defensive: a short resolve pads flat (no phantom rise)
            trig_s = np.pad(trig_s, (0, n_s - len(trig_s)))
    else:
        trig_s = np.zeros(n_s, np.float32)  # no wired trigger: manual breakpoints only
    cuts_s = _effective_cuts(trig_s, d, sched, n_s)
    conv = sorted({int(round(c / sched * dag.fps)) for c in cuts_s})
    return [c for c in conv if 1 <= c < nframes]


def _montage_block(dag: "Dag", node: dict):
    """The montage switcher: extract k plays its CHILD COMPOSITION's output, re-timed
    so local frame 0 lands on the cut. Each extract owns a private child `Dag` built
    over the extract's window (the recursion — a child montage goes through this same
    handler), so exclusivity holds by construction, releasing a played-out extract is
    `child.close()`, and two extracts of one shared composition are two Dags with two
    windows (decision 1). The ONLY implementation: the whole-clip entry derives via
    `_whole_from_block` — the cross-scan state (the lazy `built` dict) is created
    fresh per scan, so a single produce(0, n) IS the whole clip, the same argument
    that lets `combine` derive. Extracts are sequential and never revisited, so every
    child producer still sees contiguous front-to-back ranges from 0 (the
    FluidClip/echo/rain contract); an in-point advances the child's lead-in in block
    chunks to honour it. Montage is deliberately NOT in `_field_nodes`: a fluid
    inside a child re-simulates per extract window on the local clock (the `layer`
    continuity rule — root-composition fields only)."""
    extracts = _montage_extracts(node)
    if not extracts:
        raise ValueError(f"montage '{node['id']}' has no extracts")
    d = node.get("data", {})
    gh, gw = _grid_dims(dag)
    params = dag._fx_params(node)  # {opacity, trigger} full-segment arrays
    nframes = max(1, round(dag.duration * dag.fps))
    cuts = _montage_cut_frames(dag, node, d, params["trigger"], nframes)
    starts = _montage_starts(cuts, [span for _, span, _ in extracts])
    bounds = np.array(starts + [nframes])

    # One frame-cache entry per extract, each comfortably under the per-entry ceiling,
    # but the SET is what has to survive: 21 extracts of a 4K montage total far past
    # the budget, so they'd evict each other in order and nothing would ever be
    # re-read. A running allowance, spent extract by extract in play order (cache HITS
    # deduct too — an existing entry occupies budget, and deducting it keeps the cached
    # prefix the SAME set across runs): writes stop when it runs out, so an oversized
    # montage still caches its leading extracts. The old all-or-nothing gate cached
    # NOTHING for a 104-second 38-extract montage, and every preview re-rendered every
    # child from scratch.
    allowance = {"left": fluid_cache.set_budget(), "dry": False}

    def _extract_producer(k: int, length: int):
        """`(produce_local(a, b) -> RGBA frames, child_dag_or_None)` for one extract.

        Served straight from the extract frame cache when it holds enough frames (no
        child Dag, no decoder, no sim), else a child Dag over the extract's context
        window, teed into the cache. A window-INsensitive child keys on the HOST
        window (retiming the trigger reuses every cached extract — the old slot-cache
        behavior); a sensitive child keys on its true absolute window, so the same
        composition at two windows renders twice, which is what audio-reactive
        content means."""
        cid, _span, in_point = extracts[k]
        comp = (dag.pool or {}).get(cid)
        if comp is None:
            raise ValueError(f"montage extract references a missing composition '{cid}'")
        child_graph = comp.get("graph") or {}
        from .compositions import final_output_id

        target = final_output_id(comp)
        if target is None:
            raise ValueError(f"composition '{comp.get('name') or cid}' has no output to render")
        validate(child_graph, target)

        seg_start = float(dag.segment.get("start", 0.0))
        abs_start = seg_start + int(bounds[k]) / dag.fps
        if _window_sensitive(dag.pool, child_graph):
            # True absolute window, host signals/lyrics: the contextual time base.
            child_seg = {
                **dag.segment,
                "start": abs_start - in_point,
                "end": seg_start + int(bounds[k + 1]) / dag.fps,
            }
        else:
            # Window-independent content renders on the HOST window (extended by the
            # in-point so the lead-in exists), so its cache key (below) moves only
            # with the child and the in-point — never with the trigger.
            child_seg = dict(dag.segment)
            if in_point > 0:
                child_seg["end"] = float(dag.segment.get("end", 0.0)) + in_point
        child = Dag(
            dag.job_id, child_seg, child_graph, dag.stem_audio_path, dag.output, pool=dag.pool
        )
        child_nframes = max(1, round(child.duration * child.fps))
        # The extract's local frame a maps to child frame a + offset (the in-point).
        # Clamped so the read window fits the child — past-the-end would be blank
        # anyway (v14), and a deterministic clamp beats a silent black tail.
        offset = min(int(round(in_point * dag.fps)), max(0, child_nframes - length))
        total = min(offset + length, child_nframes)

        h = output_hash(dag.job_id, child_seg, child_graph, target, dag.output, dag.pool)
        key = f"comp-{h}-{gh}x{gw}"
        cached = fluid_cache.load(key)
        if cached is not None and cached.shape[1:] == (gh, gw, 4) and len(cached) >= total:
            allowance["left"] -= int(cached.nbytes)  # a hit occupies budget too
            child.close()  # nothing to render — frames come off the cache
            return (lambda a, b: np.ascontiguousarray(cached[offset + a : offset + b])), None
        dag._closers.append(child.close)  # released early by _release; close is idempotent
        inner = child._block_producer(_render_target(child_graph, child.nodes, target))
        nbytes = int(total) * gh * gw * 4
        cacheable = nbytes <= allowance["left"]
        if cacheable:
            allowance["left"] -= nbytes
        elif not allowance["dry"]:  # no silent cap: say once where caching stopped
            allowance["dry"] = True
            log.info(
                "montage '%s': extract cache budget spent at extract %d/%d — "
                "the tail renders uncached",
                node["id"],
                k + 1,
                len(extracts),
            )
        mm, finalize, discard = (
            fluid_cache.frame_writer(key, (total, gh, gw, 4)) if cacheable else (None, None, None)
        )
        if mm is not None:
            # `discard` lives until Dag.close(): releasing a finished extract must not
            # delete the cache it just wrote; a cancelled stream drops the partial file.
            dag._closers.append(discard)
        state = {"next": 0}  # the child-local cursor (contiguous-from-0 contract)

        def _pull(a2: int, b2: int) -> np.ndarray:
            child.drop_stale_blocks(a2)  # peak memory: one block deep, per ACTIVE child
            blk = _fit_frames(_to_rgba(inner(a2, b2)), gh, gw)
            if mm is not None:
                mm[a2:b2] = blk
                if b2 >= total:
                    finalize()
            return blk

        def produce_local(a: int, b: int) -> np.ndarray:
            # Advance the in-point lead-in once, in block-sized chunks: a stateful
            # child producer (fluid/echo) must be pulled from frame 0.
            step = max(1, b - a)
            while state["next"] < offset + a:
                n2 = min(offset + a, state["next"] + step)
                _pull(state["next"], n2)
                state["next"] = n2
            b2 = min(offset + b, child_nframes)
            blk = _pull(offset + a, b2)
            state["next"] = b2
            if b2 - offset < b - a:  # clamped at the child's end — pad blank (v14)
                pad = np.zeros((b - a, gh, gw, 4), np.uint8)
                pad[: len(blk)] = blk
                blk = pad
            return blk

        return produce_local, child

    # Built on FIRST USE, not up front: eagerly opening every extract's cache writer
    # before frame 0 is how the >5min temp-file reaper once deleted later slots' files
    # mid-render; lazy also means a child's decoders open when its extract starts.
    built: dict = {}

    def _extract(k: int):
        if k not in built:
            built[k] = _extract_producer(k, int(bounds[k + 1]) - int(bounds[k]))
        return built[k][0]

    def _release(k: int) -> None:
        """Close a played-out extract's child Dag. Extracts are sequential and never
        revisited; `Dag.close` is idempotent, and a closed VideoClip re-opens itself
        on a surprise re-pull (slower, never wrong)."""
        entry = built.get(k)
        if not entry or entry[1] is None:
            return
        entry[1].close()
        built[k] = (entry[0], None)

    def produce(a, b):
        out = np.zeros((b - a, gh, gw, 4), np.uint8)
        # A block may straddle one or more cuts: split it per extract bucket.
        k0 = int(np.searchsorted(bounds, a, side="right")) - 1
        k1 = int(np.searchsorted(bounds, b - 1, side="right")) - 1
        for k in list(built):
            if k < k0:  # the playhead has passed it for good
                _release(k)
        for k in range(k0, k1 + 1):
            s, e = max(a, int(bounds[k])), min(b, int(bounds[k + 1]))
            if e > s:
                r = int(bounds[k])
                out[s - a : e - a] = _extract(k)(s - r, e - r)  # already RGBA
        return sources.apply_video_opacity(out, params["opacity"][a:b])

    return produce


def _video_block(dag: "Dag", node: dict):
    gh, gw = _grid_dims(dag)
    d = node.get("data", {})
    ap, static = _asset_path(dag, node), _video_static(d)
    params = dag._fx_params(node)  # {opacity, speed} full-segment arrays
    speed_full = params["speed"]
    # Integrate speed over the WHOLE segment up front so the source-time origin stays
    # continuous across stream blocks — and hold ONE persistent decoder across them
    # (mirrors the fluid producer's resumable FluidClip) instead of spawning a fresh
    # seek+decode ffmpeg per block. The dag reaps it on stream end/cancel.
    src_base = _video_src0(d, speed_full, float(dag.segment.get("start", 0.0)))
    src_t = sources.video_src_times(len(speed_full), dag.fps, src_base, speed_full)
    clip = sources.VideoClip(gh, gw, dag.fps, asset_path=ap, **static)
    dag._closers.append(clip.close)

    def produce(a, b):
        return sources.apply_video_opacity(clip.frames(src_t[a:b]), params["opacity"][a:b])

    return produce


def _backdrop_block(dag: "Dag", node: dict):
    gh, gw = _grid_dims(dag)
    params = dag._backdrop_params(node)  # {opacity, r, g, b} sliced per block

    def produce(a, b):
        return sources.backdrop(
            b - a, gh, gw, frame_offset=a, **{k: v[a:b] for k, v in params.items()}
        )

    return produce


def _transform_block(dag: "Dag", node: dict):
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


def _stylize_block(dag: "Dag", node: dict):
    """AI Stylize (video->video): decode the generated clip (`data.assetUrl`) through a
    persistent VideoClip, or pass the upstream producer through when nothing is generated
    yet. Now the ONLY stylize handler — the whole-clip entry derives from it. The old
    `_stylize_video` decoded via `sources.video` instead, so the two paths ran different
    decoders and were held in agreement only by test_card_impact's tolerance."""
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


def _extract_block(dag: "Dag", node: dict):
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


def _echo_block(dag: "Dag", node: dict):
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


def _colorgrade_block(dag: "Dag", node: dict):
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
    "text": _text_block,
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


def render(
    job_id: str,
    segment: dict,
    graph: dict,
    stem_audio_path: Callable,
    output: dict | None = None,
    output_id: str | None = None,
    *,
    pool: dict | None = None,
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
    h = output_hash(job_id, segment, graph, output_id, output, pool)
    out_path = paths.ANIM_DIR / f"{h}.mp4"
    url = f"/fluid/{out_path.name}"
    if out_path.exists():
        render_cache.touch(out_path)  # keep this hot clip from aging out (LRU)
        return url

    # `with`: the sync path opens the same decoders the streaming path does (slideshow /
    # video / stylize register clip.close on the DAG), and used to leak every one of them.
    with Dag(job_id, segment, graph, stem_audio_path, output, pool=pool) as dag:
        src = _render_target(graph, dag.nodes, output_id)  # output OR direct producer preview
        frames = dag.video(src)  # RGBA stays RGBA — render_mp4 composites it over black
        out_w = int(output.get("width", 0)) or None
        out_h = int(output.get("height", 0)) or None
        fluid.render_mp4(frames, dag.fps, out_path, out_w, out_h, crf=fluid.crf_from_output(output))
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
    pool: dict | None = None,
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
    h = output_hash(job_id, segment, graph, output_id, output, pool)
    out_path = paths.ANIM_DIR / f"{h}.mp4"
    url = f"/fluid/{out_path.name}"
    if out_path.exists():  # already rendered — nothing to stream, and no Dag to build
        render_cache.touch(out_path)
        if on_progress:
            d, fps = _clip_dims(segment, output)
            total = max(1, round(d * fps))
            on_progress(total, total, url)
        return url
    dag = Dag(job_id, segment, graph, stem_audio_path, output, pool=pool)
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
    # opens on first write; the CRF rides in the output settings (see fluid.crf_from_output)
    enc = fluid.StreamEncoder(
        preview, dag.fps, gw, gh, out_w, out_h, crf=fluid.crf_from_output(output)
    )
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
            enc.write(block)  # RGBA goes straight in — ffmpeg composites it
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
