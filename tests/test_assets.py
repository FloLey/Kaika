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

# `client` and `live_db` come from conftest.py.


def _mk_project(job):
    db.delete_project(job)
    db.create_project(job, title="t", source="s", duration=1.0, fmin=20, has_lyrics=False, stems={})


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


def test_upload_asset_keeps_folder_metadata(live_db, client, tmp_path, monkeypatch):
    """A folder upload sends each file's relative directory as `folder`; it rides the
    asset dict (sanitized) so the library can group by it. Files stay content-addressed
    flat on disk — the folder is display metadata only."""
    from backend.routes import uploads

    assets_dir = tmp_path / "assets"
    assets_dir.mkdir()
    monkeypatch.setattr(uploads, "ASSETS_DIR", assets_dir)
    job = "a4a4a4a4"
    _mk_project(job)
    try:
        buf = io.BytesIO()
        Image.new("RGB", (8, 8), (9, 9, 9)).save(buf, "PNG")
        buf.seek(0)
        r = client.post(
            f"/upload-asset/{job}",
            data={"file": (buf, "clip.png"), "folder": " May 2026//../venise\\day1 "},
            content_type="multipart/form-data",
        )
        assert r.status_code == 200
        asset = r.get_json()
        # empty / "." / ".." segments dropped, backslashes split, whitespace trimmed
        assert asset["folder"] == "May 2026/venise/day1"
        assert client.get(f"/assets/{job}").get_json()[0]["folder"] == "May 2026/venise/day1"
        # …and the file still lands flat, content-addressed (no folder on disk)
        assert (assets_dir / job / f"{asset['id']}.png").exists()
    finally:
        db.delete_project(job)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_video_upload_generates_a_thumbnail_and_delete_removes_it(
    live_db, client, tmp_path, monkeypatch
):
    """A video asset gets a server-side `<sha>-thumb.jpg` on upload (the library grid
    shows it as a plain <img> — a grid of live <video> decoders froze the tab), and
    deleting the asset unlinks the thumb with it."""
    from backend.routes import uploads

    assets_dir = tmp_path / "assets"
    assets_dir.mkdir()
    monkeypatch.setattr(uploads, "ASSETS_DIR", assets_dir)
    job = "a5a5a5a5"
    _mk_project(job)
    try:
        clip = tmp_path / "clip.mp4"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
             "-i", "testsrc=size=64x64:rate=10:duration=1", "-pix_fmt", "yuv420p", str(clip)],
            check=True,
        )  # fmt: skip
        with clip.open("rb") as f:
            r = client.post(
                f"/upload-asset/{job}",
                data={"file": (f, "clip.mp4")},
                content_type="multipart/form-data",
            )
        assert r.status_code == 200
        asset = r.get_json()
        thumb = assets_dir / job / f"{asset['id']}-thumb.jpg"
        assert thumb.exists() and thumb.stat().st_size > 0
        assert client.delete(f"/assets/{job}/{asset['id']}").status_code == 200
        assert not thumb.exists()  # the thumb dies with its asset
    finally:
        db.delete_project(job)


def test_gc_keeps_a_thumb_alive_with_its_base_file(monkeypatch, tmp_path):
    """The sweep never references thumbs directly (projects don't) — a thumb survives
    exactly as long as its base video is reachable."""
    from backend import cache_gc

    monkeypatch.setattr(cache_gc, "ASSETS_DIR", tmp_path)
    d = tmp_path / "job1"
    d.mkdir()
    (d / "aaaa.mp4").write_bytes(b"x")
    (d / "aaaa-thumb.jpg").write_bytes(b"x")
    (d / "bbbb-thumb.jpg").write_bytes(b"x")  # orphan — its base is gone
    proj = {"job_id": "job1", "data": {"assets": [{"url": "/assets/job1/aaaa.mp4"}]}}
    monkeypatch.setattr(cache_gc.db, "get_projects_full", lambda: [proj])
    monkeypatch.setattr(cache_gc, "_last_run", 0.0)
    cache_gc.sweep(keep_recent_sec=0, now=9e9)
    assert (d / "aaaa.mp4").exists() and (d / "aaaa-thumb.jpg").exists()
    assert not (d / "bbbb-thumb.jpg").exists()


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
# HD-export assets are named `hd-<sha16>` — the hyphen must survive serve + delete
# (both gates used to require a pure-alnum stem, so HD thumbnails 404'd and their
# delete 400'd; see backend/web.py validate_asset_id).
# --------------------------------------------------------------------------- #
def test_hyphenated_hd_asset_serves_and_deletes(live_db, client, tmp_path, monkeypatch):
    from backend.routes import serving, uploads

    assets_dir = tmp_path / "assets"
    monkeypatch.setattr(serving, "ASSETS_DIR", assets_dir)
    monkeypatch.setattr(uploads, "ASSETS_DIR", assets_dir)

    job, asset_id = "d0010101", "hd-a1b2c3d4e5f60718"
    _mk_project(job)
    (assets_dir / job).mkdir(parents=True)
    f = assets_dir / job / f"{asset_id}.png"
    Image.new("RGB", (4, 4), (9, 9, 9)).save(f, "PNG")
    db.add_asset(
        job,
        {
            "id": asset_id,
            "url": f"/assets/{job}/{f.name}",
            "kind": "image",
            "name": f.name,
            "addedAt": 1,
        },
    )
    try:
        assert client.get(f"/assets/{job}/{f.name}").status_code == 200
        assert client.delete(f"/assets/{job}/{asset_id}").status_code == 200
        assert not f.exists()
        assert db.list_assets(job) == []
    finally:
        db.delete_project(job)


def test_asset_routes_still_reject_unsafe_names(client, tmp_path, monkeypatch):
    from backend.routes import serving

    monkeypatch.setattr(serving, "ASSETS_DIR", tmp_path)
    job = "d0020202"
    # a leading hyphen, an underscore, and a dotted stem are all outside the id shape
    for name in ("-evil.png", "a_b.png", "a.b.png"):
        assert client.get(f"/assets/{job}/{name}").status_code == 404
    assert client.delete(f"/assets/{job}/-evil").status_code == 400


# --------------------------------------------------------------------------- #
# YouTube -> video asset (async worker, downloader monkeypatched)
# --------------------------------------------------------------------------- #
def test_asset_from_youtube_adds_video(live_db, tmp_path, monkeypatch):
    from backend.routes import uploads

    assets_dir = tmp_path / "assets"
    assets_dir.mkdir()
    monkeypatch.setattr(uploads, "ASSETS_DIR", assets_dir)

    def fake_dl(url, out_dir, stem="ytvideo", start=None, end=None):
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
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=32x32:d=1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=200:duration=1",
            "-shortest",
            "-pix_fmt",
            "yuv420p",
            str(vid),
        ],
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

    proj = {
        "job_id": "p2",
        "data": {
            "assets": [
                {"id": "z", "url": "/assets/p2/z.mp4", "kind": "video", "name": "z", "addedAt": 1}
            ],
            "segments": [{"graph": {"nodes": [{"type": "fluid", "data": {}}]}}],
        },
    }
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


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_asset_proxy_serves_the_original_then_the_proxy(live_db, client, tmp_path, monkeypatch):
    """`/asset-proxy` never breaks a preview: it serves the ORIGINAL while the 360p
    copy is still being made (so a fresh clip previews immediately), and the proxy
    once it lands — which is what stops several 4K phone clips from stalling the tab."""
    from backend.routes import uploads

    assets_dir = tmp_path / "assets"
    assets_dir.mkdir()
    monkeypatch.setattr(uploads, "ASSETS_DIR", assets_dir)
    job = "a6a6a6a6"
    d = assets_dir / job
    d.mkdir()
    src = d / "abc123.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
         "-i", "testsrc=size=640x480:rate=10:duration=1", "-pix_fmt", "yuv420p", str(src)],
        check=True,
    )  # fmt: skip

    # No proxy yet -> the original is served (and a transcode is kicked off).
    calls = []
    monkeypatch.setattr(uploads, "_ensure_proxy_async", lambda p: calls.append(p))
    r = client.get(f"/asset-proxy/{job}/abc123")
    assert r.status_code == 200 and calls == [src]

    # Once generated, the proxy is served instead. What matters is that it's been
    # DOWNSCALED to 360p (on a real 4K phone clip that's ~100× fewer bytes; this
    # synthetic 640x480 source is already tiny, so file size proves nothing).
    assert uploads._make_video_proxy(src)
    proxy = d / "abc123-proxy.mp4"
    assert proxy.exists()
    height = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=height", "-of", "csv=p=0", str(proxy)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()  # fmt: skip
    assert height == "360"
    r2 = client.get(f"/asset-proxy/{job}/abc123")
    assert r2.status_code == 200
    assert int(r2.headers["Content-Length"]) == proxy.stat().st_size

    # A derived companion is never mistaken for the original asset…
    assert uploads._asset_base_file(job, "abc123") == src
    # …and delete reaps it with its base file.
    _mk_project(job)
    try:
        assert client.delete(f"/assets/{job}/abc123").status_code == 200
        assert not proxy.exists() and not src.exists()
    finally:
        db.delete_project(job)


def test_asset_proxy_rejects_unknown_and_unsafe_ids(client, tmp_path, monkeypatch):
    from backend.routes import uploads

    monkeypatch.setattr(uploads, "ASSETS_DIR", tmp_path)
    assert client.get("/asset-proxy/a7a7a7a7/nope").status_code == 404
    assert client.get("/asset-proxy/a7a7a7a7/-evil").status_code == 400
