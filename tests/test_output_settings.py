"""Tests for project-level OUTPUT settings: the rectangular grid derivation, the
non-square simulate path, and the render-cache hash folding in `output`.

The original Kaika solver was rectangular; `backend.fluid` is now ported back to a
rectangular grid driven by the output size. These guard that port + the plumbing.
"""
import numpy as np

from backend import fluid, graph


# --------------------------------------------------------------------------- #
# Grid derivation (ported from Kaika's Canvas.grid / fft_friendly)
# --------------------------------------------------------------------------- #
def _smooth(n: int) -> bool:
    for p in (2, 3, 5):
        while n % p == 0:
            n //= p
    return n == 1


def test_fft_friendly_is_235_smooth():
    for n in (50, 96, 113, 170, 171, 200, 341):
        assert _smooth(fluid.fft_friendly(n)), n


def test_grid_for_short_side_and_orientation():
    # Portrait: width < height -> short side (width) gets the cell budget, h > w.
    h, w = fluid.grid_for(1080, 1920, 96)
    assert w == 96 and h > w and _smooth(w) and _smooth(h)
    # Landscape mirrors it.
    h2, w2 = fluid.grid_for(1920, 1080, 96)
    assert h2 == 96 and w2 > h2
    # Square stays square.
    assert fluid.grid_for(1080, 1080, 96) == (96, 96)


def test_grid_from_output_quality_presets():
    base = {"width": 1080, "height": 1080}
    assert fluid.grid_from_output({**base, "quality": "draft"}) == (64, 64)
    assert fluid.grid_from_output({**base, "quality": "normal"}) == (96, 96)
    assert fluid.grid_from_output({**base, "quality": "high"}) == (144, 144)


# --------------------------------------------------------------------------- #
# Non-square simulate
# --------------------------------------------------------------------------- #
def _params(output):
    return {"duration": 0.4, "output": output,
            "source": {"emit": 0.4, "force": 20}, "fluid": {}}


def test_simulate_portrait_frames_are_taller_than_wide():
    out = {"width": 1080, "height": 1920, "quality": "draft", "fps": 10}
    frames, fps, (h, w) = fluid.simulate(_params(out))
    assert frames.ndim == 4 and frames.shape[3] == 3
    assert frames.shape[1] == h and frames.shape[2] == w
    assert h > w                      # portrait: taller than wide
    assert fps == 10


def test_simulate_landscape_is_wider_than_tall():
    out = {"width": 1920, "height": 1080, "quality": "draft", "fps": 10}
    frames, _fps, (h, w) = fluid.simulate(_params(out))
    assert w > h


def test_legacy_square_grid_still_square():
    # FluidLab `/fluid` path: no `output`, a square `grid` -> square frames.
    frames, _fps, (h, w) = fluid.simulate(
        {"grid": 48, "fps": 10, "duration": 0.4,
         "source": {"color": [0.3, 0.7, 1.0], "emit": 0.4}, "fluid": {}})
    assert h == w == 48


def test_background_color_shows_through_empty_frame():
    # A disabled source emits no dye; the background color should fill the frame.
    out = {"width": 64, "height": 64, "quality": "draft", "fps": 8,
           "background": "#ff0000"}
    frames, _fps, _hw = fluid.simulate(
        {"duration": 0.3, "output": out, "source": {"enabled": False}, "fluid": {}})
    # Red channel high, green/blue low across the (dye-free) frame.
    f0 = frames[0]
    assert f0[..., 0].mean() > 200 and f0[..., 1].mean() < 40 and f0[..., 2].mean() < 40


# --------------------------------------------------------------------------- #
# Cache hash folds in output
# --------------------------------------------------------------------------- #
def _graph():
    fluid_node = {"id": "n-f", "type": "fluid", "x": 0, "y": 0,
                  "data": {"static": {}, "ports": {}}}
    out_node = {"id": "n-o", "type": "output", "x": 0, "y": 0, "data": {}}
    return {"version": 1, "nodes": [fluid_node, out_node],
            "edges": [{"id": "e", "source": "n-f", "sourcePort": "out",
                       "target": "n-o", "targetPort": "video"}]}


def test_graph_hash_changes_with_output():
    g = _graph()
    seg = {"start": 0.0, "end": 2.0, "signals": []}
    a = {"width": 1080, "height": 1920, "quality": "normal", "fps": 24, "background": "#000000"}
    h_portrait = graph.graph_hash("job", seg, g, a)
    h_landscape = graph.graph_hash("job", seg, g, {**a, "width": 1920, "height": 1080})
    h_quality = graph.graph_hash("job", seg, g, {**a, "quality": "high"})
    h_bg = graph.graph_hash("job", seg, g, {**a, "background": "#101830"})
    assert len({h_portrait, h_landscape, h_quality, h_bg}) == 4   # all distinct
    assert graph.graph_hash("job", seg, g, a) == h_portrait        # stable


def test_build_params_drives_grid_and_fps_from_output():
    g = _graph()
    seg = {"start": 0.0, "end": 2.0, "signals": []}
    out = {"width": 1080, "height": 1920, "quality": "draft", "fps": 30, "background": "#000000"}
    p = graph.build_params("job", seg, g, lambda j, s: None, out)
    assert p["fps"] == 30 and p["output"]["quality"] == "draft"
    assert "grid" not in p                       # output supersedes the legacy square grid
