"""Value modulators + points cards: every node type that produces a 0..1 curve
(signal / LFO / noise / shaper / math), the colour-card resolver, and the points
pipeline (parametric layouts + transforms -> emitter source specs, spec 02).

`_make_value_resolver` is the shared memoized entry point: `build_params` (fluid
ports), `_Dag` (FX/source-card ports) and the Scope card's `resolve_node_curve`
all resolve through it."""

from __future__ import annotations

import logging
from typing import Callable

import numpy as np

from . import fluid, signals
from .animation_params import COLOR_PARAMS, SOURCE_STATIC_KEYS
from .graph_common import _POINT_CAP, FLUID_FPS, _video_source

log = logging.getLogger("kaika.graph")


def _source_statics(static: dict) -> dict:
    """The static source-nested params (color, path, toggles) from the fluid card."""
    return {k: static[k] for k in SOURCE_STATIC_KEYS if k in static}


def _sample_gradient(stops: list, pos):
    """Sample colour `stops` ([{t, color hex}]) at `pos` (0..1 scalar or array) -> per-
    channel r/g/b (matching pos's shape). Linear between stops, clamped at the ends."""
    if not stops:
        return 0.0, 0.0, 0.0
    s = sorted(stops, key=lambda x: float(x.get("t", 0.0)))
    ts = np.array([float(x.get("t", 0.0)) for x in s], np.float32)
    cols = np.array([fluid._hex_rgb(x.get("color", "#000000")) for x in s], np.float32)
    p = np.clip(pos, 0.0, 1.0)
    return (np.interp(p, ts, cols[:, 0]), np.interp(p, ts, cols[:, 1]), np.interp(p, ts, cols[:, 2]))


def _resolve_node_color(graph: dict, node: dict, port: str, nodes: dict, resolve_source) -> dict:
    """The colour params (r/g/b/intensity/opacity) from a `color` card wired into `node`'s
    `port` input. Each port is a scalar (const) or per-frame array (node binding), exactly
    like a fluid param. The card has three modes: `swatch` / `rgb` read r/g/b directly;
    `gradient` samples its colour stops at the modulatable `position`. Returns ``{}`` when
    nothing is wired. Shared by the fluid dye colour (port "color") and the lyrics
    fill/outline colour inputs ("fillColor" / "outlineColor")."""
    cid = _video_source(graph, node["id"], port)
    color_node = nodes.get(cid) if cid else None
    if color_node is None or color_node.get("type") != "color":
        return {}
    data = color_node.get("data", {})
    ports = data.get("ports", {})

    def port_val(key):
        pmin, pmax, pdef = COLOR_PARAMS[key]
        b = (ports.get(key) or {}).get("binding")
        if not b or b.get("kind") == "const":
            return float(b["value"]) if b else pdef
        lo, hi = float(b.get("lo", pmin)), float(b.get("hi", pmax))
        return lo + (hi - lo) * resolve_source(b["nodeId"])  # 0..1 curve -> native array

    out = {"intensity": port_val("intensity"), "opacity": port_val("opacity")}
    if data.get("mode") == "gradient":
        out["r"], out["g"], out["b"] = _sample_gradient(data.get("stops", []), port_val("position"))
    else:  # swatch / rgb: per-channel ports
        out["r"], out["g"], out["b"] = port_val("r"), port_val("g"), port_val("b")
    # numpy arrays -> lists for the simulate() params dict; scalars pass through.
    return {k: (v.tolist() if hasattr(v, "tolist") else v) for k, v in out.items()}


def _signal_curve(
    node: dict,
    job_id: str,
    start: float,
    end: float,
    nframes: int,
    signals_by_id: dict,
    stem_audio_path: Callable,
) -> np.ndarray:
    """A signal node -> its 0..1 curve, length nframes, from posted segment.signals.

    Reuses `signals.extract` at the fluid fps so no resample is needed (the safety
    net `fluid._series` snaps to exact length). A missing/deleted signal degrades
    to a flat 0 (01 §3.7) rather than failing the render.
    """
    sig = signals_by_id.get(node.get("data", {}).get("signalId"))
    if sig is None:
        return np.zeros(nframes, np.float32)  # deleted signal — silent (01 §3.7)
    stem_path = stem_audio_path(job_id, sig["stemKey"])
    if stem_path is None:
        # The signal exists but its stem doesn't resolve (renamed/missing stem) —
        # a real misconfiguration, not a deleted signal. Degrade to flat 0 so the
        # render still completes, but log it rather than failing silently.
        log.warning(
            "signal '%s' references unresolved stem '%s' (job %s) — using flat 0",
            sig.get("id"),
            sig.get("stemKey"),
            job_id,
        )
        return np.zeros(nframes, np.float32)
    d = signals.extract(
        str(stem_path),
        start,
        end,
        sig["minHz"],
        sig["maxHz"],
        feature=sig.get("feature", "energy"),
        fps=FLUID_FPS,
        attack=sig.get("attack", 5.0),
        release=sig.get("release", 250.0),
        invert=sig.get("invert", False),
        gamma=sig.get("gamma", 1.0),
        gain=sig.get("gain", 1.0),
        offset=sig.get("offset", 0.0),
        threshold=sig.get("threshold", 0.0),
    )
    curve = np.asarray(d["curve"], np.float32)
    return fluid._series(curve, nframes)


def _lfo_curve(data: dict, nframes: int, fps: int) -> np.ndarray:
    """An LFO node -> its 0..1 waveform, length nframes. Tempo-free: the rate is in
    cycles-per-clip or Hz, so the curve is deterministic (no audio decode)."""
    shape = data.get("shape", "sine")
    phase = float(data.get("phase", 0.0))
    duty = float(data.get("duty", 0.5))
    rate = float(data.get("rate", 4.0))
    duration = max(1, nframes) / float(fps or 1)
    cycles = rate * duration if data.get("rateMode") == "hz" else rate
    t = np.linspace(0.0, 1.0, nframes, endpoint=False, dtype=np.float32)
    ph = np.mod(t * cycles + phase, 1.0)
    if shape == "triangle":
        y = np.where(ph < 0.5, ph * 2.0, 2.0 - ph * 2.0)
    elif shape == "saw":
        y = ph
    elif shape == "square":
        y = np.where(ph < duty, 1.0, 0.0)
    else:  # sine
        y = 0.5 + 0.5 * np.sin(ph * 2.0 * np.pi)
    return np.clip(y.astype(np.float32), 0.0, 1.0)


def _noise_curve(data: dict, nframes: int, fps: int) -> np.ndarray:
    """A noise node -> smooth fractal value-noise, length nframes. Seeded only from
    `seed` (never wall-clock) so the render cache stays stable."""
    seed = int(data.get("seed", 1))
    octaves = int(max(1, min(4, round(float(data.get("octaves", 2))))))
    rate = float(data.get("rate", 1.0))
    duration = max(1, nframes) / float(fps or 1)
    acc = np.zeros(nframes, np.float32)
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        pts = max(2, int(round(rate * duration * (2**o))) + 1)
        ctrl = np.random.default_rng(seed + o * 1013).random(pts).astype(np.float32)
        xs = np.linspace(0.0, pts - 1, nframes, dtype=np.float32)
        i = np.floor(xs).astype(int)
        i2 = np.minimum(i + 1, pts - 1)
        f = xs - i
        f = f * f * (3.0 - 2.0 * f)  # smoothstep
        acc += (ctrl[i] * (1.0 - f) + ctrl[i2] * f) * amp
        norm += amp
        amp *= 0.5
    return np.clip(acc / (norm or 1.0), 0.0, 1.0)


def _shaper_curve(base: np.ndarray, data: dict, fps: int) -> np.ndarray:
    """A shaper node -> optionally delay its input in time, then re-curve it via the
    EXACT studio shaping order (`signals.shape`) and remap into [lo, hi]. The delay
    slides the signal later by `delay` ms; the exposed head is zero-padded, or wraps
    the tail back to the head when `wrap` is set."""
    base = np.clip(np.asarray(base, np.float32), 0.0, 1.0)
    shift = int(round(float(data.get("delay", 0.0)) / 1000.0 * fps))
    n = len(base)
    if shift > 0 and n:
        if data.get("wrap"):
            base = np.roll(base, shift)  # tail wraps back to the head
        elif shift < n:
            base = np.concatenate([np.zeros(shift, np.float32), base[:-shift]])
        else:
            base = np.zeros(n, np.float32)  # shifted entirely off the clip
    y = signals.shape(
        base,
        attack=float(data.get("attack", 5.0)),
        release=float(data.get("release", 250.0)),
        invert=bool(data.get("invert", False)),
        gamma=float(data.get("gamma", 1.0)),
        gain=float(data.get("gain", 1.0)),
        offset=float(data.get("offset", 0.0)),
        threshold=float(data.get("threshold", 0.0)),
        fps=fps,
    )
    lo, hi = float(data.get("lo", 0.0)), float(data.get("hi", 1.0))
    return np.clip(lo + (hi - lo) * y, 0.0, 1.0).astype(np.float32)


def _math_combine(curves: list, op: str, mix: float, nframes: int) -> np.ndarray:
    """Fold value curves with `op` (elementwise), clamp 0..1. `mix` crossfades the
    first two inputs for op "mix"; missing inputs are flat 0."""
    if not curves:
        return np.zeros(nframes, np.float32)
    if op == "mix":
        a = curves[0]
        b = curves[1] if len(curves) > 1 else np.zeros(nframes, np.float32)
        out = a * (1.0 - mix) + b * mix
    else:
        out = curves[0].astype(np.float32).copy()
        for c in curves[1:]:
            if op == "add":
                out = out + c
            elif op == "subtract":
                out = out - c
            elif op == "max":
                out = np.maximum(out, c)
            elif op == "min":
                out = np.minimum(out, c)
            else:  # multiply (default)
                out = out * c
    return np.clip(out.astype(np.float32), 0.0, 1.0)


def _gate_curve(base: np.ndarray, data: dict) -> np.ndarray:
    """A gate node -> a clean 0/1 curve via HYSTERESIS thresholding: the gate arms
    (goes 1) when the input crosses `threshold + hysteresis/2` and re-arms (drops
    to 0) only below `threshold - hysteresis/2` — so a signal hovering around the
    threshold can't flicker. `invert` flips the result. The stateful sweep is what
    a plain comparison can't give you; the imagegen card reuses this to derive
    stable rising-edge triggers."""
    base = np.clip(np.asarray(base, np.float32), 0.0, 1.0)
    threshold = float(data.get("threshold", 0.5))
    hyst = max(0.0, float(data.get("hysteresis", 0.1)))
    hi = min(1.0, threshold + hyst / 2.0)
    lo = max(0.0, threshold - hyst / 2.0)
    out = np.zeros(len(base), np.float32)
    state = 0.0
    for i, v in enumerate(base):
        if state == 0.0 and v >= hi:
            state = 1.0
        elif state == 1.0 and v < lo:
            state = 0.0
        out[i] = state
    if data.get("invert"):
        out = 1.0 - out
    return out


def _make_value_resolver(graph, nodes, job_id, start, end, nframes, fps, signals_by_id, stem_audio_path):
    """A memoized value resolver: `node_id` -> 0..1 curve (length nframes),
    type-dispatched (signal / lfo / noise / shaper / math) and recursing through value
    inputs. A zeros placeholder is seeded before recursing so a (validate-rejected)
    cycle degrades to flat 0 instead of looping forever. Shared by `build_params`
    (fluid ports) and `_Dag` (FX-card ports)."""
    cache: dict[str, np.ndarray] = {}

    def resolve_source(node_id: str) -> np.ndarray:
        if node_id in cache:
            return cache[node_id]
        cache[node_id] = np.zeros(nframes, np.float32)  # cycle guard + default
        node = nodes.get(node_id)
        if node is None:
            return cache[node_id]
        t = node.get("type")
        data = node.get("data", {})
        if t == "signal":
            out = _signal_curve(node, job_id, start, end, nframes, signals_by_id, stem_audio_path)
        elif t == "lfo":
            out = _lfo_curve(data, nframes, fps)
        elif t == "noise":
            out = _noise_curve(data, nframes, fps)
        elif t == "shaper":
            src = _video_source(graph, node_id, "in")
            base = resolve_source(src) if src else np.zeros(nframes, np.float32)
            out = _shaper_curve(base, data, fps)
        elif t == "gate":
            src = _video_source(graph, node_id, "in")
            base = resolve_source(src) if src else np.zeros(nframes, np.float32)
            out = _gate_curve(base, data)
        elif t == "scope":
            # a pure monitor: passes its input value through unchanged.
            src = _video_source(graph, node_id, "in")
            out = resolve_source(src) if src else np.zeros(nframes, np.float32)
        elif t == "math":
            ins = []
            for pid in data.get("inputs", []):
                src = _video_source(graph, node_id, pid)
                ins.append(resolve_source(src) if src else np.zeros(nframes, np.float32))
            out = _math_combine(ins, data.get("op", "multiply"), float(data.get("mix", 0.5)), nframes)
        else:
            out = np.zeros(nframes, np.float32)
        cache[node_id] = out
        return out

    return resolve_source


def resolve_node_curve(job_id, segment, graph, node_id, stem_audio_path, fps: int = 30) -> dict:
    """Resolve ONE value node's 0..1 curve over the segment — for the Scope card's live
    view. Reuses the executor's value resolver, so it shows exactly what the node feeds
    into the graph. Returns ``{curve, times, fps}``; a missing node degrades to flat 0."""
    start, end = float(segment.get("start", 0.0)), float(segment.get("end", 0.0))
    nframes = max(1, round((end - start) * fps))
    nodes = {n["id"]: n for n in graph.get("nodes", []) if "id" in n}
    signals_by_id = {s["id"]: s for s in segment.get("signals", []) if "id" in s}
    resolve = _make_value_resolver(graph, nodes, job_id, start, end, nframes, fps, signals_by_id, stem_audio_path)
    curve = resolve(node_id) if node_id in nodes else np.zeros(nframes, np.float32)
    times = np.arange(nframes, dtype=np.float32) / float(fps) + start
    return {
        "curve": [round(float(v), 4) for v in curve],
        "times": [round(float(t), 3) for t in times],
        "fps": fps,
    }

# --------------------------------------------------------------------------- #
# Points cards (spec 02): parametric layouts + transforms -> emitter source specs
# --------------------------------------------------------------------------- #
def _clamp01(v) -> float:
    return max(0.0, min(1.0, float(v)))


def _static_point_spec(p) -> dict:
    """A fixed point -> a static (path-less) emitter source spec."""
    return {"points": [[_clamp01(p[0]), _clamp01(p[1])]], "path_speed": 0}


def _pattern_points(data: dict) -> list:
    """A parametric layout -> a list of (x, y). Mirrors frontend lib/pointsGen.ts
    (scatter uses numpy's RNG, so its exact dots differ from the card preview, but
    both are a seeded random scatter)."""
    layout = data.get("layout", "circle")
    count = int(max(1, min(_POINT_CAP, round(float(data.get("count", 6))))))
    radius = _clamp01(data.get("radius", 0.3))
    rot = np.deg2rad(float(data.get("rotation", 0.0)))
    cx = 0.5 + float(data.get("offsetX", 0.0))
    cy = 0.5 + float(data.get("offsetY", 0.0))
    out = []
    if layout == "grid":
        cols = max(1, round(count**0.5))
        rows = int(np.ceil(count / cols))
        ext = radius or 0.4
        for i in range(count):
            fx = (i % cols) / (cols - 1) - 0.5 if cols > 1 else 0.0
            fy = (i // cols) / (rows - 1) - 0.5 if rows > 1 else 0.0
            out.append((_clamp01(cx + fx * ext * 2), _clamp01(cy + fy * ext * 2)))
    elif layout == "line":
        ext = radius or 0.4
        for i in range(count):
            t = i / (count - 1) - 0.5 if count > 1 else 0.0
            out.append(
                (_clamp01(cx + np.cos(rot) * t * ext * 2), _clamp01(cy + np.sin(rot) * t * ext * 2))
            )
    elif layout == "spiral":
        for i in range(count):
            t = i / (count - 1) if count > 1 else 0.0
            ang = rot + t * 3 * 2 * np.pi
            out.append((_clamp01(cx + np.cos(ang) * radius * t), _clamp01(cy + np.sin(ang) * radius * t)))
    elif layout == "scatter":
        rng = np.random.default_rng(int(data.get("seed", 1)))
        for _ in range(count):
            ang = rng.random() * 2 * np.pi
            rr = (rng.random() ** 0.5) * radius
            out.append((_clamp01(cx + np.cos(ang) * rr), _clamp01(cy + np.sin(ang) * rr)))
    else:  # circle / ring
        for i in range(count):
            ang = rot + (i / count) * 2 * np.pi
            out.append((_clamp01(cx + np.cos(ang) * radius), _clamp01(cy + np.sin(ang) * radius)))
    return out


def _animate_point_specs(specs: list, data: dict) -> list:
    """Give each point a PATH so it moves over the clip (reuses the fluid source-path
    machinery): orbit = a ring about the centre, drift = a line along a heading. chase
    keeps the points fixed and cycles WHICH ones emit — a sliding lit window of `count`
    points sweeping the set at `rate`, via per-source emission gate fields."""
    mode = data.get("mode", "orbit")
    amount = _clamp01(data.get("amount", 0.15))
    rate = float(data.get("rate", 1.0))
    if mode == "chase":
        n = len(specs)
        if not n:
            return []
        count = int(max(1, min(n, round(float(data.get("count", 1))))))
        duty = count / n
        fade = _clamp01(data.get("fade", 0.0))
        return [
            {**s, "gate_speed": rate, "gate_phase": j / n, "gate_duty": duty, "gate_fade": fade}
            for j, s in enumerate(specs)
        ][:_POINT_CAP]
    out = []
    for s in specs:
        bx, by = float(s["points"][0][0]), float(s["points"][0][1])
        if mode == "drift":
            ang = np.deg2rad(float(data.get("angle", 0.0)))
            path = [
                [_clamp01(bx), _clamp01(by)],
                [_clamp01(bx + np.cos(ang) * amount), _clamp01(by + np.sin(ang) * amount)],
            ]
            out.append({"points": path, "path_speed": rate, "path_pingpong": True})
        else:  # orbit
            start = np.arctan2(by - 0.5, bx - 0.5)
            path = [
                [_clamp01(0.5 + np.cos(start + (k / 16) * 2 * np.pi) * amount),
                 _clamp01(0.5 + np.sin(start + (k / 16) * 2 * np.pi) * amount)]
                for k in range(16)
            ]
            out.append({"points": path, "path_speed": rate, "path_closed": True})
    return out[:_POINT_CAP]

