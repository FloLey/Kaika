"""Frame-precise, near-instant cuts of a finished master — the export trim.

Why cutting at an arbitrary frame isn't free: H.264 stores DIFFERENCES, not
pictures. Only a keyframe is a complete image; every frame after it decodes by
applying deltas to what came before, so a copied stream can only START on a
keyframe (one per second in our masters — `-g fps`). The SMART CUT gets frame
precision anyway by re-encoding ONLY the missing piece:

    [ start … next keyframe )   re-encoded  (sub-second — instant even at 4K)
    [ next keyframe … end )     stream-COPIED (no quality loss, disk speed)

joined losslessly through MPEG-TS (tolerant of the head/body SPS seam; both
sides share dimensions/fps/profile since the head re-encodes the same stream),
while the AUDIO is cut in ONE continuous re-encode over the whole range — a
two-piece audio join would click at the seam. Degenerate cases collapse
naturally: a start ON a keyframe is a pure copy; a range inside one GOP is a
pure (tiny) re-encode. If the assembled file's duration disagrees with the
request, the whole range is re-encoded as a last resort — slower, never wrong.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import uuid
from pathlib import Path

log = logging.getLogger("kaika")

_FRAME_TOL = 0.06  # "on a keyframe" / duration-check tolerance, seconds


def _run(cmd: list, timeout: int = 1800) -> None:
    p = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or b"").decode(errors="replace")[-400:])


def duration_of(path: Path) -> float:
    p = subprocess.run(
        # fmt: off
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1", str(path),
        ],
        # fmt: on
        capture_output=True,
        text=True,
        timeout=60,
    )
    return float(p.stdout.strip() or 0.0)


def _first_keyframe_at_or_after(src: Path, t0: float, span: float = 6.0) -> float | None:
    """The first keyframe timestamp ≥ t0 (scanning `span` seconds), or None."""
    p = subprocess.run(
        # fmt: off
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
            "-show_entries", "frame=pts_time", "-of", "csv=p=0",
            "-read_intervals", f"{max(0.0, t0 - 0.05):.3f}%+{span:.3f}", str(src),
        ],
        # fmt: on
        capture_output=True,
        text=True,
        timeout=120,
    )
    times = sorted(
        float(x) for x in p.stdout.replace(",", "\n").split() if x.strip().replace(".", "", 1)
    )
    return next((t for t in times if t >= t0 - _FRAME_TOL), None)


def _encode_args(crf: int) -> list:
    # Mirrors the master's own encode family (libx264 yuv420p, no B-frames — v18):
    # the head must splice against copied packets of the same profile/shape.
    # fmt: off
    return [
        "-c:v", "libx264", "-preset", "veryfast", "-crf", str(int(crf)),
        "-pix_fmt", "yuv420p", "-bf", "0",
    ]
    # fmt: on


def cut_master(
    src: Path,
    start: float,
    end: float,
    out: Path,
    crf: int,
    on_progress=lambda *a, **k: None,
    should_cancel=lambda: False,
) -> None:
    """Cut [start, end] of `src` into `out` (atomic; raises on failure)."""
    want = end - start
    work = out.parent / f".trim-work-{uuid.uuid4().hex[:8]}"
    work.mkdir(parents=True, exist_ok=True)
    tmp = work / "assembled.mp4"
    try:
        k = _first_keyframe_at_or_after(src, start)
        on_progress(1, 5, None, phase="cut")
        if should_cancel():
            return
        if k is not None and k <= end - _FRAME_TOL:
            if k - start <= _FRAME_TOL:
                # Start sits ON a keyframe: the whole cut is a pure stream copy.
                # fmt: off
                _run([
                    "ffmpeg", "-y", "-v", "error",
                    "-ss", f"{k:.3f}", "-to", f"{end:.3f}", "-i", str(src),
                    "-c", "copy", "-avoid_negative_ts", "make_zero",
                    "-movflags", "+faststart", str(tmp),
                ])
                # fmt: on
            else:
                # Head: re-encode ONLY [start, k) — the frames a copy cannot start
                # on. Body: copy [k, end). Video-only on both sides; the audio is
                # cut in one continuous pass below (a spliced audio join clicks).
                head, body = work / "head.ts", work / "body.ts"
                # fmt: off
                _run([
                    "ffmpeg", "-y", "-v", "error",
                    "-ss", f"{start:.3f}", "-to", f"{k:.3f}", "-i", str(src),
                    "-an", *_encode_args(crf), "-f", "mpegts", str(head),
                ])
                on_progress(2, 5, None)
                if should_cancel():
                    return
                _run([
                    "ffmpeg", "-y", "-v", "error",
                    "-ss", f"{k:.3f}", "-to", f"{end:.3f}", "-i", str(src),
                    "-an", "-c:v", "copy", "-avoid_negative_ts", "make_zero",
                    "-f", "mpegts", str(body),
                ])
                on_progress(3, 5, None)
                if should_cancel():
                    return
                audio = work / "audio.m4a"
                has_audio = (
                    subprocess.run(
                        # fmt: on
                        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", str(src)],  # fmt: skip
                        capture_output=True,
                        timeout=60,
                    ).stdout.strip()
                    != b""
                )
                if has_audio:
                    # fmt: off
                    _run([
                        "ffmpeg", "-y", "-v", "error",
                        "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(src),
                        "-vn", "-c:a", "aac", "-b:a", "192k", str(audio),
                    ])
                    a_in = ["-i", str(audio)]
                    a_map = ["-map", "1:a:0", "-c:a", "copy"]
                else:
                    a_in, a_map = [], []
                _run([
                    "ffmpeg", "-y", "-v", "error",
                    "-i", f"concat:{head}|{body}", *a_in,
                    "-map", "0:v:0", *a_map, "-c:v", "copy", "-shortest",
                    "-movflags", "+faststart", str(tmp),
                ])
                # fmt: on
        else:
            # The whole range lives inside one GOP — a tiny full re-encode.
            # fmt: off
            _run([
                "ffmpeg", "-y", "-v", "error",
                "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(src),
                *_encode_args(crf), "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart", str(tmp),
            ])
            # fmt: on
        on_progress(4, 5, None)
        if should_cancel():
            return
        # The splice is trusted only if the result measures right; otherwise fall
        # back to the slow full re-encode of the range (never ship a broken cut).
        if abs(duration_of(tmp) - want) > 0.25:
            log.warning("trim: smart cut duration off — falling back to full re-encode")
            # fmt: off
            _run([
                "ffmpeg", "-y", "-v", "error",
                "-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", str(src),
                *_encode_args(crf), "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart", str(tmp),
            ])
            # fmt: on
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp.replace(out)
        on_progress(5, 5, None)
    finally:
        shutil.rmtree(work, ignore_errors=True)
