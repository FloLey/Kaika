"""Where does a render actually spend its time? — `make measure-render`.

Renders ONE real segment through the export's own code path and reports the split
across decode / flatten / opacity / cache / encode, plus peak ffmpeg processes and RSS.

This exists because guessing was wrong twice: a 4K montage export was assumed to be
bound by decoding and H.264, and a filter-graph rewrite was estimated at "5-15x". The
first run said decode+encode were 18% of the time and two numpy conversions were 73% —
work that produced pixels identical to skipping it. Before optimising a render path,
run this and read the table.

  make measure-render                       # newest project, first segment with a montage
  make measure-render JOB=e883da29 SEGMENT=chorus

Timing is by monkeypatch, in this process only; nothing in the render path knows.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import fluid, fluid_cache, graph as graphmod, graph_render, sources  # noqa: E402
from backend.media import stem_audio_path  # noqa: E402
from backend.routes import export as EX  # noqa: E402

T: dict[str, float] = {}


def _timed(obj, name: str, key: str) -> None:
    """Accumulate wall time for `obj.name` under `T[key]`."""
    orig = getattr(obj, name)
    T.setdefault(key, 0.0)

    def wrapper(*a, **k):
        t = time.perf_counter()
        try:
            return orig(*a, **k)
        finally:
            T[key] += time.perf_counter() - t

    setattr(obj, name, wrapper)


def _instrument() -> None:
    # `clip_frames` CONTAINS `decode`; the report keeps them separate on purpose so a
    # slow fit/scale inside the reader is distinguishable from ffmpeg's own decode.
    _timed(sources.VideoClip, "_frame", "decode")
    _timed(sources.VideoClip, "frames", "clip_frames")
    _timed(fluid.StreamEncoder, "write", "encode")
    _timed(fluid, "flatten", "flatten")
    _timed(sources, "apply_video_opacity", "opacity")
    _timed(graph_render, "_to_rgba", "to_rgba")

    T.setdefault("cache_write", 0.0)
    orig_writer = fluid_cache.frame_writer

    def writer(key, shape):  # time only the memmap stores, not the open/finalize
        mm, finalize, discard = orig_writer(key, shape)
        if mm is None:
            return mm, finalize, discard

        class Timed:
            def __setitem__(self, k, v):
                t = time.perf_counter()
                mm[k] = v
                T["cache_write"] += time.perf_counter() - t

        return Timed(), finalize, discard

    fluid_cache.frame_writer = writer


def _sampler(peak: dict, stop: threading.Event) -> None:
    """Peak concurrent ffmpeg processes and their total RSS. Machine-wide, so close the
    editor before trusting the absolute numbers — the trend is what matters."""
    while not stop.is_set():
        try:
            out = subprocess.run(
                ["ps", "ax", "-o", "rss=,command="], capture_output=True, text=True
            ).stdout
        except OSError:
            break
        ff = [ln for ln in out.splitlines() if "ffmpeg" in ln]
        peak["procs"] = max(peak["procs"], len(ff))
        rss = sum(int(ln.split()[0]) for ln in ff if ln.split()[0].isdigit()) / 1024
        peak["rss_mb"] = max(peak["rss_mb"], round(rss))
        stop.wait(0.5)


def _pick(job: str | None, label: str | None) -> tuple[str, dict, dict]:
    """(job_id, segment, project data) — newest project and its first montage segment
    unless told otherwise."""
    import psycopg
    from psycopg.rows import dict_row

    dsn = os.environ.get("DATABASE_URL", "postgresql://demucs:demucs@localhost:5432/demucs")
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        if job:
            row = conn.execute(
                "select job_id, data from projects where job_id=%s", (job,)
            ).fetchone()
        else:
            row = conn.execute(
                "select job_id, data from projects order by updated_at desc limit 1"
            ).fetchone()
    if row is None:
        raise SystemExit(f"no project {job or '(any)'}")
    data = row["data"]
    segs = data.get("segments") or []
    if label:
        seg = next((s for s in segs if (s.get("label") or s.get("id")) == label), None)
    else:
        seg = next(
            (
                s
                for s in segs
                if any(n.get("type") == "montage" for n in (s.get("graph") or {}).get("nodes", []))
            ),
            segs[0] if segs else None,
        )
    if seg is None:
        raise SystemExit(f"no segment {label or '(any)'} in {row['job_id']}")
    return row["job_id"], seg, data


def main() -> None:
    job_id, seg, data = _pick(os.environ.get("JOB"), os.environ.get("SEGMENT"))
    graph = seg.get("graph") or {}
    export = {**EX._EXPORT_DEFAULTS, **(data.get("export") or {})}
    output = EX._hd_output(export)
    oid = seg.get("finalOutputId") or next(n["id"] for n in graph["nodes"] if n["type"] == "output")

    # A cached clip returns instantly and measures nothing — drop it so the run is cold.
    from backend import paths

    stale = paths.ANIM_DIR / f"{graphmod.output_hash(job_id, seg, graph, oid, output)}.mp4"
    stale.unlink(missing_ok=True)

    _instrument()
    peak = {"procs": 0, "rss_mb": 0}
    stop = threading.Event()
    threading.Thread(target=_sampler, args=(peak, stop), daemon=True).start()

    seg2 = {**seg, "graph": graph, "lyric_lines": seg.get("lyric_lines") or []}
    t0 = time.perf_counter()
    url = graphmod.render_stream(
        job_id,
        seg2,
        graph,
        stem_audio_path,
        output,
        oid,
        block_seconds=EX._hd_block_seconds(output["width"], output["height"]),
    )
    wall = time.perf_counter() - t0
    stop.set()

    dur = float(seg["end"]) - float(seg["start"])
    frames = round(dur * output.get("fps", 30))
    # clip_frames wraps decode; count it once.
    accounted = sum(v for k, v in T.items() if k != "decode")
    print(
        json.dumps(
            {
                "job": job_id,
                "segment": seg.get("label") or seg.get("id"),
                "seconds_of_video": round(dur, 1),
                "frames": frames,
                "size": f"{output['width']}x{output['height']}",
                "wall_s": round(wall, 1),
                "frames_per_second": round(frames / max(wall, 1e-3), 1),
                **{f"{k}_s": round(v, 1) for k, v in sorted(T.items())},
                "unaccounted_s": round(wall - accounted, 1),
                "peak_ffmpeg_procs": peak["procs"],
                "peak_ffmpeg_rss_mb": peak["rss_mb"],
                "url": url,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
