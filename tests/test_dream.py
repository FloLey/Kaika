"""The Dream card's inference core (specs/dream/01): pure txt2img + ControlNet driven by
a per-frame plan, and the prompt-embedding crossfade.

Everything here runs against a FAKE pipe. The real models are 6 GB and a diffusion call
per frame; what these tests protect is the contract between the plan and the pipe — which
kwargs are handed over, that the crossfade's endpoints take the pipeline's own encode
path, and that a missing ControlNet is refused rather than silently degraded."""

import numpy as np
import pytest

from backend import imagegen, paths


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path, monkeypatch):
    """Every test here must miss the frame cache — these assert on what reaches the PIPE,
    and a warm entry would skip the call. Patches `backend.paths` (the hard invariant), so
    a run never touches the real data dir either."""
    monkeypatch.setattr(paths, "DREAM_CACHE_DIR", tmp_path / "dream_cache")


class FakePipe:
    """Records every __call__ kwarg. `images[0]` is a solid frame whose R channel encodes
    the call index, so a caller can prove frame i came from call i.

    Carries just enough of a VAE / image processor / scheduler for the SEEDED path to
    build its start latent: that path encodes the source, reads the schedule's first
    sigma, and blends. The stubs are deliberately trivial (latents of zeros, a linear
    sigma ramp) — what these tests pin is the CONTRACT with the pipeline, not the
    arithmetic, which `test_keep_mask_*` covers directly on real numpy."""

    LATENT_CH = 4

    def __init__(self):
        self.calls = []
        self._execution_device = "cpu"
        self.vae = _FakeVae()
        self.image_processor = _FakeImageProcessor()
        self.scheduler = _FakeScheduler()

    def get_timesteps(self, steps, strength, device):
        n = max(1, int(steps * strength))
        return list(range(n)), n

    def __call__(self, **kw):
        self.calls.append(kw)
        h, w = kw["height"], kw["width"]
        img = np.zeros((h, w, 3), np.uint8)
        img[..., 0] = len(self.calls)
        return type("R", (), {"images": [_ImageLike(img)]})()


class _FakeVae:
    config = type("C", (), {"scaling_factor": 0.18215, "shift_factor": 0.0})()
    dtype = None

    def encode(self, px):
        import torch

        z = torch.zeros((1, FakePipe.LATENT_CH, px.shape[-2] // 8, px.shape[-1] // 8))
        return type("O", (), {"latent_dist": type("D", (), {"mode": lambda s: z})()})()


class _FakeImageProcessor:
    def preprocess(self, img, height, width):
        import torch

        return torch.zeros((1, 3, height, width))


class _FakeScheduler:
    begin_index = 0
    step_index = 0

    def __init__(self):
        import torch

        self.sigmas = torch.linspace(14.6, 0.1, 12)

    def set_timesteps(self, *a, **kw):
        pass


class _ImageLike:
    """Quacks like a PIL image for `np.asarray`."""

    def __init__(self, arr):
        self._arr = arr

    def __array__(self, dtype=None, copy=None):
        return self._arr if dtype is None else self._arr.astype(dtype)


@pytest.fixture
def fake_pipe(monkeypatch):
    pipe = FakePipe()
    monkeypatch.setattr(imagegen, "_load_stylize_pipe", lambda *a, **k: pipe)
    return pipe


def _control(n=3, h=64, w=64):
    """A control clip whose frames differ, so a mis-indexed control is visible."""
    c = np.zeros((n, h, w, 3), np.uint8)
    for i in range(n):
        c[i, :, :, 1] = i * 10
    return c


def _step(prompt_a="a", prompt_b=None, w=0.0, seed=1, scale=0.7):
    return {"prompt_a": prompt_a, "prompt_b": prompt_b, "w": w, "seed": seed, "scale": scale}


# --------------------------------------------------------------------------- #
# dream_frames: the plan drives the pipe
# --------------------------------------------------------------------------- #


def test_one_call_per_plan_entry(fake_pipe):
    out = imagegen.dream_frames(_control(3), [_step(seed=i) for i in range(3)], short=256)
    assert len(fake_pipe.calls) == 3
    assert out.shape[0] == 3
    # frame i came from call i (the fake encodes its call index in R)
    assert [int(out[i, 0, 0, 0]) for i in range(3)] == [1, 2, 3]


def test_plan_length_wins_over_control_length(fake_pipe):
    """A plan longer than the control holds the control's last frame rather than
    stopping short — the segment's frame count is the schedule's, not the clip's.

    Distinct seeds on purpose: with identical steps AND a held control frame, entries
    2..4 would be the same generation and the cache would (correctly) collapse them, so
    the call count would measure deduplication rather than the length rule."""
    out = imagegen.dream_frames(_control(2), [_step(seed=i) for i in range(5)], short=256)
    assert len(fake_pipe.calls) == 5
    assert out.shape[0] == 5


def test_seed_and_scale_reach_the_pipe(fake_pipe):
    plan = [_step(seed=7, scale=0.25), _step(seed=9, scale=0.8)]
    imagegen.dream_frames(_control(2), plan, short=256)
    assert [c["generator"].initial_seed() for c in fake_pipe.calls] == [7, 9]
    assert [c["controlnet_conditioning_scale"] for c in fake_pipe.calls] == [0.25, 0.8]


def test_no_img2img_anchor(fake_pipe):
    """The whole point of the card: nothing that would tie a frame to a source image."""
    imagegen.dream_frames(_control(1), [_step()], short=256)
    kw = fake_pipe.calls[0]
    assert "strength" not in kw
    assert "latents" not in kw
    assert "sigmas" not in kw
    assert "mask_image" not in kw
    assert kw["guidance_scale"] == 0.0  # CFG off — see the negative-prompt note


def test_control_image_kwarg_per_model(fake_pipe, monkeypatch):
    """Z-Image's Union takes `control_image`; SD's txt2img ControlNet takes `image`."""
    imagegen.dream_frames(_control(1), [_step()], model=imagegen.DRAFT_MODEL, short=256)
    assert "image" in fake_pipe.calls[0] and "control_image" not in fake_pipe.calls[0]
    fake_pipe.calls.clear()
    imagegen.dream_frames(_control(1), [_step()], model=imagegen.HD_MODEL, short=256)
    assert "control_image" in fake_pipe.calls[0] and "image" not in fake_pipe.calls[0]


def test_progress_counts_to_total(fake_pipe):
    seen = []
    imagegen.dream_frames(
        _control(3),
        [_step() for _ in range(3)],
        short=256,
        on_progress=lambda d, t: seen.append((d, t)),
    )
    assert seen == [(1, 3), (2, 3), (3, 3)]


def test_default_short_side_per_model(fake_pipe):
    """Draft iterates at 384; HD's 576 is the floor below which Z-Image paints blobs."""
    imagegen.dream_frames(_control(1), [_step()], model=imagegen.DRAFT_MODEL)
    assert min(fake_pipe.calls[0]["height"], fake_pipe.calls[0]["width"]) == 384
    fake_pipe.calls.clear()
    imagegen.dream_frames(_control(1), [_step()], model=imagegen.HD_MODEL)
    assert min(fake_pipe.calls[0]["height"], fake_pipe.calls[0]["width"]) == 576


def test_refuses_empty_inputs(fake_pipe):
    with pytest.raises(ValueError):
        imagegen.dream_frames(_control(1), [], short=256)
    with pytest.raises(ValueError):
        imagegen.dream_frames(np.zeros((0, 8, 8, 3), np.uint8), [_step()], short=256)


def test_refuses_a_model_with_no_controlnet(fake_pipe, monkeypatch):
    """Unlike AI Stylize, Dream cannot degrade to "generate without control" — there
    would be nothing left tying the output to the input at all."""
    monkeypatch.setitem(imagegen.MODELS, "fake/model", {"label": "x", "kind": "auto", "steps": 2})
    with pytest.raises(RuntimeError, match="ControlNet"):
        imagegen.dream_frames(_control(1), [_step()], model="fake/model", short=256)


# --------------------------------------------------------------------------- #
# The optional `init` clip — a start image per frame (the wired `video` input)
# --------------------------------------------------------------------------- #


def test_without_init_there_is_no_injection(fake_pipe):
    """No video wired = a plain free generation: nothing pins any part of the frame."""
    imagegen.dream_frames(_control(1), [_step()], short=256)
    assert "callback_on_step_end" not in fake_pipe.calls[0]


def test_init_arrives_as_an_injection_not_a_start_image(fake_pipe):
    """The source enters ONLY through the per-step callback. It used to be handed over as
    an img2img start image — but that pipeline rebuilds its own latents from `image` and
    ignores anything passed as `latents`, so the scatter was silently discarded and every
    `keep` produced the identical picture. Both pipelines honour the callback."""
    imagegen.dream_frames(
        _control(1), [_step()], init=_control(1), model=imagegen.DRAFT_MODEL, short=256
    )
    kw = fake_pipe.calls[0]
    assert callable(kw["callback_on_step_end"])
    assert kw["callback_on_step_end_tensor_inputs"] == ["latents"]
    assert "strength" not in kw, "the seeded path is txt2img — strength means nothing here"


def test_seeded_path_stays_on_the_txt2img_pipeline(monkeypatch):
    """One pipeline for both paths. Switching to img2img is what broke the scatter."""
    seen = []
    pipe = FakePipe()
    monkeypatch.setattr(
        imagegen, "_load_stylize_pipe", lambda m, mode, c: (seen.append(mode), pipe)[1]
    )
    imagegen.dream_frames(_control(1), [_step()], short=256)
    imagegen.dream_frames(_control(1), [_step(seed=9)], init=_control(1), short=256)
    assert seen == ["txt2img", "txt2img"]


def test_seeded_path_asks_for_enough_steps(fake_pipe):
    """The injection needs real passes: some landing where the source is legible, plus
    free ones to blend them into a picture. The model's distilled 2 cannot do it."""
    imagegen.dream_frames(
        _control(1), [_step()], init=_control(1), model=imagegen.DRAFT_MODEL, short=256
    )
    assert fake_pipe.calls[0]["num_inference_steps"] >= 6


def test_init_alone_auto_cannies_for_the_control(fake_pipe):
    """One wired video is enough: with no Extract, its canny becomes the control — the
    same auto-control AI Stylize applies on its draft model."""
    imagegen.dream_frames(None, [_step()], init=_control(1), model=imagegen.DRAFT_MODEL, short=256)
    ctrl = np.asarray(fake_pipe.calls[0]["image"])
    assert set(np.unique(ctrl)).issubset({0, 255})


def test_refuses_neither_control_nor_init(fake_pipe):
    with pytest.raises(ValueError, match="control clip, an init clip, or both"):
        imagegen.dream_frames(None, [_step()], short=256)


# --------------------------------------------------------------------------- #
# _keep_mask — pure numpy, no pipe. This is where `keep` earns its range.
# --------------------------------------------------------------------------- #


def _white(h=64, w=64):
    return np.full((h, w, 3), 255, np.uint8)


def _canny_like(h=64, w=64, frac=0.02):
    """A sparse control, like the auto-canny the card uses when no Extract is wired:
    a couple of percent white on black. This is the case the old formula got wrong."""
    a = np.zeros((h, w, 3), np.uint8)
    n = max(1, int(h * w * frac))
    rng = np.random.default_rng(0)
    ys, xs = rng.integers(0, h, n), rng.integers(0, w, n)
    a[ys, xs] = 255
    return a


@pytest.mark.parametrize("keep", [0.05, 0.1, 0.25, 0.5])
def test_keep_is_a_target_coverage_on_a_white_control(keep):
    """`keep` means "this fraction of the frame is seeded" — the user's "white ≈ 10%"."""
    m = imagegen._keep_mask(_white(), keep, seed=1, lh=48, lw=86)
    assert float(m.mean()) == pytest.approx(keep, abs=0.03)


def test_keep_stays_useful_on_a_SPARSE_control():
    """The bug that made `keep` feel dead: against a 2%-white canny map — the card's OWN
    default control when no Extract is wired — the old formula gave ~0.2% coverage for
    every value, so the whole slider looked identical. It cannot reach `keep` exactly
    here (the map's support is finite even after spreading), but it must stay MONOTONE
    and well separated, which is what the eye actually reads."""
    cov = [
        float(imagegen._keep_mask(_canny_like(), k, 1, 48, 86).mean())
        for k in (0.05, 0.1, 0.25, 0.5)
    ]
    assert cov == sorted(cov)
    for lo, hi in zip(cov, cov[1:]):
        assert hi > lo * 1.6, f"steps too close to see: {cov}"
    assert cov[-1] > 0.1, f"the top of the slider must seed a real share of the frame: {cov}"


def test_keep_zero_is_a_free_generation():
    m = imagegen._keep_mask(_white(), 0.0, seed=1, lh=32, lw=32)
    assert not m.any()


def test_a_black_control_seeds_nothing():
    """A black control must still mean "invent" — the floor stops it being normalised up."""
    m = imagegen._keep_mask(np.zeros((64, 64, 3), np.uint8), 0.5, seed=1, lh=32, lw=32)
    assert float(m.mean()) < 0.02


def test_the_mask_is_deterministic_from_the_seed():
    """A random stencil would make every re-run a cache miss."""
    a = imagegen._keep_mask(_canny_like(), 0.2, seed=7, lh=32, lw=32)
    b = imagegen._keep_mask(_canny_like(), 0.2, seed=7, lh=32, lw=32)
    c = imagegen._keep_mask(_canny_like(), 0.2, seed=8, lh=32, lw=32)
    assert np.array_equal(a, b)
    assert not np.array_equal(a, c)


def test_the_mask_follows_the_control_not_just_the_count():
    """Coverage must land WHERE the control is bright — a left-bright control seeds the
    left half, which is the whole "à l'endroit du contrôle" contract."""
    ctrl = np.zeros((64, 64, 3), np.uint8)
    ctrl[:, :32] = 255
    m = imagegen._keep_mask(ctrl, 0.3, seed=1, lh=32, lw=32)
    assert m[:, :16].mean() > 10 * max(m[:, 16:].mean(), 1e-6)


# --------------------------------------------------------------------------- #
# _dream_embeds: the crossfade
# --------------------------------------------------------------------------- #


def test_endpoints_take_the_plain_prompt_path(fake_pipe):
    """w == 0 / w == 1 must bypass the embedding machinery entirely: a hold frame has to
    be identical to what a render with no fades at all would produce."""
    plan = [_step("alpha", "beta", w=0.0), _step("alpha", "beta", w=1.0)]
    imagegen.dream_frames(_control(2), plan, short=256)
    assert fake_pipe.calls[0]["prompt"] == "alpha"
    assert fake_pipe.calls[1]["prompt"] == "beta"
    assert all("prompt_embeds" not in c for c in fake_pipe.calls)


def test_midpoint_uses_embeddings_not_a_prompt(fake_pipe, monkeypatch):
    spec = {"kind": "auto", "steps": 2}
    monkeypatch.setattr(imagegen, "_spec", lambda m: spec)

    import torch

    fake_pipe.encode_prompt = lambda p, dev, n, cfg: (
        torch.full((1, 77, 8), 1.0 if p == "alpha" else 3.0),
        None,
    )
    plan = [_step("alpha", "beta", w=0.5)]
    imagegen.dream_frames(_control(1), plan, model=imagegen.DRAFT_MODEL, short=256)
    kw = fake_pipe.calls[0]
    assert "prompt" not in kw
    assert float(kw["prompt_embeds"].mean()) == pytest.approx(2.0)  # halfway


def test_sd_lerp_is_linear_in_w(fake_pipe, monkeypatch):
    import torch

    spec = {"kind": "auto", "steps": 2}
    monkeypatch.setattr(imagegen, "_spec", lambda m: spec)
    fake_pipe.encode_prompt = lambda p, dev, n, cfg: (
        torch.zeros((1, 77, 4)) if p == "a" else torch.ones((1, 77, 4)),
        None,
    )
    plan = [_step("a", "b", w=x) for x in (0.25, 0.5, 0.75)]
    imagegen.dream_frames(_control(3), plan, model=imagegen.DRAFT_MODEL, short=256)
    got = [float(c["prompt_embeds"].mean()) for c in fake_pipe.calls]
    assert got == pytest.approx([0.25, 0.5, 0.75])


def test_zimage_lerp_trims_by_the_union_mask(monkeypatch):
    """Z-Image returns RAGGED embeddings (each prompt trimmed to its own token count), so
    the lerp re-encodes padded and trims by mask_a | mask_b. The union matters: trimming
    by either prompt alone would drop tokens the other one needs."""
    import torch

    class Tok:
        def apply_chat_template(self, messages, **kw):
            return messages[0]["content"]

        def __call__(self, texts, **kw):
            n = kw["max_length"]
            ids = torch.zeros((len(texts), n), dtype=torch.long)
            mask = torch.zeros((len(texts), n), dtype=torch.long)
            for i, t in enumerate(texts):  # "aaa" -> 3 real tokens
                mask[i, : len(t)] = 1
            return type("T", (), {"input_ids": ids, "attention_mask": mask})()

    class Enc:
        def __call__(self, input_ids, attention_mask, output_hidden_states):
            b, n = input_ids.shape
            hs = torch.stack([torch.full((n, 4), float(i)) for i in range(b)])
            # the encode reads hidden_states[-2], so park it second-to-last
            return type("O", (), {"hidden_states": [None, hs, None]})()

    pipe = type("P", (), {})()
    pipe._execution_device = "cpu"
    pipe.tokenizer = Tok()
    pipe.text_encoder = Enc()

    # "aa" = 2 tokens, "bbbbb" = 5 → the union keeps 5.
    got = imagegen._dream_embeds(pipe, {"kind": "zimage"}, "aa", "bbbbb", 0.5)
    embeds = got["prompt_embeds"]
    assert isinstance(embeds, list) and len(embeds) == 1
    assert embeds[0].shape[0] == 5
    assert float(embeds[0].mean()) == pytest.approx(0.5)  # lerp of 0.0 and 1.0


# --------------------------------------------------------------------------- #
# _load_stylize_pipe: three modes
# --------------------------------------------------------------------------- #


def test_pipe_keys_separate_the_three_modes():
    """A key collision would hand a Dream call the stylize card's img2img pipe."""
    keys = {
        imagegen._stylize_pipe_key(imagegen.DRAFT_MODEL, mode, True)
        for mode in ("img2img", "inpaint", "txt2img")
    }
    assert len(keys) == 3


def test_control_and_no_control_never_collide():
    assert imagegen._stylize_pipe_key(
        imagegen.DRAFT_MODEL, "img2img", True
    ) != imagegen._stylize_pipe_key(imagegen.DRAFT_MODEL, "img2img", False)


def test_zimage_control_shares_one_pipe_across_modes():
    """Z-Image's Union pipeline is txt2img+control whatever the caller asks for, so all
    three modes must land on ONE instance — keying them apart loads 6.7 GB twice."""
    keys = {
        imagegen._stylize_pipe_key(imagegen.HD_MODEL, mode, True)
        for mode in ("img2img", "inpaint", "txt2img")
    }
    assert len(keys) == 1


def test_txt2img_without_control_is_refused():
    with pytest.raises(RuntimeError, match="control"):
        imagegen._load_stylize_pipe(imagegen.DRAFT_MODEL, "txt2img", False)
