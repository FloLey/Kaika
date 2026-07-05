"""Playground pipelines render, and every card is present.

For each pipeline in `card_demo.DEMOS` (the exported `playground_pipelines.json`, one per
card) render it and assert it produces a non-empty frame — i.e. the card is wired into a
valid pipeline that actually shows something. Uses `graph._Dag(...).video()` (no ffmpeg)
so all of them check in a couple of seconds. A small synthetic drum stem backs the
`signal` card's referenced signal.
"""

import numpy as np
import pytest
import soundfile as sf

from backend import card_demo, graph

OUT = {"fps": 8, "width": 120, "height": 120, "quality": "draft", "background": "#000000"}
LINES = [{"t0": 0.0, "t1": 1.0, "text": "playground lyrics"}]


@pytest.fixture(scope="module")
def stem_path(tmp_path_factory):
    """A 1 s synthetic drum WAV + resolver, so the `signal` card extracts a real curve."""
    d = tmp_path_factory.mktemp("stems")
    sr = 44100
    sig = np.zeros(sr, dtype=np.float32)
    n = int(0.1 * sr)
    env = np.exp(-np.arange(n) / (0.04 * sr))
    for k in range(4):
        i0 = int(k * 0.25 * sr)
        sig[i0 : i0 + n] += np.sin(2 * np.pi * 60 * np.arange(n) / sr) * env
    sf.write(str(d / "drums.wav"), sig, sr)

    def resolve(_job, stem):
        p = d / f"{stem}.wav"
        return p if p.exists() else None

    return resolve


def _frames(demo, stem):
    g = demo["graph"]
    graph.validate(g)
    seg = {"start": 0.0, "end": 1.0, "signals": demo["signals"]}
    if any(n.get("type") == "lyrics" for n in g["nodes"]):
        seg["lyric_lines"] = LINES
    out_id = next(n["id"] for n in g["nodes"] if n["type"] == "output")
    return graph._Dag("playground", seg, g, stem, OUT).video(out_id)


@pytest.mark.parametrize("demo", card_demo.DEMOS, ids=[d["key"] for d in card_demo.DEMOS])
def test_pipeline_renders(demo, stem_path):
    frames = _frames(demo, stem_path)
    assert frames.ndim == 4 and frames.shape[0] >= 1, demo["key"]
    assert int(frames.max()) > 0, f"{demo['key']} pipeline rendered an empty (all-black) frame"


@pytest.mark.parametrize("demo", card_demo.DEMOS, ids=[d["key"] for d in card_demo.DEMOS])
def test_pipeline_actually_uses_its_card(demo):
    """The pipeline built to exercise card X must CONTAIN a node of type X — otherwise
    it renders (and passes coverage) without ever using the card it's meant to test.
    Every CARD_LABELS key is also the node `type`, so the key must appear among the
    graph's node types."""
    types = {n.get("type") for n in demo["graph"]["nodes"]}
    assert demo["key"] in types, (
        f"playground pipeline '{demo['key']}' has no node of type '{demo['key']}' — it "
        f"must include the card it exercises (graph has: {sorted(types)})"
    )


def test_every_card_is_present_in_the_playground():
    # `card_demo.ALL_CARDS` is the single source of truth (it also drives the import-time
    # warning). Every card — INCLUDING output — must have a pipeline.
    covered = {d["key"] for d in card_demo.DEMOS}
    missing = card_demo.ALL_CARDS - covered
    extra = covered - card_demo.ALL_CARDS
    assert not missing, f"cards missing a Playground pipeline: {sorted(missing)}"
    assert not extra, f"Playground has pipelines for unknown cards: {sorted(extra)}"
    assert not card_demo.missing_cards()
    from backend.graph import _VIDEO_HANDLERS

    # EVERY video card — including image/video (which demo a bundled sample asset) — must
    # have a Playground pipeline. Nothing is excluded from the Playground.
    assert set(_VIDEO_HANDLERS) <= covered, f"video cards missing: {sorted(set(_VIDEO_HANDLERS) - covered)}"
