"""HD render of ONE segment (`POST /export/segment`) — the Output card's "HD" button.

The feature's whole promise is "what you see here is what the master will look like",
so the tests pin the three things that could break it: the HD clip is a SEPARATE cache
entry from the draft preview (never overwrites it), a sim-free graph actually renders
BIGGER in HD (the trap: the export pins `gridCells`, which used to force a coarse
simulation grid onto graphs that have nothing to simulate), and the segment path can't
drift from the whole-song export's settings.
"""

from __future__ import annotations

import numpy as np
import pytest

from backend import fluid
from backend import graph as G
from backend import graph_render as GR
from backend import song_render as SR
from backend.routes import export as EX

EXPORT = {"width": 1080, "height": 1920, "fps": 30, "gridCells": 216, "imageSize": 1024}
PREVIEW = {"width": 1080, "height": 1920, "quality": "draft", "fps": 24}
SEG = {"id": "s1", "start": 0.0, "end": 1.0, "signals": [], "lyric_lines": []}
NOAUDIO = lambda j, s: None  # noqa: E731


def _edge(s, t, tp):
    return {"id": s + t + tp, "source": s, "sourcePort": "out", "target": t, "targetPort": tp}


def _light_graph():
    """No simulation anywhere: a backdrop straight into an output."""
    return {
        "version": 26,
        "nodes": [
            {
                "id": "b",
                "type": "backdrop",
                "data": {
                    "color": "#204080",
                    "ports": {"opacity": {"binding": {"kind": "const", "value": 1}}},
                },
            },
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [_edge("b", "o", "video")],
    }


def _heavy_graph():
    ports = {
        k: {"binding": {"kind": "const", "value": v}}
        for k, v in [
            ("emit", 0.4),
            ("force", 40),
            ("radius", 0.12),
            ("r", 1.0),
            ("g", 0.3),
            ("b", 0.2),
        ]
    }
    return {
        "version": 26,
        "nodes": [
            {
                "id": "f",
                "type": "fluid",
                "data": {"static": {"points": [[0.5, 0.5]], "wrap": True}, "ports": ports},
            },
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [_edge("f", "o", "video")],
    }


def _hd_output():
    """What the route builds for a segment HD render."""
    return {**SR.output_from_export(EXPORT), "nativeShort": min(EXPORT["width"], EXPORT["height"])}


def _dims(graph, output):
    return GR._grid_dims(G.Dag("job", SEG, graph, NOAUDIO, output))


# ── the shared export→output contract ────────────────────────────────────────


def test_song_and_segment_share_one_output_contract():
    # build_plan derives its grid from the same helper the segment route uses, so the
    # two HD paths can never disagree about size/fps/detail.
    seg = {**SEG, "graph": _heavy_graph(), "finalOutputId": "o"}
    ctx = SR.build_plan("job", [seg], [], EXPORT, NOAUDIO)
    assert (ctx["gh"], ctx["gw"]) == fluid.grid_from_output(SR.output_from_export(EXPORT))
    assert (ctx["w"], ctx["h"], ctx["fps"]) == (EXPORT["width"], EXPORT["height"], EXPORT["fps"])


def test_export_defaults_are_shared_not_copied():
    assert EX._EXPORT_DEFAULTS is SR.EXPORT_DEFAULTS


# ── the HD clip is its own cache entry ───────────────────────────────────────


def test_hd_hash_differs_from_preview_and_from_plain_export():
    graph = _heavy_graph()
    keys = {
        G.output_hash("job", SEG, graph, "o", PREVIEW),
        G.output_hash("job", SEG, graph, "o", SR.output_from_export(EXPORT)),
        G.output_hash("job", SEG, graph, "o", _hd_output()),
    }
    # three distinct settings -> three distinct files: rendering in HD can never
    # overwrite (or invalidate) the draft preview the card is showing.
    assert len(keys) == 3


# ── resolution: the light-graph trap ─────────────────────────────────────────


def test_light_graph_renders_native_in_hd():
    hd_h, hd_w = _dims(_light_graph(), _hd_output())
    prev_h, prev_w = _dims(_light_graph(), PREVIEW)
    sim_h, sim_w = fluid.grid_from_output(SR.output_from_export(EXPORT))
    assert min(hd_h, hd_w) == pytest.approx(1080, abs=2)  # the export's true native size
    assert min(hd_h, hd_w) > min(prev_h, prev_w)  # sharper than the 540-capped preview
    assert min(hd_h, hd_w) > min(sim_h, sim_w)  # and than the 216-cell sim grid
    assert hd_h % 2 == 0 and hd_w % 2 == 0  # yuv420p needs even dims


def test_heavy_graph_ignores_native_short():
    # A sim graph must stay on the simulation grid — `nativeShort` is only about
    # graphs with nothing to simulate.
    assert _dims(_heavy_graph(), _hd_output()) == fluid.grid_from_output(_hd_output())


@pytest.mark.parametrize("graph", [_light_graph(), _heavy_graph()])
def test_preview_grid_unchanged(graph):
    # Regression pin for the `nativeShort` opt-in: with no HD keys the grid is exactly
    # what it was before the feature, so no existing preview's cache is busted.
    expected = (
        fluid.grid_from_output(PREVIEW)
        if any(n["type"] == "fluid" for n in graph["nodes"])
        else (540 * PREVIEW["height"] // PREVIEW["width"] // 2 * 2, 540)
    )
    assert _dims(graph, PREVIEW) == expected


def test_light_graph_streams_at_its_hd_size():
    # Assert through the real streaming path, not just _grid_dims: whole-clip and
    # block rendering must agree on ONE frame size (the lockstep invariant).
    graph = _light_graph()
    out = {**_hd_output(), "width": 240, "height": 320, "nativeShort": 320}
    dag = G.Dag("job", SEG, graph, NOAUDIO, out)
    whole = dag.video("o")
    blocks = np.concatenate([G.Dag("job", SEG, graph, NOAUDIO, out)._block_producer("o")(0, 5)])
    assert whole.shape[1:3] == (320, 240)
    assert blocks.shape[1:3] == whole.shape[1:3]


# ── the block-size guard ─────────────────────────────────────────────────────


def test_hd_block_seconds_shrinks_with_resolution():
    # A 5s block at 1080x1920x30fps would hold >1GB of frames in flight.
    assert EX._hd_block_seconds(1080, 1920) < 2.0
    assert EX._hd_block_seconds(540, 960) == 5.0
    assert EX._hd_block_seconds(4096, 4096) >= 0.5  # never zero


# ── audio muxing ─────────────────────────────────────────────────────────────


def _capture_ffmpeg(monkeypatch):
    """Record the argv `_mux_audio` would run instead of spawning ffmpeg."""
    seen: dict = {}

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd
        return type("R", (), {"returncode": 0, "stderr": b""})()

    monkeypatch.setattr(SR.subprocess, "run", fake_run)
    return seen


def test_mux_audio_default_argv_is_unchanged(monkeypatch):
    seen = _capture_ffmpeg(monkeypatch)
    SR._mux_audio("v.mp4", "a.wav", "out.mp4")
    assert seen["cmd"] == [
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-i",
        "v.mp4",
        "-i",
        "a.wav",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-shortest",
        "-movflags",
        "+faststart",
        "out.mp4",
    ]


def test_mux_audio_slices_only_the_audio_input(monkeypatch):
    seen = _capture_ffmpeg(monkeypatch)
    SR._mux_audio("v.mp4", "a.wav", "out.mp4", start=12.5, duration=3.0)
    cmd = seen["cmd"]
    # the seek sits between the video input and the audio input — so it trims the
    # audio only and the video keeps its own timeline
    assert cmd[cmd.index("-i") + 1] == "v.mp4"
    assert cmd[cmd.index("-ss") - 1] != "-i"
    assert cmd.index("-ss") > cmd.index("v.mp4")
    assert cmd.index("-ss") < cmd.index("a.wav")
    assert cmd[cmd.index("-ss") + 1] == "12.500"
    assert cmd[cmd.index("-t") + 1] == "3.000"


def test_export_audio_path_falls_back_to_original():
    calls = []

    def stems(job, stem):
        calls.append(stem)
        return None if stem == "instrumental" else f"/audio/{stem}.wav"

    assert SR.export_audio_path("job", {"audioMode": "instrumental"}, stems).endswith(
        "original.wav"
    )
    assert calls == ["instrumental", "original"]
    assert SR.export_audio_path("job", {}, stems).endswith("original.wav")


# ── the route's guard rails ──────────────────────────────────────────────────


def _post(client, body):
    return client.post("/export/segment", json=body)


def test_route_rejects_bad_and_missing_input(client):
    assert _post(client, {"job_id": "../etc", "segment": SEG}).status_code == 404
    assert _post(client, {"job_id": "deadbeef"}).status_code == 400  # no segment
    r = _post(client, {"job_id": "deadbeef", "segment": SEG, "graph": {"nodes": []}})
    assert r.status_code == 400  # no graph nodes


def test_route_404s_unknown_project(client, monkeypatch):
    monkeypatch.setattr(EX.db, "get_project", lambda j: None)
    r = _post(client, {"job_id": "deadbeef", "segment": {**SEG, "graph": _heavy_graph()}})
    assert r.status_code == 404


def test_route_400s_when_the_output_is_ambiguous(client, monkeypatch):
    monkeypatch.setattr(EX.db, "get_project", lambda j: {"data": {"export": EXPORT}})
    graph = _heavy_graph()
    graph["nodes"].append({"id": "o2", "type": "output", "data": {}})
    r = _post(client, {"job_id": "deadbeef", "segment": {**SEG, "graph": graph}})
    assert r.status_code == 400
    assert "o2" in r.get_json()["error"]  # names the candidates


def test_route_409s_while_an_hd_render_is_running(client, monkeypatch):
    monkeypatch.setattr(EX.db, "get_project", lambda j: {"data": {"export": EXPORT}})
    monkeypatch.setattr(EX.render_jobs, "start", lambda run: "rid-1")
    body = {"job_id": "deadbeef", "segment": {**SEG, "graph": _heavy_graph()}}
    first = _post(client, body)
    try:
        assert first.status_code == 200 and first.get_json()["render_id"] == "rid-1"
        second = _post(client, body)
        assert second.status_code == 409
        assert second.get_json()["render_id"] == "rid-1"  # tells the UI what to cancel
    finally:
        EX._HD_RUNNING = None
        EX._HD_SLOT.release()  # the job never ran, so release the slot by hand


# ── the cache lookup (`POST /export/segment/cached`) ─────────────────────────
#
# A reloaded editor has lost the in-memory job registry, but the rendered FILE is
# still on disk. The lookup answers "already exported?" as a pure function of
# `output_hash` over what the client is looking at — no fourth store to keep in sync,
# and no entry that can outlive the file it names.


def _cached(client, body):
    return client.post("/export/segment/cached", json=body)


def _seg_body():
    return {"job_id": "deadbeef", "segment": {**SEG, "graph": _heavy_graph()}}


def test_cached_lookup_misses_when_nothing_was_rendered(client, monkeypatch):
    monkeypatch.setattr(EX.db, "get_project", lambda j: {"data": {"export": EXPORT}})
    r = _cached(client, _seg_body())
    assert r.status_code == 200
    assert r.get_json() == {"url": None}


def test_cached_lookup_finds_the_exact_file_the_render_would_write(client, monkeypatch):
    """The lookup and the render must agree on the key — that is the whole point.

    Rather than hard-code a hash, ask the render path itself where it would write
    (`_hd_paths`, the one definition both routes share) and plant a file there.
    """
    monkeypatch.setattr(EX.db, "get_project", lambda j: {"data": {"export": EXPORT}})
    body = _seg_body()
    err, ctx = EX._segment_request(body)
    assert err is None
    silent, muxed = EX._hd_paths(*ctx)

    silent.parent.mkdir(parents=True, exist_ok=True)
    silent.write_bytes(b"x")
    r = _cached(client, body).get_json()
    assert r["url"] == f"/fluid/{silent.name}"
    assert r["audio"] is False  # the silent clip is a fallback

    muxed.write_bytes(b"x")  # once muxed, THAT is what the viewer plays
    r = _cached(client, body).get_json()
    assert r["url"] == f"/fluid/{muxed.name}"
    assert r["audio"] is True


def test_cached_lookup_misses_after_the_graph_changes(client, monkeypatch):
    """No rule is written for invalidation — the key simply moves. This pins it."""
    monkeypatch.setattr(EX.db, "get_project", lambda j: {"data": {"export": EXPORT}})
    body = _seg_body()
    err, ctx = EX._segment_request(body)
    assert err is None
    silent, _ = EX._hd_paths(*ctx)
    silent.parent.mkdir(parents=True, exist_ok=True)
    silent.write_bytes(b"x")
    assert _cached(client, body).get_json()["url"] is not None

    edited = _seg_body()
    for n in edited["segment"]["graph"]["nodes"]:
        if n["type"] == "fluid":
            n["data"] = {**n.get("data", {}), "seed": 4242}  # any render-visible edit
    assert _cached(client, edited).get_json()["url"] is None


def test_cached_lookup_shares_its_guard_rails_with_the_render_route(client, monkeypatch):
    monkeypatch.setattr(EX.db, "get_project", lambda j: {"data": {"export": EXPORT}})
    assert _cached(client, {"job_id": "../etc", "segment": SEG}).status_code == 404
    assert _cached(client, {"job_id": "deadbeef"}).status_code == 400
