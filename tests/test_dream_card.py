"""The Dream card end to end (specs/dream/04): the render handler's decode/passthrough,
`dream_source`'s schedule resolution, and the route's validation.

The generation itself is covered by test_dream.py / test_dream_cache.py against a fake
pipe; nothing here touches diffusers.
"""

import shutil
import subprocess

import numpy as np
import pytest

from backend import graph as G
from backend import paths

from helpers import no_audio as NOAUDIO

_needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

OUT = {"width": 64, "height": 64, "quality": "draft", "fps": 12}
SEG = {"start": 0.0, "end": 1.0, "signals": []}


def _edge(s, t, tp):
    return {"id": f"{s}-{t}-{tp}", "source": s, "sourcePort": "out", "target": t, "targetPort": tp}


def _fluid():
    return {
        "id": "fl",
        "type": "fluid",
        "data": {
            "static": {
                "grid": 48,
                "fps": 12,
                "color": [0.3, 0.7, 1],
                "intensity": 1,
                "opacity": 1,
                "enabled": True,
                "radial": False,
                "wrap": True,
                "points": [[0.5, 0.5]],
                "path_speed": 1,
                "path_closed": False,
                "path_pingpong": False,
            },
            "ports": {
                "emit": {"binding": {"kind": "const", "value": 0.6}},
                "force": {"binding": {"kind": "const", "value": 30}},
                "radius": {"binding": {"kind": "const", "value": 0.1}},
            },
        },
    }


def _dream(prompts=None, ports=None, asset_url="", **data):
    """`prompts=[]` means an EMPTY list on purpose (the route must refuse it), so the
    default is keyed on None rather than falsiness."""
    return {
        "id": "dr",
        "type": "dream",
        "data": {
            "prompts": [{"id": "p1", "text": "a"}] if prompts is None else prompts,
            "manualBreakpoints": [],
            "disabledCuts": [],
            "threshold": 0.5,
            "hysteresis": 0.1,
            "seedMode": "fixed",
            "seed": 1,
            "model": "draft",
            "assetUrl": asset_url,
            "ports": ports
            or {
                "control_scale": {"binding": {"kind": "const", "value": 0.7}},
                "trigger": {"binding": {"kind": "const", "value": 0}},
                "reseed": {"binding": {"kind": "const", "value": 0}},
            },
            **data,
        },
    }


def _graph(dream_node=None, extra_nodes=(), extra_edges=()):
    """fluid -> extract -> dream -> output."""
    return {
        "version": 30,
        "nodes": [
            _fluid(),
            {"id": "ex", "type": "extract", "data": {"kind": "density", "ports": {}}},
            dream_node or _dream(),
            {"id": "o", "type": "output", "data": {}},
            *extra_nodes,
        ],
        "edges": [
            _edge("fl", "ex", "video"),
            _edge("ex", "dr", "control"),
            _edge("dr", "o", "video"),
            *extra_edges,
        ],
    }


# --------------------------------------------------------------------------- #
# The render handler
# --------------------------------------------------------------------------- #


def test_passthrough_when_nothing_is_generated():
    """An ungenerated card must be as cheap as `transform` — it passes its CONTROL input
    through, so dropping one on the canvas never blocks a preview on the GPU."""
    g = _graph()
    with G.Dag("j", SEG, g, NOAUDIO, OUT) as dag:
        got = dag.video("dr")
        want = dag.video("ex")
    assert np.array_equal(got[..., :3], want[..., :3])


def test_missing_both_inputs_raises():
    g = _graph()
    g["edges"] = [e for e in g["edges"] if e["targetPort"] != "control"]
    with G.Dag("j", SEG, g, NOAUDIO, OUT) as dag:
        with pytest.raises(ValueError, match="control or video"):
            dag.video("dr")


@_needs_ffmpeg
def test_decodes_a_generated_clip(tmp_path, monkeypatch):
    """With `assetUrl` set, the card decodes that clip instead of its control input."""
    monkeypatch.setattr(paths, "ASSETS_DIR", tmp_path)
    d = tmp_path / "j"
    d.mkdir()
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:size=32x32:rate=12:duration=2",
            "-pix_fmt",
            "yuv420p",
            str(d / "dream.mp4"),
        ],
        check=True,
    )
    g = _graph(_dream(asset_url="/assets/j/dream.mp4"))
    with G.Dag("j", SEG, g, NOAUDIO, OUT) as dag:
        frames = dag.video("dr")
    # solid red from the generated clip, not the blue-ish density map
    assert frames[..., 0].mean() > 150
    assert frames[..., 2].mean() < 80


# --------------------------------------------------------------------------- #
# dream_source — the schedule half
# --------------------------------------------------------------------------- #


def test_dream_source_returns_a_plan_per_frame():
    control, init, plan, fps = G.dream_source("j", SEG, _graph(), "dr", NOAUDIO, OUT)
    assert fps == 12
    assert len(plan) == 12  # a 1s segment at 12fps
    assert len(control) == 12
    assert init is None  # no `video` wired
    assert all(s["prompt_a"] == "a" for s in plan)


def test_dream_source_requires_control_or_video():
    """Either input alone is enough — but with neither there is nothing to follow."""
    g = _graph()
    g["edges"] = [e for e in g["edges"] if e["targetPort"] != "control"]
    with pytest.raises(ValueError, match="control or video"):
        G.dream_source("j", SEG, g, "dr", NOAUDIO, OUT)


def test_dream_source_splits_on_the_trigger():
    """A square LFO's rising edge cuts the window, so the second prompt takes over."""
    lfo = {
        "id": "lf",
        "type": "lfo",
        "data": {"shape": "square", "rateMode": "cycles", "rate": 2, "phase": 0, "duty": 0.5},
    }
    node = _dream(
        prompts=[{"id": "p1", "text": "first"}, {"id": "p2", "text": "second"}],
        ports={
            "control_scale": {"binding": {"kind": "const", "value": 0.7}},
            "trigger": {"binding": {"kind": "node", "nodeId": "lf", "lo": 0, "hi": 1}},
            "reseed": {"binding": {"kind": "const", "value": 0}},
        },
    )
    g = _graph(node, extra_nodes=[lfo], extra_edges=[_edge("lf", "dr", "trigger")])
    _, _, plan, _ = G.dream_source("j", SEG, g, "dr", NOAUDIO, OUT)
    used = [s["prompt_a"] for s in plan]
    assert used[0] == "first"
    assert "second" in used, "the trigger's rise never handed over to prompt 2"


def test_dream_source_carries_the_control_scale_curve():
    node = _dream(
        ports={
            "control_scale": {"binding": {"kind": "const", "value": 0.25}},
            "trigger": {"binding": {"kind": "const", "value": 0}},
            "reseed": {"binding": {"kind": "const", "value": 0}},
        }
    )
    _, _, plan, _ = G.dream_source("j", SEG, _graph(node), "dr", NOAUDIO, OUT)
    assert all(abs(s["scale"] - 0.25) < 1e-6 for s in plan)


def test_dream_source_applies_the_fade_shape():
    """fadeShape reaches the plan — the same knob the card exposes."""
    lfo = {
        "id": "lf",
        "type": "lfo",
        "data": {"shape": "square", "rateMode": "cycles", "rate": 2, "phase": 0, "duty": 0.5},
    }
    ports = {
        "control_scale": {"binding": {"kind": "const", "value": 0.7}},
        "trigger": {"binding": {"kind": "node", "nodeId": "lf", "lo": 0, "hi": 1}},
        "reseed": {"binding": {"kind": "const", "value": 0}},
    }
    prompts = [{"id": "p1", "text": "a", "fadeOut": 0.3}, {"id": "p2", "text": "b", "fadeIn": 0.3}]
    plans = {}
    for shape in (1.0, 3.0):
        node = _dream(prompts=prompts, ports=ports, fadeShape=shape)
        g = _graph(node, extra_nodes=[lfo], extra_edges=[_edge("lf", "dr", "trigger")])
        _, _, plan, _ = G.dream_source("j", SEG, g, "dr", NOAUDIO, OUT)
        plans[shape] = [round(s["w"], 4) for s in plan]
    assert plans[1.0] != plans[3.0], "fadeShape never reached the weights"
    # shape 3 pulls mid-ramp weights TOWARD 0.5 (into Z-Image's active band)
    mid = [(a, b) for a, b in zip(plans[1.0], plans[3.0]) if 0 < a < 1]
    assert mid, "no ramp frames in the plan"
    assert all(abs(b - 0.5) <= abs(a - 0.5) + 1e-9 for a, b in mid)


def test_seed_mode_gate_falls_back_to_the_cut_schedule():
    lfo = {
        "id": "lf",
        "type": "lfo",
        "data": {"shape": "square", "rateMode": "cycles", "rate": 2, "phase": 0, "duty": 0.5},
    }
    node = _dream(
        prompts=[{"id": "p1", "text": "a"}, {"id": "p2", "text": "b"}],
        ports={
            "control_scale": {"binding": {"kind": "const", "value": 0.7}},
            "trigger": {"binding": {"kind": "node", "nodeId": "lf", "lo": 0, "hi": 1}},
            "reseed": {"binding": {"kind": "const", "value": 0}},
        },
        seedMode="gate",
        seed=10,
    )
    g = _graph(node, extra_nodes=[lfo], extra_edges=[_edge("lf", "dr", "trigger")])
    _, _, plan, _ = G.dream_source("j", SEG, g, "dr", NOAUDIO, OUT)
    seeds = [s["seed"] for s in plan]
    assert seeds[0] == 10
    assert max(seeds) > 10, "an unwired reseed port should still re-roll at each cut"


# --------------------------------------------------------------------------- #
# The route
# --------------------------------------------------------------------------- #


@pytest.fixture
def client():
    from backend.app import app

    app.config.update(TESTING=True)
    return app.test_client()


def test_route_rejects_a_bad_job_id(client):
    assert client.post("/dream/../etc", json={}).status_code in (404, 308, 404)


def test_route_rejects_a_missing_node(client):
    r = client.post("/dream/ab12cd34", json={"graph": _graph(), "segment": SEG, "node_id": "nope"})
    assert r.status_code == 400


def test_route_rejects_a_node_of_the_wrong_type(client):
    r = client.post("/dream/ab12cd34", json={"graph": _graph(), "segment": SEG, "node_id": "fl"})
    assert r.status_code == 400


def test_route_rejects_a_card_with_no_prompts(client):
    """Generating with no prompts would raise deep in the worker; refuse at the door."""
    g = _graph(_dream(prompts=[]))
    r = client.post("/dream/ab12cd34", json={"graph": g, "segment": SEG, "node_id": "dr"})
    assert r.status_code == 400


# --------------------------------------------------------------------------- #
# "Follow the lyrics" — the schedule from the sung lines
# --------------------------------------------------------------------------- #

LINES = [
    {"t0": 0.0, "t1": 0.25, "text": "first line"},
    {"t0": 0.5, "t1": 0.75, "text": "second line"},
]


def _seg_with_lyrics():
    return {**SEG, "lyric_lines": LINES}


def test_lyrics_do_nothing_until_the_toggle_is_on():
    """The lines ride in on every segment; only a card that asked for them reacts."""
    _, _, plan, _ = G.dream_source("j", _seg_with_lyrics(), _graph(), "dr", NOAUDIO, OUT)
    assert {s["prompt_a"] for s in plan} == {"a"}  # one part, the single prompt


def test_following_the_lyrics_cuts_on_the_sung_lines():
    node = _dream(
        prompts=[{"id": f"p{i}", "text": t} for i, t in enumerate("abcd")],
        followLyrics=True,
    )
    _, _, plan, _ = G.dream_source("j", _seg_with_lyrics(), _graph(node), "dr", NOAUDIO, OUT)
    used = [s["prompt_a"] for s in plan]
    # 12 frames over 1s at 12fps. Lines at 0.0-0.25 and 0.5-0.75 → cuts at the second
    # line's start (frame 6) and at each real silence (frames 3 and 9).
    assert used[0] == "a"
    assert len(set(used)) > 1, "the lyric lines never cut the window"


def test_lyric_cuts_obey_disabled_cuts_like_any_other():
    node = _dream(
        prompts=[{"id": "p0", "text": "a"}, {"id": "p1", "text": "b"}],
        followLyrics=True,
    )
    node["data"]["disabledCuts"] = [0.25]  # 0.25s @ 12fps = frame 3
    _, _, plan, _ = G.dream_source("j", _seg_with_lyrics(), _graph(node), "dr", NOAUDIO, OUT)
    # frame 3 was the first silence; silencing it means part 0 runs past it
    assert plan[3]["prompt_a"] == "a"


def test_a_lyric_driven_dream_busts_its_cache_when_the_lines_change():
    """The trap: `output_hash` folded lyric lines in only when a LYRICS card was in the
    graph, so a Dream card following the lyrics kept serving a clip from before the edit.
    """
    from backend.graph_hash import output_hash

    g = _graph(_dream(followLyrics=True))
    a = output_hash("j", _seg_with_lyrics(), g, "o", OUT)
    edited = {**SEG, "lyric_lines": [{**LINES[0], "text": "rewritten"}, LINES[1]]}
    b = output_hash("j", edited, g, "o", OUT)
    assert a != b, "editing a lyric line must invalidate the render"


def test_a_dream_NOT_following_the_lyrics_is_unaffected_by_them():
    from backend.graph_hash import output_hash

    g = _graph()  # followLyrics absent
    a = output_hash("j", _seg_with_lyrics(), g, "o", OUT)
    edited = {**SEG, "lyric_lines": [{**LINES[0], "text": "rewritten"}, LINES[1]]}
    assert a == output_hash("j", edited, g, "o", OUT)
