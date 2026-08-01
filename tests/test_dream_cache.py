"""The Dream card's per-frame generation cache (specs/dream/02).

The load-bearing property is key CANONICALIZATION: a hold frame must not key against its
neighbouring part's prompt, or nudging one cut would invalidate two whole parts instead of
one transition's ramp — and the cache would buy nothing. Most of this file is about that.
"""

import time

import numpy as np
import pytest

from backend import dream_cache, imagegen, paths


@pytest.fixture(autouse=True)
def cache_dir(tmp_path, monkeypatch):
    """Patch `backend.paths` — the hard invariant — not a per-module constant."""
    monkeypatch.setattr(paths, "DREAM_CACHE_DIR", tmp_path / "dream_cache")
    return tmp_path / "dream_cache"


def _step(prompt_a="a", prompt_b=None, w=0.0, seed=1, scale=0.7):
    return {"prompt_a": prompt_a, "prompt_b": prompt_b, "w": w, "seed": seed, "scale": scale}


def _img(v=7, h=16, w=16):
    a = np.zeros((h, w, 3), np.uint8)
    a[..., 0] = v
    a[..., 1] = (v * 3) % 256
    return a


def _key(step, control=None, model="m", h=16, w=16):
    return dream_cache.frame_key(_img() if control is None else control, step, model, h, w)


# --------------------------------------------------------------------------- #
# Canonicalization
# --------------------------------------------------------------------------- #


def test_hold_frame_drops_the_other_prompt():
    """w == 0 means prompt_b never touches a pixel, so it must not touch the key."""
    assert _key(_step("a", "b", w=0.0)) == _key(_step("a", None, w=0.0))
    assert _key(_step("a", "zzz", w=0.0)) == _key(_step("a", "qqq", w=0.0))


def test_full_weight_collapses_onto_the_second_prompt():
    """w == 1 is prompt B alone — and must key identically to B as a hold frame, so the
    first frame after a transition shares its entry with the rest of the part."""
    assert _key(_step("a", "b", w=1.0)) == _key(_step("b", None, w=0.0))


def test_a_cut_nudge_only_invalidates_ramp_frames():
    """The whole point. Two schedules differing by where the cut sits: frames deep inside
    either part keep their keys; only the frames whose weight moved change."""
    hold_a = _key(_step("a", "b", w=0.0))
    hold_b = _key(_step("a", "b", w=1.0))
    ramp_before = _key(_step("a", "b", w=0.4))
    ramp_after = _key(_step("a", "b", w=0.6))
    assert hold_a == _key(_step("a", "b", w=0.0))  # unchanged by the nudge
    assert hold_b == _key(_step("a", "b", w=1.0))
    assert ramp_before != ramp_after  # the ramp DID move


def test_weight_is_quantized():
    """Float noise from a re-resolved curve must not bust a key."""
    assert _key(_step("a", "b", w=0.5)) == _key(_step("a", "b", w=0.50004))
    assert _key(_step("a", "b", w=0.5)) != _key(_step("a", "b", w=0.51))


def test_scale_is_quantized():
    assert _key(_step(scale=0.7)) == _key(_step(scale=0.70004))
    assert _key(_step(scale=0.7)) != _key(_step(scale=0.75))


def test_canonical_prompts_shape():
    assert dream_cache.canonical_prompts(_step("a", "b", w=0.0)) == ("a", "", 0.0)
    assert dream_cache.canonical_prompts(_step("a", "b", w=1.0)) == ("b", "", 0.0)
    assert dream_cache.canonical_prompts(_step("a", "b", w=0.25)) == ("a", "b", 0.25)


# --------------------------------------------------------------------------- #
# Key completeness — the silent-corruption guard
# --------------------------------------------------------------------------- #


def test_every_pipe_affecting_input_changes_the_key():
    """Anything that changes a generated pixel and is NOT in the key produces a wrong
    cached frame that looks plausible. This test fails when someone adds a parameter to
    the call and forgets the key."""
    base = _key(_step("a", "b", w=0.5))
    assert base != _key(_step("A", "b", w=0.5)), "prompt_a"
    assert base != _key(_step("a", "B", w=0.5)), "prompt_b"
    assert base != _key(_step("a", "b", w=0.5, seed=2)), "seed"
    assert base != _key(_step("a", "b", w=0.5, scale=0.9)), "control scale"
    assert base != _key(_step("a", "b", w=0.5), model="other"), "model"
    assert base != _key(_step("a", "b", w=0.5), h=32), "height"
    assert base != _key(_step("a", "b", w=0.5), w=32), "width"
    assert base != _key(_step("a", "b", w=0.5), control=_img(9)), "control image"


def test_the_init_image_and_its_keep_are_in_the_key():
    """A wired `video` changes every pixel, so it must key — and `keep` with it. Without
    an init there IS no keep in the call, so folding it in would split the cache on a
    value that changed nothing."""
    a = dream_cache.frame_key(_img(), _step(), "m", 16, 16, init_img=_img(3))
    b = dream_cache.frame_key(_img(), _step(), "m", 16, 16, init_img=_img(9))
    assert a != b, "the init image must key"
    no_init = dream_cache.frame_key(_img(), _step(), "m", 16, 16)
    assert a != no_init, "img2img and txt2img of the same frame are different pictures"

    strong = dict(_step(), keep=0.9)
    weak = dict(_step(), keep=0.2)
    assert dream_cache.frame_key(
        _img(), strong, "m", 16, 16, init_img=_img(3)
    ) != dream_cache.frame_key(_img(), weak, "m", 16, 16, init_img=_img(3))
    # …but with no init, keep is inert and must NOT split the cache
    assert dream_cache.frame_key(_img(), strong, "m", 16, 16) == dream_cache.frame_key(
        _img(), weak, "m", 16, 16
    )


def test_identical_control_frames_dedupe():
    """A still control gives identical keys across time — free reuse."""
    assert _key(_step(), control=_img(5)) == _key(_step(), control=_img(5))


# --------------------------------------------------------------------------- #
# Storage
# --------------------------------------------------------------------------- #


def test_round_trip_is_byte_identical():
    """PNG, not JPEG: a cache hit has to equal a miss exactly, or the parity the whole
    cache rests on is a lie."""
    frame = np.random.default_rng(0).integers(0, 256, (24, 32, 3), dtype=np.uint8)
    dream_cache.store("k1", frame)
    got = dream_cache.load("k1")
    assert got is not None
    assert np.array_equal(got, frame)


def test_miss_returns_none():
    assert dream_cache.load("nope") is None


def test_store_does_not_evict(cache_dir):
    """store() is called once per FRAME; globbing the directory each time would cost more
    than it saves. The caller evicts once per job."""
    for i in range(5):
        dream_cache.store(f"k{i}", _img())
    assert len(list(cache_dir.glob("*.png"))) == 5


def test_evict_bounds_by_age(cache_dir):
    dream_cache.store("old", _img())
    p = next(cache_dir.glob("old.png"))
    old = time.time() - 40 * 86400
    import os

    os.utime(p, (old, old))
    dream_cache.store("new", _img())
    dream_cache.evict(max_age_days=14)
    names = {q.stem for q in cache_dir.glob("*.png")}
    assert names == {"new"}


def test_evict_sweeps_abandoned_temp_files(cache_dir):
    cache_dir.mkdir(parents=True, exist_ok=True)
    tmp = cache_dir / "x.123.abc.tmp.png"
    tmp.write_bytes(b"junk")
    import os

    old = time.time() - 3600
    os.utime(tmp, (old, old))
    dream_cache.evict()
    assert not tmp.exists()


def test_clear_removes_everything(cache_dir):
    for i in range(3):
        dream_cache.store(f"k{i}", _img())
    assert dream_cache.clear() == 3
    assert not list(cache_dir.glob("*.png"))


def test_disabled_bypasses_cleanly(monkeypatch, cache_dir):
    monkeypatch.setattr(dream_cache, "ENABLED", False)
    dream_cache.store("k", _img())
    assert dream_cache.load("k") is None
    assert not cache_dir.exists() or not list(cache_dir.glob("*.png"))


# --------------------------------------------------------------------------- #
# Wiring into dream_frames
# --------------------------------------------------------------------------- #


class FakePipe:
    def __init__(self):
        self.calls = []
        self._execution_device = "cpu"

    def encode_prompt(self, prompt, device, num, cfg):
        """Conditioning is built once per job now, from a cached encode that EVERY frame
        uses — holds included — so a pipe that reaches the loop has to offer this. These
        tests only count calls and cache hits; the values are irrelevant."""
        import torch

        return torch.zeros((1, 77, 4)), None

    def __call__(self, **kw):
        self.calls.append(kw)
        img = np.zeros((kw["height"], kw["width"], 3), np.uint8)
        img[..., 0] = len(self.calls) * 10
        return type(
            "R",
            (),
            {"images": [type("I", (), {"__array__": lambda s, dtype=None, copy=None: img})()]},
        )()


@pytest.fixture
def fake_pipe(monkeypatch):
    pipe = FakePipe()
    monkeypatch.setattr(imagegen, "_load_stylize_pipe", lambda *a, **k: pipe)
    return pipe


def _control(n=3, h=64, w=64):
    c = np.zeros((n, h, w, 3), np.uint8)
    for i in range(n):
        c[i, :, :, 1] = i * 10
    return c


def test_second_run_is_all_hits(fake_pipe):
    plan = [_step(seed=i) for i in range(3)]
    first = imagegen.dream_frames(_control(3), plan, short=256)
    assert len(fake_pipe.calls) == 3
    fake_pipe.calls.clear()
    second = imagegen.dream_frames(_control(3), plan, short=256)
    assert fake_pipe.calls == []  # nothing re-diffused
    assert np.array_equal(first, second)


def test_progress_still_counts_on_a_warm_run(fake_pipe):
    """A cached run that reported nothing would look hung to the card."""
    plan = [_step(seed=i) for i in range(3)]
    imagegen.dream_frames(_control(3), plan, short=256)
    seen = []
    imagegen.dream_frames(
        _control(3), plan, short=256, on_progress=lambda d, t: seen.append((d, t))
    )
    assert seen == [(1, 3), (2, 3), (3, 3)]


def test_editing_one_prompt_leaves_the_others_cached(fake_pipe):
    """Editing prompt 3 of 5 must not re-diffuse prompts 1, 2, 4 and 5."""
    plan = [_step(f"p{i}", seed=i) for i in range(5)]
    imagegen.dream_frames(_control(5), plan, short=256)
    fake_pipe.calls.clear()
    plan[2] = _step("p2-edited", seed=2)
    imagegen.dream_frames(_control(5), plan, short=256)
    assert len(fake_pipe.calls) == 1


def test_remote_gets_only_the_misses_and_fills_the_local_cache(monkeypatch, fake_pipe):
    """The frame cache stays CLIENT-side: a remote run must skip frames already cached,
    ship only the misses, and store what comes back — so a re-run after a small edit
    goes nowhere near the network."""
    from backend import remote_client, settings as app_settings

    plan = [_step(f"p{i}", seed=i) for i in range(4)]
    imagegen.dream_frames(_control(4), plan[:2], short=256)  # warm two of the four
    calls = {}

    def fake_remote(
        control,
        sub_plan,
        model,
        short,
        url,
        token,
        init=None,
        on_progress=None,
        should_cancel=None,
    ):
        calls["n"] = len(sub_plan)
        calls["prompts"] = [s["prompt_a"] for s in sub_plan]
        return np.stack([np.full((256, 256, 3), 40 + i, np.uint8) for i in range(len(sub_plan))])

    monkeypatch.setattr(remote_client, "dream_remote", fake_remote)
    monkeypatch.setattr(app_settings, "remote_endpoint", lambda op: ("http://gpu", "tok"))
    fake_pipe.calls.clear()

    out = imagegen.dream_frames(_control(4), plan, short=256)
    assert calls["n"] == 2, "cached frames were re-sent to the remote box"
    assert calls["prompts"] == ["p2", "p3"]
    assert fake_pipe.calls == [], "remote run still ran the local pipe"

    # what came back is now cached locally: a second run needs neither pipe nor network
    monkeypatch.setattr(app_settings, "remote_endpoint", lambda op: None)
    again = imagegen.dream_frames(_control(4), plan, short=256)
    assert fake_pipe.calls == []
    assert np.array_equal(out, again)


def test_pipe_is_not_loaded_at_all_when_every_frame_hits(monkeypatch):
    """An all-hits run must not pay for 6 GB of weights."""
    pipe = FakePipe()
    monkeypatch.setattr(imagegen, "_load_stylize_pipe", lambda *a, **k: pipe)
    plan = [_step(seed=1)]
    imagegen.dream_frames(_control(1), plan, short=256)

    def boom(*a, **k):
        raise AssertionError("loaded the pipe on an all-hits run")

    monkeypatch.setattr(imagegen, "_load_stylize_pipe", boom)
    imagegen.dream_frames(_control(1), plan, short=256)
