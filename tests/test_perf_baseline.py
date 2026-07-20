"""Recorded performance baselines — the "before" column for a perf change.

Separate from `test_perf_budget.py` because the two want opposite things from CI. A budget
is a 10x ceiling on a fast render and SHOULD gate every push. A baseline is seconds long
and machine-specific; asserting tightly on one across machines is how a perf test becomes
flaky, and a flaky perf test gets muted, which is worse than not having it. So these carry
the `bench` marker, which `pyproject.toml`'s `addopts` deselects by default.

Run with `make bench` (or `pytest -m bench -s`). The numbers land in
`docs/cleanup/16-parity-and-benchmark-harness.md` with a provenance header; the ceilings
here exist only to catch a 10x regression, not to police the recorded value.

⚠ The graphs are built LOCALLY rather than taken from `card_demo.DEMOS`. The Playground
fixture is re-exported from the live UI (`make export-playground`), so sourcing a benchmark
from it means someone reworking a demo silently changes the workload and invalidates every
recorded number without touching this file. `test_perf_budget.py` uses the demos and that is
fine — a 10x ceiling does not care about the exact workload. A baseline does.
"""

from __future__ import annotations

import numpy as np
import pytest

from backend import graph, song_render
from backend.graph_common import _POINT_CAP

from helpers import assert_moves, edge, graph_of, node, out, timed

pytestmark = pytest.mark.bench

# Generous by an order of magnitude — see the module docstring. These catch "the transform
# started rendering the whole song", not a 20% drift.
BUDGETS = {
    "points_fluid": 60.0,
    "transform_block": 60.0,
    "clouds": 60.0,
    "song_cache_hit": 5.0,
}

_NOAUDIO = lambda _job, _stem: None  # noqa: E731

# ⚠ Output settings decide the frame size, and getting them wrong makes a benchmark measure
# nothing. Two different paths matter:
#
#  - a graph containing a HEAVY producer (fluid, clouds, ... — `_HEAVY_TYPES`) renders on the
#    coarse SIMULATION grid, so `_HD` below yields 180x96 regardless of the 1920x1080;
#  - a LIGHT graph (backdrop/lyrics/image/video/montage, stack combines) with `nativeShort`
#    set renders at full native resolution — 1080p RGBA. That is the HD export path
#    (`routes/export.py:181` sets `nativeShort` to min(w, h)), and it is where the
#    per-frame warp costs two orders of magnitude more than on the sim grid.
#
# A first draft of this file used `out(width=384, height=384)` throughout and measured the
# transform at 64x64x3 — 0.05 s for something that costs 1.4 s on the path users hit.
_HD = out(width=1920, height=1080, fps=24, quality="final")  # -> 180x96 sim grid
_HD_NATIVE = {**_HD, "nativeShort": 1080}  # -> 1080p, light graphs only


def _ports(**kw) -> dict:
    """`{name: {"binding": {"kind": "const", "value": v}}}` — the card port shape. Only the
    params a case actually pins are listed; the rest come from the backend spec defaults."""
    return {k: {"binding": {"kind": "const", "value": v}} for k, v in kw.items()}


def _render(g, out_dict, seg, out_id="out"):
    return graph.Dag("bench", seg, g, _NOAUDIO, out_dict).video(out_id)


@pytest.fixture(scope="module")
def stem_wav(tmp_path_factory):
    """A 30 s synthetic drum stem + resolver, so case D's `signal` card extracts for real.

    Long enough that the STFT is not trivial — the cost this baseline exists to record is
    the one paid on a cold `_STFT_CACHE`, and a 1 s clip would not show it.
    """
    import soundfile as sf

    d = tmp_path_factory.mktemp("benchstems")
    sr, dur = 44100, 30.0
    sig = np.zeros(int(sr * dur), dtype=np.float32)
    n = int(0.1 * sr)
    env = np.exp(-np.arange(n) / (0.04 * sr))
    for k in range(int(dur * 4)):  # a 4-on-the-floor kick, so onset/beat have something
        i0 = int(k * 0.25 * sr)
        sig[i0 : i0 + n] += np.sin(2 * np.pi * 60 * np.arange(n) / sr) * env
    sf.write(str(d / "drums.wav"), sig, sr)

    def resolve(_job, stem):
        p = d / f"{stem}.wav"
        return p if p.exists() else None

    return resolve


# --------------------------------------------------------------------------- #
# A. the points-driven fluid — step 17's target
# --------------------------------------------------------------------------- #
# Filled to _POINT_CAP deliberately: the finding is that 64 emitters cost ~6x the solver
# they feed, and a 3-point demo would measure none of it.


def _points_fluid(radius: float) -> dict:
    pts = [
        [0.5 + 0.35 * float(np.cos(i)), 0.5 + 0.35 * float(np.sin(i))] for i in range(_POINT_CAP)
    ]
    return graph_of(
        [
            node("pt", "points", points=pts),
            node(
                "fl",
                "fluid",
                ports=_ports(r=0.27, g=0.69, b=1, emit=0.3, angle=270, force=20, radius=radius),
            ),
            node("out", "output"),
        ],
        [edge("pt", "fl", "positions"), edge("fl", "out", "video")],
    )


@pytest.mark.parametrize("radius", [0.08, 0.02])
def test_points_driven_fluid(radius):
    """Two radii: windowing an emitter's Gaussian wins most where the radius is small, so
    0.08 alone would under-report step 17's gain."""
    seg = {"start": 0.0, "end": 2.0, "signals": []}
    frames, elapsed = timed(
        f"points fluid, {_POINT_CAP} emitters, radius={radius}",
        lambda: _render(_points_fluid(radius), _HD, seg),
    )
    assert_moves(frames, f"points fluid r={radius}")
    assert elapsed < BUDGETS["points_fluid"], f"{elapsed:.1f}s"


# --------------------------------------------------------------------------- #
# B. a transform block over RGBA at NATIVE resolution
# --------------------------------------------------------------------------- #
# The source is a `backdrop`, not a fluid, and that is the whole point: a heavy producer
# would drag the render onto the 180x96 sim grid where the warp is nearly free. A light
# graph + `nativeShort` is the HD export path, where `_transform_frames` runs on
# 1080x1920x4 and dominates everything else in the render.
#
# Through stream_blocks, not video(): the target is the BLOCK path.


def test_transform_block_over_rgba_at_native_resolution():
    g = graph_of(
        [
            node("bg", "backdrop", ports=_ports(opacity=1)),
            node("tf", "transform", ports=_ports(zoom=1.2, rotate=30.0, pan_x=0.05, pan_y=0.02)),
            node("out", "output"),
        ],
        [edge("bg", "tf", "video"), edge("tf", "out", "video")],
    )
    seg = {"start": 0.0, "end": 0.5, "signals": []}

    def run():
        dag = graph.Dag("bench", seg, g, _NOAUDIO, _HD_NATIVE)
        return np.concatenate([f for *_, f in dag.stream_blocks("out", 6)])

    frames, elapsed = timed("transform block, 1080p RGBA", run)
    assert frames.shape[1:] == (1080, 1920, 4), (
        f"the case must exercise the NATIVE path, got {frames.shape} — a heavy producer in "
        "the graph would silently drop it to the sim grid and measure nothing"
    )
    assert elapsed < BUDGETS["transform_block"], f"{elapsed:.1f}s"


# --------------------------------------------------------------------------- #
# C. a clouds clip — the noise lattice
# --------------------------------------------------------------------------- #
# Rendered larger than the others on purpose: the interpolation cost scales with output
# pixels, and at 192 it disappears into per-frame overhead.


def test_clouds_clip():
    g = graph_of(
        [
            node(
                "c",
                "clouds",
                seed=3,
                palette="sky",
                ports=_ports(scale=0.5, turbulence=0.5, drift=0.5, coverage=0.5, brightness=0.65),
            ),
            node("out", "output"),
        ],
        [edge("c", "out", "video")],
    )
    seg = {"start": 0.0, "end": 2.0, "signals": []}
    frames, elapsed = timed("clouds clip", lambda: _render(g, _HD, seg))
    assert_moves(frames, "clouds")
    assert elapsed < BUDGETS["clouds"], f"{elapsed:.1f}s"


# --------------------------------------------------------------------------- #
# D. a repeat whole-song export that hits the cache — step 19a
# --------------------------------------------------------------------------- #


def test_repeat_song_export_hits_the_cache(tmp_path, monkeypatch, stem_wav):
    """The cache-hit path must not pay for work it discards.

    ⚠ This case is only meaningful with a REAL bound signal and a real stem. With
    `signals: []` no extraction runs, the pre-fix number is already ~0, and the baseline
    records a win that cannot happen. The `stem_wav` fixture exists for that reason.
    """
    monkeypatch.setattr(song_render.paths, "ANIM_DIR", tmp_path)
    signals = [{"id": "sg", "kind": "energy", "stem": "drums", "smooth": 0.2, "gain": 1.0}]
    g = graph_of(
        [
            node("sig", "signal", signalId="sg"),
            node("fl", "fluid", ports=_ports(r=0.27, g=0.69, b=1, force=20, radius=0.08)),
            node("out", "output"),
        ],
        [edge("sig", "fl", "emit"), edge("fl", "out", "video")],
    )
    segs = [
        {
            "id": f"s{i}",
            "start": i * 4.0,
            "end": i * 4.0 + 4.0,
            "signals": signals,
            "lyric_lines": [],
            "graph": g,
            "finalOutputId": "out",
        }
        for i in range(6)
    ]
    export = {**song_render.EXPORT_DEFAULTS, "width": 1920, "height": 1080, "fps": 24}
    dest = tmp_path / f"song_{song_render._export_hash('bench', segs, [], export)}.mp4"
    dest.write_bytes(b"x")  # the file the export is about to find

    url, elapsed = timed(
        "repeat song export (cache hit)",
        lambda: song_render.render_song("bench", segs, [], export, stem_wav),
    )
    assert url is not None
    assert elapsed < BUDGETS["song_cache_hit"], f"{elapsed:.1f}s"
