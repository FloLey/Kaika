"""The /generate-image route: background job -> local model (mocked) -> PNGs
stored as content-addressed library assets. The model itself is never loaded in
tests — `imagegen.generate` is patched (loading SD is a multi-GB download)."""

import time

import pytest
from PIL import Image

pytest.importorskip("torch")

from backend import imagegen  # noqa: E402
from backend.routes import uploads as uploads_routes  # noqa: E402


def _wait_job(client, job_id, timeout=5.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        st = client.get(f"/jobs/{job_id}").get_json()
        if st["state"] != "running":
            return st
        time.sleep(0.02)
    raise AssertionError("job never finished")


def test_generate_image_stores_assets(client, live_db, tmp_path, monkeypatch):
    from backend import db

    job = "ab12cd34"
    db.delete_project(job)
    db.create_project(job, title="t", source="s", duration=1.0, fmin=20, has_lyrics=False, stems={})
    monkeypatch.setattr(uploads_routes, "ASSETS_DIR", tmp_path)
    # Two distinct tiny stills instead of the real model. One image per call (the
    # worker calls once per prompt, seeded seed+i). Capture the model the route picks.
    used = {}

    def fake_generate(prompt, seed=1, count=1, model=None, long_edge=None, aspect=None):
        used["model"] = model
        return [Image.new("RGB", (8, 8), (10 * (seed + i) % 255, 0, 0)) for i in range(count)]

    monkeypatch.setattr(imagegen, "generate", fake_generate)

    try:
        r = client.post(
            f"/generate-image/{job}",
            json={"prompts": ["wedding flowers", "first dance"], "seed": 7},
        )
        assert r.status_code == 200
        st = _wait_job(client, r.get_json()["job_id"])
        assert st["state"] == "done", st
        # The card's ✨ defaults to the fast DRAFT model (HD happens at export).
        assert used["model"] == imagegen.DRAFT_MODEL
        assets = st["result"]["assets"]
        assert len(assets) == 2
        for a in assets:
            assert a["kind"] == "image" and a["url"].startswith(f"/assets/{job}/")
        # Content-addressed on disk + registered in the library.
        stored = list((tmp_path / job).glob("*.png"))
        assert len(stored) == 2
        assert {x["id"] for x in db.list_assets(job)} >= {a["id"] for a in assets}
    finally:
        # Runs against the shared dev Postgres — don't leave a stray "t" project behind.
        db.delete_project(job)


def test_generate_image_requires_a_prompt(client):
    r = client.post("/generate-image/ab12cd99", json={"prompts": ["  ", ""]})
    assert r.status_code == 400


def test_generate_image_error_surfaces_on_the_job(client, live_db, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("image generation needs the diffusers stack")

    monkeypatch.setattr(imagegen, "generate", boom)
    r = client.post("/generate-image/ab12cd99", json={"prompts": ["x"]})
    st = _wait_job(client, r.get_json()["job_id"])
    assert st["state"] == "error"
    assert "diffusers" in st["error"]
