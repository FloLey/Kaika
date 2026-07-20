"""The libx264 knobs: preset, CRF, and which renders get the quality one.

We used to pass neither `-preset` nor `-crf`, so every clip silently inherited ffmpeg's
defaults (`medium`, crf 23). Measured on a 4K clip against a lossless reference, `faster`
is 1.46x the speed of `medium` at a marginally BETTER SSIM (0.98241 vs 0.98218), and CRF
is the knob that should differ by purpose — an export is archived and watched full-screen,
a card preview is a thumbnail re-encoded on every edit.

Two things are worth guarding and one is not obvious: an argument-list assertion proves
we BUILT the flag, not that ffmpeg honoured it. `test_a_lower_crf_really_reaches_ffmpeg`
does a real encode of the same frames at two CRFs and compares the bytes produced.
"""

import subprocess

import numpy as np
import pytest

from backend import fluid, song_render as SR


def test_both_channel_paths_carry_the_preset_and_the_requested_crf():
    for channels in (3, 4):
        args = fluid._encode_args(64, 64, 24, 64, 64, channels, crf=18)
        assert "-preset" in args and args[args.index("-preset") + 1] == "faster"
        assert "-crf" in args and args[args.index("-crf") + 1] == "18"
    # The RGBA path must keep composing over black rather than dropping alpha — the
    # quality flags must not have displaced that (see test_flatten_contract).
    rgba = fluid._encode_args(64, 64, 24, 64, 64, 4)
    assert "color=black" in " ".join(rgba) and "overlay" in " ".join(rgba)


def test_the_default_is_the_preview_crf_not_the_export_one():
    args = fluid._encode_args(64, 64, 24, 64, 64)
    assert args[args.index("-crf") + 1] == str(fluid.CRF_DEFAULT)
    assert fluid.CRF_EXPORT < fluid.CRF_DEFAULT  # lower CRF = higher quality


def test_crf_from_output_reads_the_output_settings():
    assert fluid.crf_from_output(None) == fluid.CRF_DEFAULT
    assert fluid.crf_from_output({}) == fluid.CRF_DEFAULT  # a card preview
    assert fluid.crf_from_output({"crf": 18}) == 18


def test_an_export_asks_for_the_quality_crf_through_the_shared_contract():
    """`output_from_export` is THE lockstep anchor between the whole-song export and the
    single-segment HD export, so putting the CRF here is what keeps them identical."""
    assert SR.output_from_export({})["crf"] == fluid.CRF_EXPORT


def test_the_export_crf_is_part_of_the_cache_key():
    """It rides in the OUTPUT dict on purpose: `output_hash` folds that dict in whole, so
    changing the export quality re-keys every HD entry by itself — no RENDER_VERSION bump,
    and no cached clip served at the old quality."""
    from backend import graph as G

    graph = {
        "version": 27,
        "nodes": [{"id": "o", "type": "output", "data": {}}],
        "edges": [],
    }
    seg = {"start": 0.0, "end": 1.0, "signals": []}
    base = SR.output_from_export({})
    other = {**base, "crf": base["crf"] + 3}
    assert G.output_hash("j", seg, graph, "o", base) != G.output_hash("j", seg, graph, "o", other)


@pytest.mark.skipif(
    subprocess.run(["which", "ffmpeg"], capture_output=True).returncode != 0,
    reason="needs system ffmpeg",
)
def test_a_lower_crf_really_reaches_ffmpeg(tmp_path):
    """The arg-list tests above prove we BUILT the flag. This proves ffmpeg obeyed it:
    the same frames at CRF 18 must encode to a bigger file than at CRF 30. Detail-rich
    noise, because a flat gradient compresses to nothing at either setting."""
    rng = np.random.default_rng(0)
    frames = rng.integers(0, 255, (12, 128, 128, 3), dtype=np.uint8)
    sizes = {}
    for crf in (18, 30):
        out = tmp_path / f"c{crf}.mp4"
        fluid.render_mp4(frames, 12, out, 128, 128, crf=crf)
        sizes[crf] = out.stat().st_size
    assert sizes[18] > sizes[30] * 1.2, f"CRF did not reach the encoder: {sizes}"
