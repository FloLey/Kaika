"""Image & Video layer cards (backgrounds are layers, not a setting).

Both synthesize an RGBA layer placed into a fractional box (full-frame by default) and
composite over the fluid via the alpha channel. Images are static; videos sample the
source at song- or segment-relative time. We test the producers directly and through
the render DAG (whole-clip video() and the block-streaming path).
"""

from __future__ import annotations

import shutil
import subprocess

import numpy as np
import pytest
from PIL import Image

from backend import graph as G
from backend import sources as S

_needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

OUT = {"width": 96, "height": 128, "quality": "draft", "fps": 24}
SEG = {"start": 0.0, "end": 1.0, "signals": []}
NOAUDIO = lambda j, s: None  # noqa: E731


@pytest.fixture
def assets(tmp_path, monkeypatch):
    """A temp ASSETS_DIR with one image (and, when ffmpeg is present, one video), under
    a valid 8-hex job id. Returns (job_id, image_url, video_url)."""
    job = "abcd1234"
    d = tmp_path / job
    d.mkdir(parents=True)
    Image.new("RGB", (40, 30), (30, 120, 200)).save(d / "img.png")
    vid_url = None
    if shutil.which("ffmpeg"):
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
             "-i", "testsrc=size=48x32:rate=10:duration=2", "-pix_fmt", "yuv420p", str(d / "vid.mp4")],
            check=True)
        vid_url = f"/assets/{job}/vid.mp4"
    monkeypatch.setattr(G, "ASSETS_DIR", tmp_path)
    return job, str(d / "img.png"), f"/assets/{job}/img.png", vid_url, str(d / "vid.mp4")


def _edge(s, t, tp):
    return {"id": s + t + tp, "source": s, "sourcePort": "out", "target": t, "targetPort": tp}


# --------------------------------------------------------------------------- #
# Producers (direct)
# --------------------------------------------------------------------------- #
def test_image_full_frame_and_region(assets):
    _job, img_path, *_ = assets
    op = np.ones(2, np.float32)
    full = S.image(2, 60, 40, asset_path=img_path, opacity=op)
    assert full.shape == (2, 60, 40, 4) and full[..., 3].min() == 255  # covers everything

    right = S.image(1, 60, 40, asset_path=img_path, box_x=0.5, box_w=0.5, fit="cover", opacity=np.ones(1, np.float32))
    assert right[0, :, :20, 3].max() == 0 and right[0, :, 20:, 3].min() == 255  # only the right half


def test_image_opacity_scales_alpha(assets):
    _job, img_path, *_ = assets
    out = S.image(2, 20, 20, asset_path=img_path, opacity=np.array([1.0, 0.5], np.float32))
    assert out[0, ..., 3].max() == 255 and 120 <= out[1, ..., 3].max() <= 134


def test_image_missing_asset_is_transparent():
    out = S.image(2, 20, 20, asset_path="", opacity=np.ones(2, np.float32))
    assert out.shape == (2, 20, 20, 4) and out[..., 3].max() == 0


@_needs_ffmpeg
def test_video_plays_and_sync_modes_differ(assets):
    _job, _ip, _iu, _vu, vid_path = assets
    seg = S.video(5, 60, 40, 10, asset_path=vid_path, src0=0.0, opacity=np.ones(5, np.float32))
    assert seg.shape == (5, 60, 40, 4)
    assert not np.array_equal(seg[0, ..., :3], seg[4, ..., :3])  # it advances (plays)
    song = S.video(5, 60, 40, 10, asset_path=vid_path, src0=1.0, opacity=np.ones(5, np.float32))
    assert not np.array_equal(seg[0], song[0])  # a later source-time origin picks a different frame


@_needs_ffmpeg
def test_video_speed_time_warps(assets):
    """A per-frame speed array warps playback: 2x advances the source twice as fast as 1x,
    and a modulated array is deterministic (whole-clip == same call)."""
    _job, _ip, _iu, _vu, vid_path = assets
    fast = S.video(6, 60, 40, 10, asset_path=vid_path, src0=0.0,
                   speed=np.full(6, 2.0, np.float32), opacity=np.ones(6, np.float32))
    slow = S.video(6, 60, 40, 10, asset_path=vid_path, src0=0.0,
                   speed=np.full(6, 1.0, np.float32), opacity=np.ones(6, np.float32))
    # After 5 output frames, 2x has advanced 1.0s of source, 1x only 0.5s -> different frame.
    assert not np.array_equal(fast[5, ..., :3], slow[5, ..., :3])
    paused = S.video(4, 60, 40, 10, asset_path=vid_path, src0=0.0,
                     speed=np.zeros(4, np.float32), opacity=np.ones(4, np.float32))
    assert np.array_equal(paused[0], paused[3])  # speed 0 holds a single source frame


@_needs_ffmpeg
def test_video_contain_letterboxes(assets):
    _job, _ip, _iu, _vu, vid_path = assets
    out = S.video(2, 80, 40, 10, asset_path=vid_path, fit="contain", src0=0.0, opacity=np.ones(2, np.float32))
    assert (out[0, ..., 3] == 0).any() and (out[0, ..., 3] == 255).any()  # transparent bars + opaque content


# --------------------------------------------------------------------------- #
# Through the render DAG
# --------------------------------------------------------------------------- #
def test_image_layer_through_dag_and_stream(assets):
    job, _ip, img_url, *_ = assets
    g = {"version": 1, "nodes": [
        {"id": "im", "type": "image", "data": {"assetUrl": img_url, "fit": "cover", "ports": {}}},
        {"id": "o", "type": "output", "data": {}},
    ], "edges": [_edge("im", "o", "video")]}
    G.validate(g)
    whole = G._Dag(job, SEG, g, NOAUDIO, OUT).video("o")
    assert whole.shape[-1] == 4 and whole[..., 3].min() == 255  # opaque RGBA layer
    streamed = np.concatenate([f for *_, f in G._Dag(job, SEG, g, NOAUDIO, OUT).stream_blocks("o", 7)])
    assert np.array_equal(whole, streamed)  # image is deterministic -> exact


def test_fluid_over_image_composites(assets):
    job, _ip, img_url, *_ = assets
    ports = {k: {"binding": {"kind": "const", "value": v}} for k, v in [("emit", 0.5), ("force", 30), ("radius", 0.1)]}
    g = {"version": 1, "nodes": [
        {"id": "f1", "type": "fluid", "data": {"static": {"points": [[0.5, 0.5]]}, "ports": ports}},
        {"id": "im", "type": "image", "data": {"assetUrl": img_url, "fit": "cover", "ports": {}}},
        {"id": "cb", "type": "combine", "data": {"mode": "stack",
         "inputs": [{"id": "s0", "opacity": 1.0}, {"id": "s1", "opacity": 1.0}]}},
        {"id": "o", "type": "output", "data": {}},
    ], "edges": [_edge("f1", "cb", "s0"), _edge("im", "cb", "s1"), _edge("cb", "o", "video")]}
    G.validate(g)
    flat = G.fluid.flatten(G._Dag(job, SEG, g, NOAUDIO, OUT).video("o"))
    assert np.array_equal(flat[0, 2, 2], [30, 120, 200])  # a corner (no dye) shows the image behind


def test_reachable_assets_collects_image_video_urls(monkeypatch):
    """cache_gc keeps the asset files that saved projects' image/video nodes reference."""
    from backend import cache_gc
    proj = {"job_id": "proj1", "data": {"segments": [{"graph": {"nodes": [
        {"type": "image", "data": {"assetUrl": "/assets/proj1/aaa.png"}},
        {"type": "video", "data": {"assetUrl": "/assets/proj1/bbb.mp4"}},
        {"type": "fluid", "data": {}},
    ]}}]}}
    monkeypatch.setattr(cache_gc.db, "list_projects", lambda: [{"job_id": "proj1"}])
    monkeypatch.setattr(cache_gc.db, "get_project", lambda jid: proj if jid == "proj1" else None)
    assert {p.name for p in cache_gc.reachable_assets()} == {"aaa.png", "bbb.mp4"}


@_needs_ffmpeg
def test_video_layer_through_dag(assets):
    job, _ip, _iu, vid_url, _vp = assets
    g = {"version": 1, "nodes": [
        {"id": "vd", "type": "video", "data": {"assetUrl": vid_url, "fit": "cover", "sync": "segment", "ports": {}}},
        {"id": "o", "type": "output", "data": {}},
    ], "edges": [_edge("vd", "o", "video")]}
    G.validate(g)
    whole = G._Dag(job, SEG, g, NOAUDIO, OUT).video("o")
    assert whole.shape == (24, 81, 64, 4) and not np.array_equal(whole[0], whole[10])
    streamed = np.concatenate([f for *_, f in G._Dag(job, SEG, g, NOAUDIO, OUT).stream_blocks("o", 8)])
    assert np.abs(whole.astype(int) - streamed.astype(int)).mean() < 1.0  # ~exact (ffmpeg seam jitter only)


@_needs_ffmpeg
def test_video_modulated_speed_stays_continuous_across_blocks(assets):
    """A speed port wired to an LFO time-warps the clip; the block-streamed render must
    match the whole-clip one — the block handler integrates speed over the WHOLE segment
    so each block's source-time origin is continuous (a per-block reset would desync)."""
    job, _ip, _iu, vid_url, _vp = assets
    g = {"version": 1, "nodes": [
        {"id": "lfo", "type": "lfo", "data": {"shape": "sine", "rateMode": "cycles", "rate": 2}},
        {"id": "vd", "type": "video", "data": {"assetUrl": vid_url, "fit": "cover", "sync": "segment",
         "ports": {"speed": {"binding": {"kind": "node", "nodeId": "lfo", "lo": 0.5, "hi": 3.0}}}}},
        {"id": "o", "type": "output", "data": {}},
    ], "edges": [_edge("lfo", "vd", "speed"), _edge("vd", "o", "video")]}
    G.validate(g)
    whole = G._Dag(job, SEG, g, NOAUDIO, OUT).video("o")
    streamed = np.concatenate([f for *_, f in G._Dag(job, SEG, g, NOAUDIO, OUT).stream_blocks("o", 7)])
    assert whole.shape == streamed.shape
    assert np.abs(whole.astype(int) - streamed.astype(int)).mean() < 1.5  # continuous across seams
