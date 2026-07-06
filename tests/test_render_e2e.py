"""End-to-end render: graph -> _Dag -> fluid.simulate -> (mp4) (B8.1).

The frame pipeline runs without ffmpeg; the mp4 encode is gated on ffmpeg being
present so the suite still passes in a minimal CI image.
"""

import shutil

import numpy as np
import pytest

from backend import fluid, graph, paths

_OUTPUT = {"width": 64, "height": 64, "quality": "draft", "fps": 12, "background": "#000000"}
_SEG = {"start": 0.0, "end": 0.5, "signals": []}  # 0.5s @ 12fps -> 6 frames


def _stem_path(job_id, stem):
    return None  # const-only graph: no signals, so no audio is read


def _const_graph():
    fluid_node = {
        "id": "n-f",
        "type": "fluid",
        "x": 0,
        "y": 0,
        "data": {"static": {"enabled": True, "color": [0.3, 0.7, 1.0]}, "ports": {}},
    }
    out_node = {"id": "n-o", "type": "output", "x": 0, "y": 0, "data": {"title": "preview"}}
    return {
        "version": 2,
        "nodes": [fluid_node, out_node],
        "edges": [
            {
                "id": "e",
                "source": "n-f",
                "sourcePort": "out",
                "target": "n-o",
                "targetPort": "video",
            }
        ],
    }


def test_dag_resolves_fluid_to_uint8_frames():
    g = _const_graph()
    dag = graph._Dag("job", _SEG, g, _stem_path, _OUTPUT)
    frames = dag.video("n-f")
    gh, gw = fluid.grid_from_output(_OUTPUT)
    assert frames.shape == (6, gh, gw, 3)
    assert frames.dtype == np.uint8


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_render_writes_mp4_and_caches(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "ANIM_DIR", tmp_path)
    g = _const_graph()
    url = graph.render("job", _SEG, g, _stem_path, _OUTPUT)
    assert url.startswith("/fluid/") and url.endswith(".mp4")
    out = tmp_path / url.rsplit("/", 1)[1]
    assert out.exists() and out.stat().st_size > 0
    # Second call hits the cache: same url, no re-encode.
    assert graph.render("job", _SEG, g, _stem_path, _OUTPUT) == url


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_render_accepts_a_producer_id_directly(tmp_path, monkeypatch):
    # The per-node card preview renders a PRODUCER (fluid/combine) by its own id —
    # the sync path must accept it exactly like stream_blocks does (lockstep).
    monkeypatch.setattr(paths, "ANIM_DIR", tmp_path)
    g = _const_graph()
    url = graph.render("job", _SEG, g, _stem_path, _OUTPUT, "n-f")  # the fluid, not the output
    assert (tmp_path / url.rsplit("/", 1)[1]).exists()


def test_render_still_rejects_an_unwired_output():
    # An OUTPUT node with no video input is still a clean ValueError (an HTTP 400):
    # validate() catches it graph-wide before _render_target's own guard would.
    g = _const_graph()
    g["edges"] = []  # unwire the output
    with pytest.raises(ValueError, match="must be wired"):
        graph.render("job", _SEG, g, _stem_path, _OUTPUT, "n-o")
