"""The slideshow card: trigger-driven item switching (images AND video clips),
block-seam continuity, per-video in-point playback, hash coverage, and the merged
own+wired (Image gen) asset list."""

import shutil
import subprocess

import numpy as np
import pytest
from PIL import Image

from backend import graph as G
from backend import paths
from backend.graph_render import _slideshow_index, _slideshow_items
from backend.sources import SlideshowClip

_needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

OUT = {"width": 64, "height": 64, "quality": "draft", "fps": 12}
SEG = {"start": 0.0, "end": 1.0, "signals": []}
NOAUDIO = lambda j, s: None  # noqa: E731


def _edge(s, t, tp):
    return {"id": f"{s}-{t}-{tp}", "source": s, "sourcePort": "out", "target": t, "targetPort": tp}


def _img_item(path, start=0.0):
    return {"path": path, "kind": "image", "start": start}


@pytest.fixture
def assets(tmp_path, monkeypatch):
    """Two solid-colour stills under a patched ASSETS_DIR."""
    monkeypatch.setattr(paths, "ASSETS_DIR", tmp_path)
    d = tmp_path / "job"
    d.mkdir()
    Image.new("RGB", (8, 8), (255, 0, 0)).save(d / "red.png")
    Image.new("RGB", (8, 8), (0, 0, 255)).save(d / "blue.png")
    return ["/assets/job/red.png", "/assets/job/blue.png"]


@pytest.fixture
def video_asset(tmp_path, monkeypatch):
    """A short time-varying test clip (`testsrc`, 10 fps) under a patched ASSETS_DIR — its
    frames differ over time, so we can tell a video slide is PLAYING (not frozen) and
    that a run restarts at the in-point."""
    monkeypatch.setattr(paths, "ASSETS_DIR", tmp_path)
    d = tmp_path / "job"
    d.mkdir(exist_ok=True)
    Image.new("RGB", (8, 8), (255, 0, 0)).save(d / "red.png")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
         "-i", "testsrc=size=32x32:rate=10:duration=3", "-pix_fmt", "yuv420p", str(d / "clip.mp4")],
        check=True)
    return "/assets/job/red.png", "/assets/job/clip.mp4"


def test_index_advances_on_rising_edges_and_wraps():
    # trigger: rise at frame 2 and frame 5 -> image 0,0,1,1,1,0(wrap),...
    trig = np.array([0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0], np.float32)
    idx = _slideshow_index(trig, 2, {"threshold": 0.5, "hysteresis": 0.0})
    assert idx.tolist() == [0, 0, 1, 1, 1, 0, 0]


def test_index_starts_on_image_zero_even_if_trigger_starts_high():
    trig = np.ones(4, np.float32)
    idx = _slideshow_index(trig, 3, {"threshold": 0.5, "hysteresis": 0.0})
    assert idx.tolist() == [0, 0, 0, 0]  # no rise after frame 0 -> stays on image 0


def test_slideshow_frames_show_the_indexed_item(assets, tmp_path):
    items = [_img_item(str(tmp_path / "job" / "red.png")),
             _img_item(str(tmp_path / "job" / "blue.png"))]
    idx = np.array([0, 0, 1, 1])
    clip = SlideshowClip(8, 8, 12, items=items, index=idx)
    try:
        out = clip.frames(0, 4, np.ones(4, np.float32))
    finally:
        clip.close()
    assert out.shape == (4, 8, 8, 4)
    assert out[0, 4, 4, 0] > 200 and out[0, 4, 4, 2] < 50  # red first
    assert out[3, 4, 4, 2] > 200 and out[3, 4, 4, 0] < 50  # blue after the switch


def test_missing_assets_render_transparent_not_fatal():
    items = [_img_item(""), _img_item("/nope.png")]
    clip = SlideshowClip(8, 8, 12, items=items, index=np.zeros(2, int))
    out = clip.frames(0, 2, np.ones(2, np.float32))
    clip.close()
    assert out.sum() == 0  # fully transparent, no exception


@_needs_ffmpeg
def test_video_item_plays_and_run_restarts_at_in_point(video_asset):
    """A video slide advances while visible (frames differ), and each time the slideshow
    returns to it the playhead restarts at the in-point — so the first frame of two
    separate runs of the same video is identical."""
    img_url, vid_url = video_asset
    img = str(paths.ASSETS_DIR / "job" / "red.png")
    vid = str(paths.ASSETS_DIR / "job" / "clip.mp4")
    items = [_img_item(img), {"path": vid, "kind": "video", "start": 0.0}]
    # index: image, image, video, video, image, image, video, video — the video has two
    # runs (frames 2-3 and 6-7), each restarting at age 0.
    idx = np.array([0, 0, 1, 1, 0, 0, 1, 1])
    clip = SlideshowClip(32, 32, 10, items=items, index=idx)
    try:
        out = clip.frames(0, 8, np.ones(8, np.float32))
    finally:
        clip.close()
    assert not np.array_equal(out[2], out[3])  # the clip is playing (age 0 vs 1 differ)
    assert np.array_equal(out[2], out[6])  # both runs restart at the in-point (t=start)


@_needs_ffmpeg
def test_video_in_point_offsets_the_first_frame(video_asset):
    """A non-zero in-point starts the extract later in the clip — a different first frame."""
    vid = str(paths.ASSETS_DIR / "job" / "clip.mp4")
    idx = np.zeros(3, int)
    a = SlideshowClip(32, 32, 10, items=[{"path": vid, "kind": "video", "start": 0.0}], index=idx)
    b = SlideshowClip(32, 32, 10, items=[{"path": vid, "kind": "video", "start": 1.5}], index=idx)
    try:
        fa = a.frames(0, 1, np.ones(1, np.float32))
        fb = b.frames(0, 1, np.ones(1, np.float32))
    finally:
        a.close()
        b.close()
    assert not np.array_equal(fa[0], fb[0])  # start=1.5s shows a later, different frame


def test_block_streaming_matches_whole_clip(assets):
    g = {"version": 23, "nodes": [
        {"id": "lfo", "type": "lfo", "data": {"shape": "square", "rateMode": "cycles", "rate": 2, "duty": 0.5}},
        {"id": "ig", "type": "slideshow", "data": {
            "items": [{"url": assets[0], "kind": "image"}, {"url": assets[1], "kind": "image"}],
            "box_x": 0, "box_y": 0, "box_w": 1, "box_h": 1,
            "fit": "cover", "threshold": 0.5, "hysteresis": 0.1,
            "ports": {"trigger": {"binding": {"kind": "node", "nodeId": "lfo", "lo": 0, "hi": 1}}},
        }},
        {"id": "o", "type": "output", "data": {}},
    ], "edges": [_edge("lfo", "ig", "trigger"), _edge("ig", "o", "video")]}
    G.validate(g)
    whole = G._Dag("job", SEG, g, NOAUDIO, OUT).video("o")
    assert not np.array_equal(whole[0], whole[-1])  # the slideshow actually switched
    streamed = np.concatenate([f for *_, f in G._Dag("job", SEG, g, NOAUDIO, OUT).stream_blocks("o", 5)])
    assert np.array_equal(whole, streamed)  # image-only seams are exact (pure indexing)


@_needs_ffmpeg
def test_mixed_video_slideshow_block_matches_whole_clip(video_asset):
    """The lockstep invariant with a VIDEO item: a trigger cycles image/video/image so a
    video run crosses block seams and is revisited. Streamed == whole-clip (± ffmpeg seek
    jitter at the seams), which fails if `age`/`run_id` were computed per block."""
    img_url, vid_url = video_asset
    seg = {"start": 0.0, "end": 2.0, "signals": []}
    out_cfg = {"width": 48, "height": 48, "quality": "draft", "fps": 10}
    g = {"version": 23, "nodes": [
        {"id": "lfo", "type": "lfo", "data": {"shape": "square", "rateMode": "cycles", "rate": 3, "duty": 0.5}},
        {"id": "sl", "type": "slideshow", "data": {
            "items": [{"url": img_url, "kind": "image"},
                      {"url": vid_url, "kind": "video", "start": 0.0},
                      {"url": img_url, "kind": "image"}],
            "box_x": 0, "box_y": 0, "box_w": 1, "box_h": 1, "fit": "cover",
            "threshold": 0.5, "hysteresis": 0.1,
            "ports": {"trigger": {"binding": {"kind": "node", "nodeId": "lfo", "lo": 0, "hi": 1}}},
        }},
        {"id": "o", "type": "output", "data": {}},
    ], "edges": [_edge("lfo", "sl", "trigger"), _edge("sl", "o", "video")]}
    G.validate(g)
    whole = G._Dag("job", seg, g, NOAUDIO, out_cfg).video("o")
    streamed = np.concatenate(
        [f for *_, f in G._Dag("job", seg, g, NOAUDIO, out_cfg).stream_blocks("o", 7)])
    assert whole.shape == streamed.shape
    assert np.abs(whole.astype(int) - streamed.astype(int)).mean() < 2.0  # ~exact (seam jitter)
    # the slideshow actually cycles through items (some frame differs from the first)
    assert any(not np.array_equal(whole[0], whole[i]) for i in range(1, len(whole)))


def test_asset_list_changes_bust_the_output_hash(assets):
    def graph_for(items):
        return {"version": 23, "nodes": [
            {"id": "ig", "type": "slideshow", "data": {"items": items, "ports": {}}},
            {"id": "o", "type": "output", "data": {}},
        ], "edges": [_edge("ig", "o", "video")]}

    full = [{"url": u, "kind": "image"} for u in assets]
    h1 = G.output_hash("job", SEG, graph_for(full), "o", OUT)
    h2 = G.output_hash("job", SEG, graph_for(full[:1]), "o", OUT)
    assert h1 != h2


def test_legacy_asseturls_still_render(assets):
    """A pre-v23 save (own picks in `assetUrls`, no `items`) still resolves to image
    items — the backend legacy fallback keeps old projects rendering."""
    g = {"version": 22, "nodes": [
        {"id": "sl", "type": "slideshow", "data": {"assetUrls": assets, "ports": {}}},
        {"id": "o", "type": "output", "data": {}},
    ], "edges": [_edge("sl", "o", "video")]}
    G.validate(g)
    dag = G._Dag("job", SEG, g, NOAUDIO, OUT)
    out = _slideshow_items(dag, dag.nodes["sl"])
    assert [it["kind"] for it in out] == ["image", "image"]
    assert out[0]["path"].endswith("red.png") and out[1]["path"].endswith("blue.png")


def test_wired_imagegen_list_feeds_the_slideshow(assets, tmp_path):
    """A generator card wired into the slideshow's `images` input appends its
    generated list (image items) after the slideshow's own picks."""
    g = {"version": 23, "nodes": [
        {"id": "gen", "type": "imagegen", "data": {"prompts": ["a", "b"], "seed": 1,
                                                    "assetUrls": [assets[1]]}},
        {"id": "sl", "type": "slideshow", "data": {
            "items": [{"url": assets[0], "kind": "image"}], "ports": {}}},
        {"id": "o", "type": "output", "data": {}},
    ], "edges": [_edge("gen", "sl", "images"), _edge("sl", "o", "video")]}
    G.validate(g)
    dag = G._Dag("job", SEG, g, NOAUDIO, OUT)
    out = _slideshow_items(dag, dag.nodes["sl"])
    assert len(out) == 2
    assert out[0]["path"].endswith("red.png") and out[1]["path"].endswith("blue.png")
    assert all(it["kind"] == "image" for it in out)


def test_imagegen_active_count_caps_the_passed_images(assets):
    """A wired gate sets `activeCount` on the imagegen: only the first N of its images
    pass to the slideshow (the extras are hidden, not deleted)."""
    g = {"version": 23, "nodes": [
        {"id": "gen", "type": "imagegen", "data": {
            "prompts": ["a", "b", "c"], "seed": 1,
            "assetUrls": [assets[0], assets[1], assets[0]], "activeCount": 2}},
        {"id": "sl", "type": "slideshow", "data": {"items": [], "ports": {}}},
        {"id": "o", "type": "output", "data": {}},
    ], "edges": [_edge("gen", "sl", "images"), _edge("sl", "o", "video")]}
    G.validate(g)
    dag = G._Dag("job", SEG, g, NOAUDIO, OUT)
    out = _slideshow_items(dag, dag.nodes["sl"])
    assert len(out) == 2  # the third image is hidden by the cap


def test_imagegen_empty_rows_dont_become_blank_slots(assets):
    """Ungenerated ("") rows in the index-aligned assetUrls never reach the slideshow."""
    g = {"version": 23, "nodes": [
        {"id": "gen", "type": "imagegen", "data": {
            "prompts": ["a", "b", "c"], "seed": 1,
            "assetUrls": [assets[0], "", assets[1]]}},
        {"id": "sl", "type": "slideshow", "data": {"items": [], "ports": {}}},
        {"id": "o", "type": "output", "data": {}},
    ], "edges": [_edge("gen", "sl", "images"), _edge("sl", "o", "video")]}
    G.validate(g)
    dag = G._Dag("job", SEG, g, NOAUDIO, OUT)
    out = _slideshow_items(dag, dag.nodes["sl"])
    assert len(out) == 2  # the "" slot is dropped, not rendered blank


# --------------------------------------------------------------------------- #
# The HD (Z-Image) ControlNet pipeline ships as txt2img + control, so stylize
# hand-rolls img2img on it by truncating the sigma schedule. A ControlNet only
# *guides* shape — it never *confines* generation — so dropping the pure-noise
# sigma is what keeps the output anchored to its input.
# --------------------------------------------------------------------------- #
Z_SIGMAS = [1.0, 0.875, 0.75, 0.625, 0.5, 0.375, 0.25, 0.125]


def test_zimage_sigmas_never_start_from_pure_noise():
    """Even at strength 1.0 the schedule drops sigma==1.0, so HD+control always anchors."""
    from backend.imagegen import _zimage_sigmas

    for strength in (1.0, 0.99, 0.85, 0.5, 0.05):
        sub = _zimage_sigmas(Z_SIGMAS, strength)
        assert sub, "schedule must never be empty"
        assert sub[0] < 1.0, f"strength={strength} started from pure noise (no img2img anchor)"
        assert sub == Z_SIGMAS[len(Z_SIGMAS) - len(sub):], "must be a tail of the full schedule"


def test_zimage_sigmas_lower_strength_starts_closer_to_the_input():
    """Less strength → start further down the schedule (less noise, fewer steps)."""
    from backend.imagegen import _zimage_sigmas

    strong = _zimage_sigmas(Z_SIGMAS, 1.0)
    weak = _zimage_sigmas(Z_SIGMAS, 0.5)
    assert weak[0] < strong[0] and len(weak) < len(strong)


def test_zimage_sigmas_single_step_schedule_is_returned_as_is():
    """Nothing to drop: a 1-entry schedule can't be anchored, and must not come back empty."""
    from backend.imagegen import _zimage_sigmas

    assert _zimage_sigmas([1.0], 1.0) == [1.0]
