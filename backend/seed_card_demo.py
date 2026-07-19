"""The Playground project: one valid pipeline per card, each a small graph that
visibly exercises that card. It's an always-present, app-managed project (job id
``playground``) — built lazily by ``ensure_playground()`` the first time the user opens
the Playground, and hidden from the user's projects list.

`ensure_playground()` is idempotent: it writes SYNTHETIC stems (no upload needed) +
analysis + the segments from ``backend.card_demo.DEMOS``. Once present it additively
SYNCS instead: fixture demos whose card has no segment yet are APPENDED to the rail
(existing segments — the user's rework included — are never touched), so a new card's
demo appears on the next Playground open. The CLI ``python -m backend.seed_card_demo``
(or ``make seed-playground``) force-rebuilds from the fixture (wiping live rework) and
additionally pre-renders each segment as a smoke check.

Only the ``signal`` card needs audio; a synthetic drum stem gives it a kick to react to.
``lyrics`` reads lyric lines from the analysis cache. Everything else is synthetic.
"""

from __future__ import annotations

import json
import logging
import subprocess
import uuid

import numpy as np
import soundfile as sf
from PIL import Image

from . import card_demo, graph
from .media import make_spectrogram, stem_audio_path
from .paths import ANALYSIS_DIR, ASSETS_DIR, SEPARATED_DIR, STEMS, UPLOAD_DIR

JOB_ID = "playground"
TITLE = "Playground"
SR = 44100
SEG_LEN = 3.0  # seconds per segment
OUTPUT = {"width": 1080, "height": 1920, "quality": "draft", "fps": 24}

# Bundled dummy assets the Image/Video playground cards reference (so those cards demo
# without an upload). Generated on seed/open; the graphs point at these URLs.
SAMPLE_IMAGE_URL = f"/assets/{JOB_ID}/sample.png"
SAMPLE_VIDEO_URL = f"/assets/{JOB_ID}/sample.mp4"
# Two more gradient stills so the Image gen card's demo has a slideshow to cycle.
SAMPLE_SLIDES = [SAMPLE_IMAGE_URL, f"/assets/{JOB_ID}/sample2.png", f"/assets/{JOB_ID}/sample3.png"]
# Three short clips in unmistakably different palettes so the Montage card's cuts read.
SAMPLE_CLIPS = [f"/assets/{JOB_ID}/clip{i}.mp4" for i in (1, 2, 3)]


def write_sample_assets() -> None:
    """Create the bundled dummy image(s) + video for the Image/Video/Image-gen cards
    (idempotent). Soft gradient stills in distinct hue pairs, and a short
    animated-gradient clip."""
    d = ASSETS_DIR / JOB_ID
    d.mkdir(parents=True, exist_ok=True)
    # (name, channel mix) — each still sweeps between a different hue pair so the
    # slideshow switch is unmistakable in the demo.
    gradients = [
        ("sample.png", lambda t: (0.72 - 0.45 * t, 0.29 + 0.40 * t, 0.45 + 0.45 * t)),
        ("sample2.png", lambda t: (0.20 + 0.60 * t, 0.55 - 0.30 * t, 0.75 - 0.40 * t)),
        ("sample3.png", lambda t: (0.85 - 0.20 * t, 0.60 + 0.25 * t, 0.25 + 0.15 * t)),
    ]
    for name, mix in gradients:
        png = d / name
        if not png.exists():
            w, h = 640, 360
            yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
            t = ((xx / w) + (yy / h)) / 2.0
            arr = np.stack(mix(t), -1)
            Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8), "RGB").save(png)
    # The Video demo's clip, plus three montage clips in unmistakably different
    # palettes (one per SAMPLE_CLIPS entry) so each cut is obvious in the demo.
    clips = [
        ("sample.mp4", "c0=0xB84A74:c1=0x34808A:c2=0xF2C14E"),
        ("clip1.mp4", "c0=0xE4572E:c1=0xF3A712:c2=0xA8C686"),
        ("clip2.mp4", "c0=0x17BEBB:c1=0x2E282A:c2=0x76B5C5"),
        ("clip3.mp4", "c0=0x9B5DE5:c1=0xF15BB5:c2=0x00BBF9"),
    ]
    for name, palette in clips:
        mp4 = d / name
        if not mp4.exists():
            subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    f"gradients=s=640x360:d=4:speed=0.08:{palette}",
                    "-r",
                    "24",
                    "-pix_fmt",
                    "yuv420p",
                    "-movflags",
                    "+faststart",
                    str(mp4),
                ],
                check=False,
            )


# --------------------------------------------------------------------------- #
# Synthetic audio
# --------------------------------------------------------------------------- #
def _drums(t: np.ndarray) -> np.ndarray:
    """A 120 BPM click track: 60 Hz kicks + noisy hats, so the energy/onset features
    have real transients to react to."""
    sig = np.zeros_like(t)
    rng = np.random.default_rng(0)
    n_kick = int(0.12 * SR)
    kick_env = np.exp(-np.arange(n_kick) / (0.05 * SR))
    kick = np.sin(2 * np.pi * 60 * np.arange(n_kick) / SR) * kick_env
    for k in range(int(t[-1] / 0.5) + 1):  # kick every 0.5 s
        i0 = int(k * 0.5 * SR)
        sig[i0 : i0 + n_kick] += kick[: max(0, len(sig) - i0)]
    n_hat = int(0.03 * SR)
    hat_env = np.exp(-np.arange(n_hat) / (0.01 * SR))
    for k in range(int(t[-1] / 0.25) + 1):  # hat every 0.25 s
        i0 = int(k * 0.25 * SR)
        sig[i0 : i0 + n_hat] += (rng.standard_normal(n_hat) * hat_env * 0.3)[
            : max(0, len(sig) - i0)
        ]
    return sig


def _tone(t: np.ndarray, freq: float, wobble: float = 4.0) -> np.ndarray:
    env = 0.6 + 0.4 * np.sin(2 * np.pi * wobble * t / max(1.0, t[-1]))
    return np.sin(2 * np.pi * freq * t) * env


def _norm(x: np.ndarray) -> np.ndarray:
    m = float(np.max(np.abs(x))) or 1.0
    return (x / m * 0.9).astype(np.float32)


def write_synthetic_stems(job_id: str, duration: float) -> dict:
    """Write the synthetic stem WAVs where `media.stem_audio_path` resolves them, plus
    the `original` mix and per-stem spectrograms. Returns the stems metadata map."""
    t = np.arange(int(SR * duration), dtype=np.float32) / SR
    parts = {
        "drums": _drums(t),
        "bass": _tone(t, 80, 1.5),
        "vocals": _tone(t, 220, 3.0),
        "other": _tone(t, 440, 2.0) * 0.5,
    }
    parts = {k: _norm(v) for k, v in parts.items()}
    original = _norm(
        parts["drums"] * 0.8 + parts["bass"] * 0.6 + parts["vocals"] * 0.4 + parts["other"] * 0.3
    )

    # separated stems: <SEPARATED_DIR>/<job>/<model>/<song>/<stem>.wav (find_stem_dir
    # picks the first model + song dir, so any names work).
    song_dir = SEPARATED_DIR / job_id / "htdemucs" / "song"
    song_dir.mkdir(parents=True, exist_ok=True)
    for stem, audio in parts.items():
        sf.write(str(song_dir / f"{stem}.wav"), audio, SR)
    # original lives under uploads/<job>/original.wav (for UI playback + spectrogram).
    up = UPLOAD_DIR / job_id
    up.mkdir(parents=True, exist_ok=True)
    sf.write(str(up / "original.wav"), original, SR)

    # spectrograms + sr metadata so the Signals tab isn't blank.
    from .paths import COLORMAPS, SPECTRO_DIR

    stems_meta: dict = {}
    for stem in STEMS:
        src = stem_audio_path(job_id, stem)
        sr, _ = make_spectrogram(src, SPECTRO_DIR / job_id / f"{stem}.png", COLORMAPS[stem])
        stems_meta[stem] = {
            "audio": f"/audio/{job_id}/{stem}",
            "spectrogram": f"/spectrogram/{job_id}/{stem}",
            "sr": sr,
        }
    return stems_meta


# --------------------------------------------------------------------------- #
# Segments + analysis cache
# --------------------------------------------------------------------------- #
def build_segments(demos: list[dict]) -> list[dict]:
    segs = []
    for i, d in enumerate(demos):
        segs.append(
            {
                "id": f"seg-{i}",
                "label": d["label"],
                "start": round(i * SEG_LEN, 3),
                "end": round((i + 1) * SEG_LEN, 3),
                "signals": d["signals"],
                "graph": d["graph"],
            }
        )
    return segs


def _lyric_lines(segments: list[dict]) -> list[dict]:
    """Author lyric lines spanning the lyrics segment's window (absolute song time).
    Found by the graph containing a `lyrics` node, so it's independent of the label."""
    seg = next(
        (s for s in segments if any(n.get("type") == "lyrics" for n in s["graph"]["nodes"])),
        None,
    )
    if seg is None:
        return []
    s, e = seg["start"], seg["end"]
    words = ["lyrics", "card", "on", "the", "beat"]
    n = len(words)
    step = (e - s) / n
    return [
        {
            "t0": round(s + k * step, 3),
            "t1": round(s + (k + 1) * step, 3),
            "text": " ".join(words[: k + 1]),
        }
        for k in range(n)
    ]


def write_analysis(job_id: str, segments: list[dict], duration: float) -> list[dict]:
    times = np.arange(0.0, duration, 0.25)
    env = (0.5 + 0.5 * np.sin(2 * np.pi * times / 2.0)).round(3).tolist()
    lines = _lyric_lines(segments)
    ANALYSIS_DIR.mkdir(parents=True, exist_ok=True)
    (ANALYSIS_DIR / f"{job_id}.json").write_text(
        json.dumps(
            {"vocal_envelope": env, "envelope_times": times.round(3).tolist(), "lyric_lines": lines}
        )
    )
    return lines


# --------------------------------------------------------------------------- #
# Build / ensure
# --------------------------------------------------------------------------- #
def _build(db, *, render: bool, log=lambda _m="": None) -> str:
    """(Re)build the Playground project: synthetic stems + analysis + DB rows. With
    `render`, also pre-render each segment as a smoke check (the CLI path); the app's
    ensure path skips that (the Studio renders on open)."""
    segments = build_segments(card_demo.DEMOS)
    duration = len(segments) * SEG_LEN

    log(f"writing synthetic stems ({duration:.0f}s) …")
    stems_meta = write_synthetic_stems(JOB_ID, duration)
    write_sample_assets()  # dummy image/video for the Image/Video card demos
    lines = write_analysis(JOB_ID, segments, duration)

    log("(re)creating project …")
    db.delete_project(JOB_ID)
    db.create_project(
        JOB_ID,
        title=TITLE,
        source="synthetic",
        duration=duration,
        fmin=20,
        has_lyrics=bool(lines),
        stems=stems_meta,
    )
    db.save_segments(JOB_ID, segments, step="studio", output=OUTPUT)

    if render:
        log("rendering each segment (smoke check) …")
        for seg in segments:
            # Mirror the app: the lyric lines ride in the render payload (OutputNode
            # does this) so the lyrics segment renders its text here too.
            payload = {**seg, "lyric_lines": lines}
            out_id = next(n["id"] for n in seg["graph"]["nodes"] if n["type"] == "output")
            url = graph.render(JOB_ID, payload, seg["graph"], stem_audio_path, OUTPUT, out_id)
            log(f"  • {seg['label']:<22} {url}")
    return JOB_ID


def _append_missing_demos(db) -> list[str]:
    """Additive demo sync: append a segment for every fixture demo whose card has no
    segment in the LIVE playground yet (matched by label), after the existing timeline.
    Existing segments — including the user's rework/experiments — are never touched, so
    a new card's demo appears on the next Playground open without a destructive reseed.
    The synthetic stems/analysis are regenerated to cover the extended duration (same
    deterministic content, longer). Returns the appended labels."""
    row = db.get_project(JOB_ID)
    segments = row["data"]["segments"]
    have = {s.get("label") for s in segments}
    missing = [d for d in card_demo.DEMOS if d["label"] not in have]
    if not missing:
        return []
    end0 = max((float(s.get("end", 0.0)) for s in segments), default=0.0)
    for k, d in enumerate(missing):
        s0 = end0 + k * SEG_LEN
        segments.append(
            {
                "id": f"seg-{uuid.uuid4().hex[:8]}",
                "label": d["label"],
                "start": round(s0, 3),
                "end": round(s0 + SEG_LEN, 3),
                "signals": d["signals"],
                "graph": d["graph"],
            }
        )
    duration = end0 + len(missing) * SEG_LEN
    write_synthetic_stems(JOB_ID, duration)
    write_analysis(JOB_ID, segments, duration)
    db.save_segments(JOB_ID, segments, step="studio")
    db.set_duration(JOB_ID, duration)
    return [d["label"] for d in missing]


def ensure_playground() -> str:
    """Idempotent: build the always-present Playground project if it's missing (its DB
    row AND its synthetic stems), and additively SYNC it when it exists — any fixture
    demo whose card has no segment yet is appended to the rail (existing segments,
    including the user's rework, are never touched), so a new card's demo shows up on
    the next Playground open without a destructive reseed. No pre-render — the Studio
    renders on open. Called by `POST /playground`."""
    from . import db

    write_sample_assets()  # idempotent — ensure the dummy assets exist even for an old playground
    if db.get_project(JOB_ID) is not None and stem_audio_path(JOB_ID, "drums") is not None:
        appended = _append_missing_demos(db)
        if appended:
            logging.getLogger("kaika").info(
                "playground: appended demo segment(s): %s", ", ".join(appended)
            )
        return JOB_ID
    return _build(db, render=False)


def export_playground() -> dict:
    """Capture the CURRENT live Playground (your reworked pipelines) into the committed
    fixture `card_demo.PIPELINES_PATH`, which the seed then loads as the defaults. Each
    segment's signals are trimmed to only those its graph references (drops the studio
    hydration noise), and its graph is stored verbatim.

    ADDITIVE, like the demo sync: a fixture entry whose card has NO segment in the live
    rail is KEPT, never silently dropped — a stale or partial rail (e.g. a tab that
    autosaved an older segment list) can't erase other cards' demos from the fixture.
    Removing a demo on purpose means deleting the card itself (or hand-pruning in a
    commit, deliberately).

    Returns a summary the callers surface — the CLI prints it, the Playground's
    💾 save-fixture route returns it as JSON:
    `{"exported": n, "kept": [cards preserved from the prior fixture],
    "skipped": [unknown labels], "missing": [cards with no demo anywhere]}`.
    Raises LookupError when the playground project doesn't exist yet."""
    from . import card_demo, db

    row = db.get_project(JOB_ID)
    if row is None:
        raise LookupError(f"no '{JOB_ID}' project in the DB — open the Playground once first")
    label_to_key = {label: key for key, label in card_demo.CARD_LABELS.items()}
    out = []
    skipped = []
    for s in row["data"]["segments"]:
        key = label_to_key.get(s["label"])
        if key is None:
            skipped.append(s["label"])
            continue
        graph = s["graph"]
        referenced = {
            n.get("data", {}).get("signalId") for n in graph["nodes"] if n.get("type") == "signal"
        }
        signals = [sig for sig in s.get("signals", []) if sig.get("id") in referenced]
        out.append({"key": key, "label": s["label"], "signals": signals, "graph": graph})
    exported = {e["key"] for e in out}
    prior = (
        json.loads(card_demo.PIPELINES_PATH.read_text())
        if card_demo.PIPELINES_PATH.exists()
        else []
    )
    kept = [e for e in prior if e["key"] not in exported and e["key"] in card_demo.ALL_CARDS]
    card_demo.PIPELINES_PATH.write_text(json.dumps(out + kept, indent=2))
    missing = sorted(card_demo.ALL_CARDS - exported - {e["key"] for e in kept})
    return {
        "exported": len(out),
        "kept": sorted(e["key"] for e in kept),
        "skipped": skipped,
        "missing": missing,
    }


def _print_export_summary(summary: dict) -> None:
    from . import card_demo

    for label in summary["skipped"]:
        print(f"  ! skipping segment with unknown card label: {label!r}")
    print(
        f"[playground] exported {summary['exported']} pipelines -> {card_demo.PIPELINES_PATH.name}"
    )
    if summary.get("kept"):
        print(f"  • kept prior fixture demos for cards not in the live rail: {summary['kept']}")
    if summary["missing"]:
        print(f"  ! WARNING: no pipeline exported for cards: {summary['missing']}")


def seed() -> str:
    """CLI entry (`python -m backend.seed_card_demo` / `make seed-playground`): force a
    rebuild from the fixture and pre-render every segment as a smoke check."""
    from . import db  # local import so the module imports without a live DB

    job = _build(db, render=True, log=lambda m="": print(f"[playground] {m}" if m else ""))
    print(f"\n[playground] done — open '{TITLE}' (job {job}) in the Studio.")
    return job


if __name__ == "__main__":
    import sys

    _print_export_summary(export_playground()) if sys.argv[1:2] == ["export"] else seed()
