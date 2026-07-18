"""Remote inference plumbing: the GPU server (backend/remote_app.py) endpoints, the
npz transport, the client's batching, and imagegen's dispatch — all with the actual
diffusion faked (no model ever loads here)."""

import numpy as np
import pytest

pytest.importorskip("torch")

from backend import imagegen, paths, settings  # noqa: E402
from backend.remote_client import pack_npz, unpack_npz  # noqa: E402


# --------------------------------------------------------------------------- #
# npz transport
# --------------------------------------------------------------------------- #
def test_npz_roundtrip():
    frames = np.random.default_rng(0).integers(0, 255, (3, 8, 6, 3), np.uint8)
    out = unpack_npz(pack_npz(frames=frames, control=frames[:1]))
    assert np.array_equal(out["frames"], frames) and out["control"].shape == (1, 8, 6, 3)


# --------------------------------------------------------------------------- #
# the GPU server app
# --------------------------------------------------------------------------- #
@pytest.fixture
def remote_client_app(monkeypatch):
    """remote_app's Flask test client, with a token required and stylize faked to an
    invert filter (visible, deterministic, no GPU)."""
    from backend import remote_app

    monkeypatch.setattr(remote_app, "TOKEN", "sekret")
    monkeypatch.setattr(
        imagegen, "stylize_frames",
        lambda frames, prompt, **kw: 255 - np.asarray(frames),
    )
    monkeypatch.setattr(imagegen, "depth_frames", lambda frames: np.asarray(frames) // 2)
    remote_app.app.config["TESTING"] = True
    return remote_app.app.test_client()


def test_remote_app_requires_token(remote_client_app):
    assert remote_client_app.get("/health").status_code == 401
    r = remote_client_app.get("/health", headers={"Authorization": "Bearer sekret"})
    assert r.status_code == 200 and r.get_json()["ok"] is True


def test_remote_app_stylize_roundtrip(remote_client_app):
    frames = np.full((2, 8, 6, 3), 10, np.uint8)
    r = remote_client_app.post(
        "/stylize", data=pack_npz(frames=frames),
        headers={"Authorization": "Bearer sekret",
                 "X-Kaika-Params": '{"prompt": "x", "seed": 1}'},
    )
    assert r.status_code == 200
    assert np.array_equal(unpack_npz(r.data)["styled"], 255 - frames)


def test_remote_app_surfaces_generation_errors(remote_client_app, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("model exploded")

    monkeypatch.setattr(imagegen, "stylize_frames", boom)
    r = remote_client_app.post(
        "/stylize", data=pack_npz(frames=np.zeros((1, 4, 4, 3), np.uint8)),
        headers={"Authorization": "Bearer sekret", "X-Kaika-Params": "{}"},
    )
    assert r.status_code == 500 and "model exploded" in r.get_json()["error"]


# --------------------------------------------------------------------------- #
# client batching + dispatch
# --------------------------------------------------------------------------- #
def test_client_batches_and_reports_progress(monkeypatch):
    from backend import remote_client

    calls = []

    def fake_post(url, token, path, body, params, what):
        arrays = unpack_npz(body)
        calls.append(len(arrays["frames"]))
        return pack_npz(styled=255 - arrays["frames"])

    monkeypatch.setattr(remote_client, "_post", fake_post)
    frames = np.zeros((19, 4, 4, 3), np.uint8)
    seen = []
    out = remote_client.stylize_remote(
        frames, "p", 1.0, False, "m", 1, None, 0.65, "neg", 576,
        "http://gpu", "t", on_progress=lambda done, total: seen.append((done, total)),
    )
    assert out.shape == frames.shape and calls == [8, 8, 3]  # 19 frames → 8+8+3
    assert seen == [(8, 19), (16, 19), (19, 19)]


def test_stylize_dispatches_to_remote_with_resolved_defaults(monkeypatch, tmp_path):
    # Importing remote_app (other tests here) pins KAIKA_FORCE_LOCAL for the whole
    # process — undo it, this test IS the app side.
    monkeypatch.delenv("KAIKA_FORCE_LOCAL", raising=False)
    monkeypatch.setattr(paths, "SETTINGS_FILE", tmp_path / "s.json")
    settings.update_settings({"inference": {"enabled": True, "url": "http://gpu:5100"}})
    from backend import remote_client

    got = {}

    def fake_stylize_remote(frames, prompt, strength, inpaint, model, seed, control,
                            control_scale, negative, short, url, token, on_progress=None):
        got.update(model=model, control_scale=control_scale, short=short, url=url)
        return np.zeros((len(frames), 4, 4, 3), np.uint8)

    monkeypatch.setattr(remote_client, "stylize_remote", fake_stylize_remote)
    frames = np.zeros((2, 8, 6, 3), np.uint8)
    imagegen.stylize_frames(frames, "x", model=imagegen.HD_MODEL)
    # the per-model defaults must be resolved BEFORE shipping (the server has none)
    assert got == {"model": imagegen.HD_MODEL, "control_scale": 0.65, "short": 576,
                   "url": "http://gpu:5100"}
