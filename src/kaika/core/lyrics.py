"""Lyrics: parsing, Whisper forced alignment, ASS subtitles, fluid text masks.

The user uploads plain-text lyrics with the track; Whisper transcribes the
audio with word timestamps and a monotonic alignment puts each lyric LINE in
front of its sung passage. Two consumers share the result (``lyrics.json``):
the ASS overlay burned by ffmpeg in ``post.assemble`` and the fluid text
stamps in ``simulate`` (lyrics.mode = fluid/both).

Everything except :func:`transcribe_words` is pure and model-free — tests
inject a fake transcriber. ``.lrc`` files (already timestamped) bypass the
model entirely.
"""
from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import unicodedata
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Callable, List, Optional, Sequence, Tuple

import numpy as np
import cv2

from .analyze import audio_cache_key

# (word, t_start, t_end) triples, whatever produced them.
Words = Sequence[Tuple[str, float, float]]


@dataclass
class LyricLine:
    t0: float
    t1: float
    text: str
    aligned: bool = True            # False = interpolated, not heard


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

_LRC_TAG = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]")
_LRC_META = re.compile(r"^\[(ar|ti|al|by|offset|re|ve|la|length):", re.I)
_SECTION_MARK = re.compile(r"^[\[\(][^\]\)]{1,40}[\]\)]$")   # "[Chorus]", "(x2)"
_INLINE_PARENS = re.compile(r"\([^()]*\)")                   # "(ad-lib)" asides
# Genius pastes carry a suggestion block: this header, then song/artist lines
# until the next "[Section]" marker.
_GENIUS_JUNK = re.compile(r"^you might also like$", re.I)


def parse_lrc(text: str) -> List[LyricLine]:
    """Timestamped .lrc -> lines. Supports several tags per line; ``t1`` is
    the next line's start (last line: +4 s)."""
    lines: List[LyricLine] = []
    for raw in text.splitlines():
        raw = raw.strip()
        if not raw or _LRC_META.match(raw):
            continue
        tags = _LRC_TAG.findall(raw)
        body = _LRC_TAG.sub("", raw).strip()
        if not tags or not body:
            continue
        for mm, ss in tags:
            lines.append(LyricLine(t0=int(mm) * 60 + float(ss), t1=0.0,
                                   text=body))
    lines.sort(key=lambda l: l.t0)
    for a, b in zip(lines, lines[1:]):
        a.t1 = b.t0
    if lines:
        lines[-1].t1 = lines[-1].t0 + 4.0
    return lines


def parse_plain(text: str) -> List[str]:
    """Plain lyrics -> lines: drops blanks, "[Chorus]"-style markers and
    Genius "You might also like" suggestion blocks, and strips inline
    "(ad-lib)" asides — background echoes are noise for both the Whisper
    alignment and the overlay. Lines left empty by the strip drop."""
    out = []
    in_junk = False
    for raw in text.splitlines():
        raw = raw.strip()
        if not raw:
            continue
        if _SECTION_MARK.match(raw):
            in_junk = False
            continue
        if _GENIUS_JUNK.match(raw):
            in_junk = True
            continue
        if in_junk:
            continue
        line = re.sub(r"\s{2,}", " ", _INLINE_PARENS.sub(" ", raw)).strip()
        if line:
            out.append(line)
    return out


def _norm(w: str) -> str:
    """Accent-free (NFKD), lowercase, alphanumeric-only token."""
    w = unicodedata.normalize("NFKD", w)
    w = "".join(c for c in w if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", w.lower())


# ---------------------------------------------------------------------------
# Whisper transcription (the only model-touching function; lazy import)
# ---------------------------------------------------------------------------

def transcribe_words(audio_path: str | Path,
                     model_name: Optional[str] = None,
                     model_dir: Optional[str | Path] = None) -> List[tuple]:
    """[(word, t0, t1)] for the whole track via faster-whisper, word
    timestamps + VAD. Tries CUDA/float16, falls back to CPU/int8."""
    from faster_whisper import WhisperModel
    name = model_name or os.environ.get("KAIKA_WHISPER_MODEL", "small")
    kw = {"download_root": str(model_dir)} if model_dir else {}

    def run(device: str, compute: str) -> List[tuple]:
        model = WhisperModel(name, device=device, compute_type=compute, **kw)
        # No VAD: Silero is speech-tuned and silently discards sung vocals.
        # Hallucinated words on instrumentals are handled downstream by the
        # alignment's coverage threshold instead.
        segs, _info = model.transcribe(str(audio_path), word_timestamps=True)
        return [(w.word, float(w.start), float(w.end))
                for s in segs for w in (s.words or [])]

    try:
        return run("cuda", "float16")
    except Exception as gpu_err:                             # noqa: BLE001
        # A missing model (first run, no network) raises here too — surface
        # it clearly instead of masking it as a silent CPU fallback.
        msg = str(gpu_err).lower()
        if any(s in msg for s in ("connection", "could not download",
                                  "not found", "huggingface", "timed out",
                                  "resolve", "offline")):
            raise RuntimeError(
                f"could not load the Whisper '{name}' model — first-time "
                "alignment needs network access to download it once "
                f"(then it is cached). Original error: {gpu_err}") from gpu_err
        return run("cpu", "int8")


# ---------------------------------------------------------------------------
# Alignment
# ---------------------------------------------------------------------------

def align_lines(lines: List[str], words: Words
                ) -> Tuple[List[LyricLine], List[str]]:
    """Monotonically align lyric LINES to a transcribed word stream.

    difflib's matching blocks over the normalized token lists are monotonic
    by construction, so a repeated chorus lands on its own occurrence. Lines
    with < 40% matched tokens are interpolated between aligned neighbours
    (``aligned=False``); leading/trailing unmatched lines are dropped."""
    ref_tok: List[str] = []
    ref_line: List[int] = []
    for li, line in enumerate(lines):
        for tok in line.split():
            n = _norm(tok)
            if n:
                ref_tok.append(n)
                ref_line.append(li)
    hyp_tok: List[str] = []
    hyp_t: List[Tuple[float, float]] = []
    for w, t0, t1 in words:
        n = _norm(w)
        if n:
            hyp_tok.append(n)
            hyp_t.append((float(t0), float(t1)))

    match_t: dict = {}                  # ref token index -> (t0, t1)
    sm = difflib.SequenceMatcher(None, ref_tok, hyp_tok, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                match_t[i1 + k] = hyp_t[j1 + k]
        elif tag == "replace":          # near-misses inside the monotonic gap
            for k in range(min(i2 - i1, j2 - j1)):
                a, b = ref_tok[i1 + k], hyp_tok[j1 + k]
                if difflib.SequenceMatcher(None, a, b).ratio() >= 0.7:
                    match_t[i1 + k] = hyp_t[j1 + k]

    per_line: dict = {}
    counts: dict = {}
    for ri, li in enumerate(ref_line):
        counts[li] = counts.get(li, 0) + 1
        if ri in match_t:
            per_line.setdefault(li, []).append(match_t[ri])

    n = len(lines)
    res: List[Optional[LyricLine]] = [None] * n
    for li in range(n):
        ts = per_line.get(li, [])
        if counts.get(li) and len(ts) / counts[li] >= 0.4:
            res[li] = LyricLine(t0=min(t[0] for t in ts),
                                t1=max(t[1] for t in ts),
                                text=lines[li], aligned=True)

    warnings: List[str] = []
    # Interpolate interior gaps between aligned neighbours.
    aligned_idx = [i for i, l in enumerate(res) if l is not None]
    if not aligned_idx:
        return [], [f"no lyric line could be aligned ({n} lines)"]
    for a, b in zip(aligned_idx, aligned_idx[1:]):
        gap = list(range(a + 1, b))
        if not gap:
            continue
        lo, hi = res[a].t1, res[b].t0
        step = (hi - lo) / (len(gap) + 1)
        for j, li in enumerate(gap):
            t0 = lo + step * (j + 1)
            res[li] = LyricLine(t0=t0, t1=min(t0 + max(step, 1.0), hi),
                                text=lines[li], aligned=False)
            warnings.append(f"line {li} not heard, interpolated: "
                            f"'{lines[li][:40]}'")
    for li in list(range(0, aligned_idx[0])) + \
            list(range(aligned_idx[-1] + 1, n)):
        warnings.append(f"line {li} not heard at the track edge, dropped: "
                        f"'{lines[li][:40]}'")

    final = [l for l in res if l is not None]
    # Readability: minimum display time, slight extension, never overlap the
    # next line (a hard end-before-next-start contract for the renderer).
    for i, l in enumerate(final):
        nxt = final[i + 1].t0 if i + 1 < len(final) else None
        l.t1 = max(l.t1, l.t0 + 1.2) + 0.5
        if nxt is not None and l.t1 > nxt:
            l.t1 = nxt          # touch but don't cross the next start
        l.t1 = max(l.t1, l.t0 + 0.05)   # always a positive, non-zero span
    return final, warnings


def align_lyrics_cached(audio_path: str | Path, lyrics_text: str,
                        cache_dir: Optional[str | Path],
                        model_name: str = "small",
                        model_dir: Optional[str | Path] = None,
                        transcriber: Optional[Callable] = None
                        ) -> Tuple[List[LyricLine], List[str]]:
    """Alignment memoised on (audio content, lyrics text, model)."""
    key = (f"{audio_cache_key(audio_path)}-"
           f"{hashlib.sha1(lyrics_text.encode()).hexdigest()[:12]}-"
           f"{model_name}-lyr2")     # bump on parsing changes
    p = Path(cache_dir) / f"{key}.json" if cache_dir else None
    if p and p.exists():
        d = json.loads(p.read_text())
        return [LyricLine(**x) for x in d["lines"]], d.get("warnings", [])
    words = (transcriber or transcribe_words)(audio_path, model_name,
                                              model_dir)
    lines, warnings = align_lines(parse_plain(lyrics_text), words)
    if p:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"lines": [asdict(l) for l in lines],
                                 "warnings": warnings}))
    return lines, warnings


# ---------------------------------------------------------------------------
# The per-run job
# ---------------------------------------------------------------------------

def lyrics_source(run_dir: str | Path) -> Optional[Path]:
    """The frozen lyrics file of a run (lyrics.txt / lyrics.lrc), if any."""
    hits = [p for p in sorted(Path(run_dir).glob("lyrics.*"))
            if p.suffix != ".json"]
    return hits[0] if hits else None


def load_lyric_lines(run_dir: str | Path) -> List[LyricLine]:
    """The aligned lines of a run (empty when not ready)."""
    p = Path(run_dir) / "lyrics.json"
    if not p.exists():
        return []
    try:
        return [LyricLine(**x) for x in json.loads(p.read_text())]
    except (json.JSONDecodeError, TypeError):
        return []


def align_project_lyrics(run_dir: str | Path, runs_root: str | Path,
                         model_dir: Optional[str | Path] = None,
                         progress: Optional[Callable] = None,
                         transcriber: Optional[Callable] = None) -> int:
    """Job body: align the run's frozen lyrics and write ``lyrics.json``.
    Returns the number of lines; manifest gets a ``lyrics`` status block."""
    run_dir = Path(run_dir)
    src = lyrics_source(run_dir)
    manifest_p = run_dir / "run.json"
    manifest = (json.loads(manifest_p.read_text())
                if manifest_p.exists() else {})
    if progress:
        progress("lyrics", 0, 1)
    try:
        if src is None:
            raise FileNotFoundError("no lyrics file in the run")
        text = src.read_text(errors="replace")
        if src.suffix == ".lrc":
            lines, warnings = parse_lrc(text), []
        else:
            from .pipeline import frozen_audio
            audio = frozen_audio(run_dir)
            if audio is None:
                raise FileNotFoundError("no frozen audio in the run")
            model = os.environ.get("KAIKA_WHISPER_MODEL", "small")
            lines, warnings = align_lyrics_cached(
                audio, text, Path(runs_root) / ".analysis_cache",
                model_name=model, model_dir=model_dir,
                transcriber=transcriber)
        (run_dir / "lyrics.json").write_text(
            json.dumps([asdict(l) for l in lines]))
        manifest["lyrics"] = {"status": "ready", "lines": len(lines),
                              "warnings": warnings}
    except Exception as e:                                   # noqa: BLE001
        manifest["lyrics"] = {"status": "error",
                              "error": f"{type(e).__name__}: {e}"}
        raise
    finally:
        manifest_p.write_text(json.dumps(manifest, indent=2))
        if progress:
            progress("lyrics", 1, 1)
    return len(lines)


# ---------------------------------------------------------------------------
# ASS overlay
# ---------------------------------------------------------------------------

# position -> (ASS Alignment numpad code, MarginV in PlayRes units)
_ASS_POS = {"bottom": (2, 28), "lower_third": (2, 180),
            "center": (5, 0), "top": (8, 36)}


def _ass_color(hex_str: str) -> str:
    r, g, b = hex_str[1:3], hex_str[3:5], hex_str[5:7]
    return f"&H00{b.upper()}{g.upper()}{r.upper()}"


def _ass_time(t: float) -> str:
    t = max(0.0, t)
    return f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"


def build_ass(lines: List[LyricLine], cfg, offset_s: float = 0.0) -> str:
    """Aligned lines -> an ASS document. ``cfg`` is a recipe LyricsConfig.
    ``offset_s`` shifts timestamps for clipped previews (out-of-window lines
    are dropped). PlayRes is fixed — libass rescales to the real video."""
    align, margin_v = _ASS_POS.get(cfg.position, (2, 28))
    size = int(round(40 * float(cfg.scale)))
    outline = 2 if cfg.outline else 0
    shadow = 1 if cfg.outline else 0
    head = (
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 720\nPlayResY: 720\n"
        "WrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, "
        "BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, "
        "MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,Liberation Sans,{size},{_ass_color(cfg.color)},"
        f"&H00000000,&H80000000,0,0,1,{outline},{shadow},{align},40,40,"
        f"{margin_v},1\n\n[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
        "Effect, Text\n")
    evs = []
    for l in lines:
        t0, t1 = l.t0 - offset_s, l.t1 - offset_s
        if t1 <= 0:
            continue
        text = l.text.replace("\n", r"\N")
        evs.append(f"Dialogue: 0,{_ass_time(t0)},{_ass_time(t1)},Default,,"
                   f"0,0,0,,{text}")
    return head + "\n".join(evs) + "\n"


def sub_filter_escape(path: str | Path) -> str:
    """Escape a path for ffmpeg's subtitles filter argument."""
    s = str(path).replace("\\", "\\\\").replace(":", r"\:").replace("'", r"\'")
    return s


# ---------------------------------------------------------------------------
# Fluid text masks
# ---------------------------------------------------------------------------

_FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
)


def text_mask(text: str, shape_hw: Tuple[int, int],
              center: Tuple[float, float] = (0.5, 0.5),
              height_frac: float = 0.08,
              blur_cells: float = 1.0) -> np.ndarray:
    """Rasterize ``text`` to a float 0..1 mask on the dye grid: glyphs at
    ``height_frac`` of the short side, centered at ``center`` (normalized),
    auto-shrunk to fit the width, softly blurred for clean dye edges."""
    from PIL import Image, ImageDraw, ImageFont
    h, w = int(shape_hw[0]), int(shape_hw[1])
    px = max(6, int(round(height_frac * min(h, w))))

    def load_font(size: int):
        for cand in _FONT_CANDIDATES:
            if Path(cand).exists():
                return ImageFont.truetype(cand, size)
        try:
            return ImageFont.truetype("DejaVuSans-Bold.ttf", size)
        except Exception:                                    # noqa: BLE001
            return ImageFont.load_default()

    font = load_font(px)
    img = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(img)
    bbox = d.textbbox((0, 0), text, font=font)
    tw = max(1, bbox[2] - bbox[0])
    if tw > 0.92 * w:                   # shrink to fit the canvas width
        px = max(6, int(px * 0.92 * w / tw))
        font = load_font(px)
        bbox = d.textbbox((0, 0), text, font=font)
        tw = max(1, bbox[2] - bbox[0])
    th = max(1, bbox[3] - bbox[1])
    cx, cy = float(center[0]) * w, float(center[1]) * h
    d.text((cx - tw / 2 - bbox[0], cy - th / 2 - bbox[1]), text,
           fill=255, font=font)
    m = np.asarray(img, np.float32) / 255.0
    if blur_cells > 0:
        m = cv2.GaussianBlur(m, (0, 0), sigmaX=float(blur_cells))
        peak = float(m.max())
        if peak > 0:
            m /= peak
    return m
