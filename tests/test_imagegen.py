"""The slideshow card: trigger-driven image switching, block-seam continuity,
hash coverage, and the merged own+wired (Image gen) asset list."""

import numpy as np
import pytest
from PIL import Image

from backend import graph as G
from backend import paths
from backend.graph_render import _slideshow_index
from backend.sources import imagegen

OUT = {"width": 64, "height": 64, "quality": "draft", "fps": 12}
SEG = {"start": 0.0, "end": 1.0, "signals": []}
NOAUDIO = lambda j, s: None  # noqa: E731


def _edge(s, t, tp):
    return {"id": f"{s}-{t}-{tp}", "source": s, "sourcePort": "out", "target": t, "targetPort": tp}


@pytest.fixture
def assets(tmp_path, monkeypatch):
    """Two solid-colour stills under a patched ASSETS_DIR."""
    monkeypatch.setattr(paths, "ASSETS_DIR", tmp_path)
    d = tmp_path / "job"
    d.mkdir()
    Image.new("RGB", (8, 8), (255, 0, 0)).save(d / "red.png")
    Image.new("RGB", (8, 8), (0, 0, 255)).save(d / "blue.png")
    return ["/assets/job/red.png", "/assets/job/blue.png"]


def test_index_advances_on_rising_edges_and_wraps():
    # trigger: rise at frame 2 and frame 5 -> image 0,0,1,1,1,0(wrap),...
    trig = np.array([0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0], np.float32)
    idx = _slideshow_index(trig, 2, {"threshold": 0.5, "hysteresis": 0.0})
    assert idx.tolist() == [0, 0, 1, 1, 1, 0, 0]


def test_index_starts_on_image_zero_even_if_trigger_starts_high():
    trig = np.ones(4, np.float32)
    idx = _slideshow_index(trig, 3, {"threshold": 0.5, "hysteresis": 0.0})
    assert idx.tolist() == [0, 0, 0, 0]  # no rise after frame 0 -> stays on image 0


def test_slideshow_frames_show_the_indexed_image(assets, tmp_path):
    aps = [str(tmp_path / "job" / "red.png"), str(tmp_path / "job" / "blue.png")]
    ones = np.ones(4, np.float32)
    idx = np.array([0, 0, 1, 1])
    out = imagegen(4, 8, 8, asset_paths=aps, index=idx, opacity=ones)
    assert out.shape == (4, 8, 8, 4)
    assert out[0, 4, 4, 0] > 200 and out[0, 4, 4, 2] < 50  # red first
    assert out[3, 4, 4, 2] > 200 and out[3, 4, 4, 0] < 50  # blue after the switch


def test_missing_assets_render_transparent_not_fatal():
    ones = np.ones(2, np.float32)
    out = imagegen(2, 8, 8, asset_paths=["", "/nope.png"], index=np.zeros(2, int), opacity=ones)
    assert out.sum() == 0  # fully transparent, no exception


def test_block_streaming_matches_whole_clip(assets):
    g = {"version": 1, "nodes": [
        {"id": "lfo", "type": "lfo", "data": {"shape": "square", "rateMode": "cycles", "rate": 2, "duty": 0.5}},
        {"id": "ig", "type": "slideshow", "data": {
            "assetUrls": assets, "box_x": 0, "box_y": 0, "box_w": 1, "box_h": 1,
            "fit": "cover", "threshold": 0.5, "hysteresis": 0.1,
            "ports": {"trigger": {"binding": {"kind": "node", "nodeId": "lfo", "lo": 0, "hi": 1}}},
        }},
        {"id": "o", "type": "output", "data": {}},
    ], "edges": [_edge("lfo", "ig", "trigger"), _edge("ig", "o", "video")]}
    G.validate(g)
    whole = G._Dag("job", SEG, g, NOAUDIO, OUT).video("o")
    assert not np.array_equal(whole[0], whole[-1])  # the slideshow actually switched
    streamed = np.concatenate([f for *_, f in G._Dag("job", SEG, g, NOAUDIO, OUT).stream_blocks("o", 5)])
    assert np.array_equal(whole, streamed)  # block seams are exact (pure indexing)


def test_asset_list_changes_bust_the_output_hash(assets):
    def graph_for(urls):
        return {"version": 1, "nodes": [
            {"id": "ig", "type": "slideshow", "data": {"assetUrls": urls, "ports": {}}},
            {"id": "o", "type": "output", "data": {}},
        ], "edges": [_edge("ig", "o", "video")]}

    h1 = G.output_hash("job", SEG, graph_for(assets), "o", OUT)
    h2 = G.output_hash("job", SEG, graph_for(assets[:1]), "o", OUT)
    assert h1 != h2


def test_wired_imagegen_list_feeds_the_slideshow(assets, tmp_path):
    """A generator card wired into the slideshow's `images` input appends its
    generated list after the slideshow's own picks."""
    from backend.graph_render import _slideshow_paths

    g = {"version": 15, "nodes": [
        {"id": "gen", "type": "imagegen", "data": {"prompts": ["a", "b"], "seed": 1,
                                                    "assetUrls": [assets[1]]}},
        {"id": "sl", "type": "slideshow", "data": {"assetUrls": [assets[0]], "ports": {}}},
        {"id": "o", "type": "output", "data": {}},
    ], "edges": [_edge("gen", "sl", "images"), _edge("sl", "o", "video")]}
    G.validate(g)
    dag = G._Dag("job", SEG, g, NOAUDIO, OUT)
    paths_out = _slideshow_paths(dag, dag.nodes["sl"])
    assert len(paths_out) == 2
    assert paths_out[0].endswith("red.png") and paths_out[1].endswith("blue.png")
