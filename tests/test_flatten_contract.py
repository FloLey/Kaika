"""The exact pixels `flatten` and `apply_video_opacity` produce.

These two are 73% of a 4K montage render (measured: 75.9s + 21.4s of 133s), and both are
about to gain fast paths. Nothing pinned them at PARTIAL alpha before — the only existing
test (`test_graph_lyrics.py:87`) uses alpha=255, which is precisely the case where every
plausible implementation agrees. A premultiply (`rgb * a`, what flatten does) and an
alpha-drop (what ffmpeg's rgba->yuv420p does) are indistinguishable there and differ
everywhere else, so an optimisation could swap one for the other and stay green.

These tests exist to be COPIED FORWARD unchanged: any fast path must reproduce them
byte-for-byte.
"""

from __future__ import annotations

import numpy as np

from backend import fluid, sources


def _rgba(rgb: tuple, alpha: int, shape=(1, 2, 2)) -> np.ndarray:
    f = np.zeros((*shape, 4), np.uint8)
    f[..., 0], f[..., 1], f[..., 2] = rgb
    f[..., 3] = alpha
    return f


def test_flatten_premultiplies_by_alpha_it_does_not_drop_it():
    """The whole point: a half-transparent white must come out GREY, not white.

    An alpha-drop (`frames[..., :3]`) would return 255 here — the exact bug an ffmpeg
    `-pix_fmt rgba` swap would introduce, silently, on every semi-transparent lyric.
    """
    for alpha, expected in ((0, 0), (64, 64), (128, 128), (255, 255)):
        out = fluid.flatten(_rgba((255, 255, 255), alpha))
        assert out.shape[-1] == 3
        assert int(out.max()) == int(out.min()) == expected, f"alpha={alpha}"


def test_flatten_keeps_each_channel_independent():
    out = fluid.flatten(_rgba((200, 100, 50), 128))
    assert list(out[0, 0, 0]) == [100, 50, 25]


def test_flatten_passes_three_channel_frames_straight_through():
    rgb = np.arange(1 * 2 * 2 * 3, dtype=np.uint8).reshape(1, 2, 2, 3)
    assert fluid.flatten(rgb) is rgb  # zero-copy, by identity


def test_flatten_is_exact_across_the_whole_alpha_range():
    """Pin the rounding too — a fast path that computes in uint8 or uint16 would drift
    a level or two here, and a drift is a visible band on a fade."""
    frames = np.zeros((1, 1, 256, 4), np.uint8)
    frames[..., :3] = 255
    frames[0, 0, :, 3] = np.arange(256, dtype=np.uint8)
    out = fluid.flatten(frames)[0, 0, :, 0]
    expected = (np.arange(256, dtype=np.float32) / 255.0 * 255).astype(np.uint8)
    assert np.array_equal(out, expected)


def test_opacity_scales_alpha_and_leaves_colour_alone():
    out = _rgba((200, 100, 50), 255, shape=(3, 2, 2)).copy()
    sources.apply_video_opacity(out, np.array([1.0, 0.5, 0.0], np.float32))
    # 0.5 * 255 = 127.5, and the cast TRUNCATES — pin 127, not a rounded 128. A fast
    # path that rounded instead would shift every fade by a level.
    assert [int(out[i, 0, 0, 3]) for i in range(3)] == [255, 127, 0]
    assert list(out[1, 0, 0, :3]) == [200, 100, 50]  # RGB untouched


def test_opacity_is_per_frame_not_per_clip():
    out = _rgba((255, 255, 255), 200, shape=(2, 1, 1)).copy()
    sources.apply_video_opacity(out, np.array([1.0, 0.25], np.float32))
    assert [int(out[i, 0, 0, 3]) for i in range(2)] == [200, 50]


def test_opacity_mutates_in_place_and_returns_the_same_array():
    """The fast path returns early — so callers must already rely on in-place mutation
    rather than the return value. Pin that they are the same object."""
    out = _rgba((10, 20, 30), 255).copy()
    assert sources.apply_video_opacity(out, np.ones(1, np.float32)) is out


def test_opacity_of_one_is_the_identity():
    """What the fast path will shortcut. Green before and after, by construction."""
    before = _rgba((200, 100, 50), 137, shape=(4, 3, 3))
    after = before.copy()
    sources.apply_video_opacity(after, np.ones(4, np.float32))
    assert np.array_equal(after, before)


# ── the fast paths must be the SAME pixels, not merely plausible ones ─────────
#
# Both shortcuts below are guarded by a cheap test and skip real arithmetic. The only
# acceptable proof is byte equality against the arithmetic they skip, so these tests
# recompute the ORIGINAL formulas literally and compare.


def _flatten_the_slow_way(frames: np.ndarray) -> np.ndarray:
    f = frames.astype(np.float32) / 255.0
    a = np.clip(f[..., 3:4], 0.0, 1.0)
    return (np.clip(f[..., :3] * a, 0, 1) * 255).astype(np.uint8)


def _opacity_the_slow_way(out: np.ndarray, opacity) -> np.ndarray:
    op = np.asarray(opacity, np.float32).reshape(-1)[: out.shape[0], None, None]
    out[..., 3] = np.clip(out[..., 3].astype(np.float32) * op, 0, 255).astype(np.uint8)
    return out


def test_the_opaque_flatten_shortcut_is_byte_identical():
    rng = np.random.default_rng(7)
    frames = rng.integers(0, 256, (3, 8, 8, 4), dtype=np.uint8)
    frames[..., 3] = 255  # opaque: takes the shortcut
    assert np.array_equal(fluid.flatten(frames), _flatten_the_slow_way(frames))


def test_one_non_opaque_pixel_disables_the_shortcut():
    """The guard is all-or-nothing: a single translucent pixel must fall back to the
    real arithmetic, or a lyric's anti-aliased edge would render as a hard one."""
    rng = np.random.default_rng(8)
    frames = rng.integers(0, 256, (2, 4, 4, 4), dtype=np.uint8)
    frames[..., 3] = 255
    frames[1, 2, 2, 3] = 254  # one pixel, one level off
    assert np.array_equal(fluid.flatten(frames), _flatten_the_slow_way(frames))
    assert int(fluid.flatten(frames)[1, 2, 2].max()) < int(frames[1, 2, 2, :3].max())


def test_the_opacity_one_shortcut_is_byte_identical():
    rng = np.random.default_rng(9)
    frames = rng.integers(0, 256, (4, 5, 5, 4), dtype=np.uint8)
    fast = sources.apply_video_opacity(frames.copy(), np.ones(4, np.float32))
    slow = _opacity_the_slow_way(frames.copy(), np.ones(4, np.float32))
    assert np.array_equal(fast, slow)


def test_one_frame_below_one_disables_the_opacity_shortcut():
    rng = np.random.default_rng(10)
    frames = rng.integers(0, 256, (3, 4, 4, 4), dtype=np.uint8)
    op = np.array([1.0, 1.0, 0.5], np.float32)
    fast = sources.apply_video_opacity(frames.copy(), op)
    slow = _opacity_the_slow_way(frames.copy(), op)
    assert np.array_equal(fast, slow)
    assert int(fast[2, 0, 0, 3]) < int(frames[2, 0, 0, 3])  # it really did scale
