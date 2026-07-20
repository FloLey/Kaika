"""Fluid-frame cache: raw sim frames are reused when only downstream params change.

The store/evict mechanics mirror `render_cache`; the interesting behaviour is the
wiring in `graph`: a downstream compositing edit (e.g. a combine layer's opacity)
must NOT re-run the (expensive, stateful) fluid sim, while a change to the fluid
physics must. We assert that by counting `FluidClip` constructions. CACHE_DIR is
redirected to a tmp dir so the tests never touch the real cache.
"""

from __future__ import annotations

import numpy as np
import pytest

from backend import fluid, fluid_cache

from helpers import no_audio as NOAUDIO
from backend import graph as G

OUT = {"width": 96, "height": 128, "quality": "draft", "fps": 24, "background": "#101418"}
SEG = {"start": 0.0, "end": 2.0, "signals": []}


@pytest.fixture(autouse=True)
def _tmp_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(fluid_cache, "CACHE_DIR", tmp_path / "fluid_cache")
    monkeypatch.setattr(fluid_cache, "ENABLED", True)


def _graph(opacity, force):
    # fluid -> stack combine (single layer) -> output. Editing the combine layer's
    # opacity is a downstream compositing change (must reuse the cached sim); editing
    # the fluid `force` changes the physics (must re-run).
    return {
        "version": 5,
        "nodes": [
            {
                "id": "f1",
                "type": "fluid",
                "data": {
                    "static": {"color": [0.3, 0.7, 1.0], "points": [[0.4, 0.4]]},
                    "ports": {
                        "force": {"binding": {"kind": "const", "value": force}},
                        "emit": {"binding": {"kind": "const", "value": 0.4}},
                        "radius": {"binding": {"kind": "const", "value": 0.09}},
                    },
                },
            },
            {
                "id": "cb",
                "type": "combine",
                "data": {
                    "mode": "stack",
                    "inputs": [{"id": "s0", "opacity": opacity}],
                    "medium": {},
                },
            },
            {"id": "o1", "type": "output", "data": {}},
        ],
        "edges": [
            {"id": "e1", "source": "f1", "sourcePort": "out", "target": "cb", "targetPort": "s0"},
            {
                "id": "e2",
                "source": "cb",
                "sourcePort": "out",
                "target": "o1",
                "targetPort": "video",
            },
        ],
    }


def _render(g, out=OUT):
    G.validate(g)
    dag = G.Dag("job", SEG, g, NOAUDIO, out)
    return np.concatenate([f for *_, f in dag.stream_blocks("o1", 12)])


def test_store_load_roundtrip():
    arr = np.arange(2 * 3 * 4 * 3, dtype=np.uint8).reshape(2, 3, 4, 3)
    assert fluid_cache.load("k") is None
    fluid_cache.store("k", arr)
    assert np.array_equal(np.array(fluid_cache.load("k")), arr)


def test_downstream_edit_reuses_sim_but_fluid_edit_reruns(monkeypatch):
    runs = {"n": 0}
    orig = fluid.FluidClip.__init__

    def spy(self, *a, **k):
        runs["n"] += 1
        orig(self, *a, **k)

    monkeypatch.setattr(fluid.FluidClip, "__init__", spy)

    def sims(fn):
        before = runs["n"]
        out = fn()
        return runs["n"] - before, out

    n1, base = sims(lambda: _render(_graph(1.0, 30)))
    n2, dimmed = sims(lambda: _render(_graph(0.5, 30)))  # downstream-only (opacity)
    n3, _ = sims(lambda: _render(_graph(1.0, 55)))  # fluid physics changed
    n4, back = sims(lambda: _render(_graph(1.0, 30)))  # original fluid, still cached

    assert (n1, n2, n3, n4) == (1, 0, 1, 0)
    assert not np.array_equal(base, dimmed)  # the composite really re-ran on cached frames
    assert np.array_equal(base, back)  # revert reproduces the original exactly


def test_streamed_matches_cached_whole(monkeypatch):
    """A cache populated by the whole-clip path serves byte-identical block slices."""
    g = _graph(0, 30)
    G.validate(g)
    whole = G.Dag("job", SEG, g, NOAUDIO, OUT).video("o1")  # stores fluid frames
    streamed = _render(g)  # hits the cache, slices per block
    assert np.array_equal(whole, streamed)
