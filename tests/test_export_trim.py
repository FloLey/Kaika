"""POST /export/trim — the platform-length cut out of a finished master.

Pinned: a valid [start, end] re-encodes exactly that range (duration checked via
ffprobe) and caches it (an identical re-cut returns the same file with no second
encode); the url must name a file directly in the clip dir (traversal / unknown →
404); a degenerate range → 400.
"""

import shutil
import subprocess

import pytest

from backend import paths

_needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def _make_master(name="master-abc.mp4", secs=4):
    paths.ANIM_DIR.mkdir(parents=True, exist_ok=True)
    out = paths.ANIM_DIR / name
    subprocess.run(
        # fmt: off
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc=size=64x64:rate=12:duration={secs}",
            "-f", "lavfi", "-i", f"sine=frequency=440:duration={secs}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
            str(out),
        ],
        # fmt: on
        check=True,
    )
    return out


def _duration(path) -> float:
    p = subprocess.run(
        # fmt: off
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1", str(path),
        ],
        # fmt: on
        check=True,
        capture_output=True,
    )
    return float(p.stdout.strip())


@_needs_ffmpeg
def test_trim_cuts_the_requested_range_and_caches(client):
    _make_master()
    r = client.post("/export/trim", json={"url": "/fluid/master-abc.mp4", "start": 1, "end": 3})
    assert r.status_code == 200, r.get_json()
    url = r.get_json()["url"]
    assert url.startswith("/fluid/trim-")
    out = paths.ANIM_DIR / url.rsplit("/", 1)[-1]
    assert abs(_duration(out) - 2.0) < 0.2
    # Identical re-cut: same key, same file, no re-encode (mtime unchanged).
    stamp = out.stat().st_mtime_ns
    r2 = client.post("/export/trim", json={"url": "/fluid/master-abc.mp4", "start": 1, "end": 3})
    assert r2.get_json()["url"] == url
    assert out.stat().st_mtime_ns == stamp


@_needs_ffmpeg
def test_trim_rejects_bad_inputs(client):
    _make_master()
    # Unknown master / traversal out of the clip dir → 404.
    assert (
        client.post(
            "/export/trim", json={"url": "/fluid/nope.mp4", "start": 0, "end": 1}
        ).status_code
        == 404
    )
    assert (
        client.post(
            "/export/trim", json={"url": "/fluid/../uploads/x.mp4", "start": 0, "end": 1}
        ).status_code
        == 404
    )
    # Degenerate range → 400.
    assert (
        client.post(
            "/export/trim", json={"url": "/fluid/master-abc.mp4", "start": 2, "end": 2}
        ).status_code
        == 400
    )
