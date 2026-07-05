"""Per-project asset library + video ingest.

The project OWNS a list of assets in `data.assets` (server-managed): `/upload-asset`
appends, `GET /assets/<job>` lists, `DELETE /assets/<job>/<id>` removes, a YouTube import
adds a video, and a video uploaded at the pipeline start is split into audio (for demucs)
+ a kept video asset. The Postgres-backed tests skip when no DB is reachable; the heavy
demucs/spectrogram step is faked so the video-ingest test stays fast.
"""

import io
import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image

pytest.importorskip("torch")  # importing backend.app pulls torch (matches test_app_routes)

from backend import db  # noqa: E402
from backend.app import app  # noqa: E402


@pytest.fixture
def client():
    return app.test_client()


@pytest.fixture
def live_db():
    try:
        db.init_schema()
    except db.DBUnavailable:
        pytest.skip("no database reachable")


def _mk_project(job):
    db.delete_project(job)
    db.create_project(
        job, title="t", source="s", duration=1.0, fmin=20, has_lyrics=False, stems={}
    )


# --------------------------------------------------------------------------- #
# db.add_asset / remove_asset / list_assets
# --------------------------------------------------------------------------- #
def test_asset_db_round_trip(live_db):
    job = "assetdb01"
    _mk_project(job)
    try:
        assert db.list_assets(job) == []
        a1 = {"id": "aaa", "url": "/assets/x/aaa.png", "kind": "image", "name": "a", "addedAt": 1}
        assert db.add_asset(job, a1)
        assert db.list_assets(job) == [a1]

        # dedup by id: re-adding the same id replaces (doesn't duplicate)
        db.add_asset(job, {**a1, "name": "renamed"})
        lst = db.list_assets(job)
        assert len(lst) == 1 and lst[0]["name"] == "renamed"

        a2 = {"id": "bbb", "url": "/assets/x/bbb.mp4", "kind": "video", "name": "b", "addedAt": 2}
        db.add_asset(job, a2)
        assert {a["id"] for a in db.list_assets(job)} == {"aaa", "bbb"}

        assert db.remove_asset(job, "aaa")
        assert {a["id"] for a in db.list_assets(job)} == {"bbb"}
    finally:
        db.delete_project(job)
    # add/remove on a missing project is a no-op (False), never an error
    assert db.add_asset(job, a1) is False
    assert db.remove_asset(job, "bbb") is False


# --------------------------------------------------------------------------- #
# /upload-asset -> GET /assets -> DELETE
# --------------------------------------------------------------------------- #
def test_upload_asset_persists_lists_and_deletes(live_db, client, tmp_path, monkeypatch):
    from backend.routes import uploads

    assets_dir = tmp_path / "assets"
    assets_dir.mkdir()
    monkeypatch.setattr(uploads, "ASSETS_DIR", assets_dir)

    job = "a1a1a1a1"
    _mk_project(job)
    try:
        buf = io.BytesIO()
        Image.new("RGB", (8, 8), (1, 2, 3)).save(buf, "PNG")
        buf.seek(0)
        r = client.post(
            f"/upload-asset/{job}",
            data={"file": (buf, "pic.png")},
            content_type="multipart/form-data",
        )
        assert r.status_code == 200
        asset = r.get_json()
        assert asset["kind"] == "image" and asset["name"] == "pic.png"

        listed = client.get(f"/assets/{job}").get_json()
        assert len(listed) == 1 and listed[0]["id"] == asset["id"]
        f = assets_dir / job / f"{asset['id']}.png"
        assert f.exists()

        d = client.delete(f"/assets/{job}/{asset['id']}")
        assert d.status_code == 200
        assert not f.exists()
        assert client.get(f"/assets/{job}").get_json() == []
    finally:
        db.delete_project(job)


def test_upload_asset_rejects_unknown_extension(live_db, client, tmp_path, monkeypatch):
    from backend.routes import uploads

    monkeypatch.setattr(uploads, "ASSETS_DIR", tmp_path / "assets")
    job = "a2a2a2a2"
    _mk_project(job)
    try:
        r = client.post(
            f"/upload-asset/{job}",
            data={"file": (io.BytesIO(b"nope"), "evil.exe")},
            content_type="multipart/form-data",
        )
        assert r.status_code == 400
    finally:
        db.delete_project(job)


# --------------------------------------------------------------------------- #
# YouTube -> video asset (async worker, downloader monkeypatched)
# --------------------------------------------------------------------------- #
def test_asset_from_youtube_adds_video(live_db, tmp_path, monkeypatch):
    from backend.routes import uploads

    assets_dir = tmp_path / "assets"
    assets_dir.mkdir()
    monkeypatch.setattr(uploads, "ASSETS_DIR", assets_dir)

    def fake_dl(url, out_dir, stem="ytvideo"):
        p = Path(out_dir) / f"{stem}.mp4"
        p.write_bytes(b"FAKE-VIDEO-BYTES")
        return p

    monkeypatch.setattr(uploads, "download_youtube_video", fake_dl)

    job = "ytjob001"
    _mk_project(job)
    try:
        asset = uploads._download_asset_video(job, "https://youtu.be/whatever")
        assert asset["kind"] == "video" and asset["name"] == "ytvideo.mp4"
        assert (assets_dir / job / f"{asset['id']}.mp4").exists()
        assert any(a["id"] == asset["id"] for a in db.list_assets(job))
    finally:
        db.delete_project(job)


# --------------------------------------------------------------------------- #
# Video uploaded at the pipeline start: audio split off, video kept as an asset
# --------------------------------------------------------------------------- #
@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_video_upload_splits_audio_and_keeps_video(live_db, tmp_path, monkeypatch):
    from backend import media
    from backend.routes import uploads

    up, sep, spec, ass = (tmp_path / n for n in ("uploads", "separated", "spectro", "assets"))
    for d in (up, sep, spec, ass):
        d.mkdir()
    # _process_upload reads paths off `uploads`; stem_audio_path reads them off `media`.
    monkeypatch.setattr(uploads, "UPLOAD_DIR", up)
    monkeypatch.setattr(uploads, "SEPARATED_DIR", sep)
    monkeypatch.setattr(uploads, "SPECTRO_DIR", spec)
    monkeypatch.setattr(uploads, "ASSETS_DIR", ass)
    monkeypatch.setattr(media, "UPLOAD_DIR", up)
    monkeypatch.setattr(media, "SEPARATED_DIR", sep)

    job = "vidjob001"
    _mk_project(job)
    real_run = subprocess.run

    # Fake demucs (write empty stem wavs — make_spectrogram is stubbed so content is
    # irrelevant); delegate the real ffmpeg audio-extract to the real subprocess.run.
    def fake_run(cmd, *a, **k):
        if any("demucs" in str(c) for c in cmd):
            song = Path(cmd[-1]).stem
            out = sep / job / "htdemucs" / song
            out.mkdir(parents=True, exist_ok=True)
            for s in ("vocals", "drums", "bass", "other"):
                (out / f"{s}.wav").write_bytes(b"RIFF")
            return subprocess.CompletedProcess(cmd, 0, "", "")
        return real_run(cmd, *a, **k)

    monkeypatch.setattr(uploads.subprocess, "run", fake_run)
    monkeypatch.setattr(uploads, "make_spectrogram", lambda src, png, cmap: (44100, 1.0))

    job_dir = up / job
    job_dir.mkdir()
    vid = job_dir / "original.mp4"
    real_run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=32x32:d=1",
         "-f", "lavfi", "-i", "sine=frequency=200:duration=1", "-shortest",
         "-pix_fmt", "yuv420p", str(vid)],
        check=True,
    )
    try:
        res = uploads._process_upload(job, vid, "", job_dir, False, "clip.mp4")
        # stems produced (the pipeline ran on the extracted audio)
        assert {"vocals", "drums", "bass", "other", "original"} <= set(res["stems"])
        # the "original" stem is now AUDIO (wav), not the video
        orig = media.stem_audio_path(job, "original")
        assert orig is not None and orig.suffix == ".wav"
        assert not (job_dir / "original.mp4").exists()  # video removed from uploads
        # the video is kept as a library asset
        assets = db.list_assets(job)
        assert len(assets) == 1 and assets[0]["kind"] == "video" and assets[0]["name"] == "clip.mp4"
        assert (ass / job / Path(assets[0]["url"]).name).exists()
    finally:
        db.delete_project(job)


# --------------------------------------------------------------------------- #
# GC keeps library files even with no node referencing them
# --------------------------------------------------------------------------- #
def test_cache_gc_keeps_library_asset_with_no_node(monkeypatch):
    from backend import cache_gc

    proj = {"job_id": "p2", "data": {
        "assets": [{"id": "z", "url": "/assets/p2/z.mp4", "kind": "video", "name": "z", "addedAt": 1}],
        "segments": [{"graph": {"nodes": [{"type": "fluid", "data": {}}]}}],
    }}
    monkeypatch.setattr(cache_gc.db, "get_projects_full", lambda: [proj])
    assert "z.mp4" in {p.name for p in cache_gc.reachable_assets()}


# --------------------------------------------------------------------------- #
# Project delete cleans the asset dir
# --------------------------------------------------------------------------- #
def test_project_delete_removes_asset_dir(live_db, client, tmp_path, monkeypatch):
    from backend.routes import projects as projects_routes

    assets_dir = tmp_path / "assets"
    monkeypatch.setattr(projects_routes, "ASSETS_DIR", assets_dir)

    job = "delasset1"
    _mk_project(job)
    (assets_dir / job).mkdir(parents=True)
    (assets_dir / job / "a.png").write_bytes(b"x")

    r = client.delete(f"/projects/{job}")
    assert r.status_code == 200
    assert not (assets_dir / job).exists()
