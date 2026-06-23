"""Segment a song into musical sections (intro / verse / chorus / …).

Self-contained port of the segmentation logic from Kaika
(``src/kaika/core/{lyrics,analyze}.py``), trimmed to what Demucs Studio needs.

The proposal is driven by three signals, in order of trust:
  1. Lyrics (when supplied) — Whisper transcribes the vocals, a monotonic
     alignment puts each lyric LINE in front of its sung passage, and the
     instrumental gaps between lines become structural cuts.
  2. Vocal activity — the RMS envelope of the *isolated vocals stem* (we already
     have it from demucs). Gaps in singing become cuts when there are no lyrics.
  3. Timbre clustering — agglomerative clustering on chroma + MFCC, the
     fallback that always produces boundaries.

Everything except :func:`transcribe_words` is pure and model-free.
"""
from __future__ import annotations

import difflib
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

import numpy as np
import librosa

import llm

N_FFT = 2048
HOP = 512
GAP_S = 4.0           # an instrumental gap this long (s) is a section break
LABELS = ["intro", "verse", "chorus", "build", "drop", "outro"]


def load_audio(path: str | Path, sr: Optional[int] = None):
    """(mono float32, sr). soundfile decodes wav/flac/ogg directly; mp4/m4a/aac
    go through the system ffmpeg to a temp wav — librosa's audioread fallback
    has no backend in this venv, so plain ``librosa.load`` fails on video."""
    import soundfile as sf
    try:
        y, native = sf.read(str(path), dtype="float32", always_2d=True)
        y = y.mean(axis=1)
        if sr and sr != native:
            y = librosa.resample(y, orig_sr=native, target_sr=sr)
            native = sr
        return y, int(native)
    except (sf.LibsndfileError, RuntimeError):
        pass
    import subprocess
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(path), "-ac", "1"]
        if sr:
            cmd += ["-ar", str(int(sr))]
        subprocess.run(cmd + [tmp.name], check=True, capture_output=True)
        y, native = sf.read(tmp.name, dtype="float32", always_2d=True)
    return y.mean(axis=1), int(native)


# --------------------------------------------------------------------------- #
# Lyrics parsing
# --------------------------------------------------------------------------- #
_LRC_TAG = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]")
_LRC_META = re.compile(r"^\[(ar|ti|al|by|offset|re|ve|la|length):", re.I)
_SECTION_MARK = re.compile(r"^[\[\(][^\]\)]{1,40}[\]\)]$")   # "[Chorus]", "(x2)"
_INLINE_PARENS = re.compile(r"\([^()]*\)")                   # "(ad-lib)" asides
_GENIUS_JUNK = re.compile(r"^you might also like$", re.I)


@dataclass
class LyricLine:
    t0: float
    t1: float
    text: str
    aligned: bool = True            # False = interpolated, not actually heard


def parse_plain(text: str) -> List[str]:
    """Plain lyrics -> lines: drop blanks, ``[Chorus]`` markers, Genius
    "You might also like" blocks, and inline ``(ad-lib)`` asides."""
    out: List[str] = []
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


def parse_lrc(text: str) -> List[LyricLine]:
    """Timestamped .lrc -> lines; ``t1`` is the next line's start (last +4 s)."""
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
            lines.append(LyricLine(int(mm) * 60 + float(ss), 0.0, body))
    lines.sort(key=lambda l: l.t0)
    for a, b in zip(lines, lines[1:]):
        a.t1 = b.t0
    if lines:
        lines[-1].t1 = lines[-1].t0 + 4.0
    return lines


def _norm(w: str) -> str:
    """Accent-free (NFKD), lowercase, alphanumeric-only token."""
    w = unicodedata.normalize("NFKD", w)
    w = "".join(c for c in w if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", w.lower())


# --------------------------------------------------------------------------- #
# Whisper transcription (the only model-touching function; lazy imports)
# --------------------------------------------------------------------------- #
def _whisper_backend() -> str:
    """mlx-whisper on Apple Silicon when installed, else faster-whisper on
    CUDA when a GPU is present, else CPU."""
    import importlib.util
    import platform
    if (platform.system() == "Darwin" and platform.machine() == "arm64"
            and importlib.util.find_spec("mlx_whisper") is not None):
        return "mlx"
    try:
        import ctranslate2
        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda"
    except Exception:
        pass
    return "cpu"


def transcribe_words(audio_path: str | Path,
                     model_name: str = "small") -> List[tuple]:
    """``[(word, t0, t1)]`` for the track with word timestamps. Backend is
    chosen automatically (mlx / faster-whisper)."""
    backend = _whisper_backend()

    def run_mlx() -> List[tuple]:
        import mlx_whisper
        # Decode to 16 kHz mono and pass the waveform directly — mlx-whisper
        # otherwise shells out to ffmpeg with its own assumptions.
        audio, _ = load_audio(audio_path, sr=16000)
        repo = (model_name if "/" in model_name
                else f"mlx-community/whisper-{model_name}-mlx")
        res = mlx_whisper.transcribe(np.asarray(audio, dtype=np.float32),
                                     path_or_hf_repo=repo, word_timestamps=True)
        return [(w["word"], float(w["start"]), float(w["end"]))
                for seg in res.get("segments", [])
                for w in (seg.get("words") or [])]

    def run_fw(device: str, compute: str) -> List[tuple]:
        from faster_whisper import WhisperModel
        model = WhisperModel(model_name, device=device, compute_type=compute)
        # No VAD: Silero is speech-tuned and silently drops sung vocals.
        segs, _info = model.transcribe(str(audio_path), word_timestamps=True)
        return [(w.word, float(w.start), float(w.end))
                for s in segs for w in (s.words or [])]

    if backend == "mlx":
        try:
            return run_mlx()
        except Exception:
            return run_fw("cpu", "int8")
    if backend == "cuda":
        return run_fw("cuda", "float16")
    return run_fw("cpu", "int8")


# --------------------------------------------------------------------------- #
# Alignment
# --------------------------------------------------------------------------- #
def _resolve_lines(lines: List[str], words: Sequence[Tuple[str, float, float]]
                   ) -> List[Optional[LyricLine]]:
    """Per-ORIGINAL-line alignment: returns a slot per input line (a LyricLine,
    incl. interpolated ones, or None). difflib's matching blocks are monotonic,
    so a repeated chorus lands on its own occurrence."""
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

    match_t: dict = {}
    sm = difflib.SequenceMatcher(None, ref_tok, hyp_tok, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                match_t[i1 + k] = hyp_t[j1 + k]
        elif tag == "replace":
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
            res[li] = LyricLine(min(t[0] for t in ts), max(t[1] for t in ts),
                                lines[li], aligned=True)

    aligned_idx = [i for i, l in enumerate(res) if l is not None]
    if not aligned_idx:
        return res
    for a, b in zip(aligned_idx, aligned_idx[1:]):
        gap = list(range(a + 1, b))
        if not gap:
            continue
        lo, hi = res[a].t1, res[b].t0
        step = (hi - lo) / (len(gap) + 1)
        for j, li in enumerate(gap):
            t0 = lo + step * (j + 1)
            res[li] = LyricLine(t0, min(t0 + max(step, 1.0), hi),
                                lines[li], aligned=False)
    return res


def align_lines(lines: List[str], words: Sequence[Tuple[str, float, float]]
                ) -> List[LyricLine]:
    """Aligned lyric lines (Nones dropped) with readable display timings — used
    for the review overlay / `lyric_lines`."""
    res = _resolve_lines(lines, words)
    final = [l for l in res if l is not None]
    for i, l in enumerate(final):
        nxt = final[i + 1].t0 if i + 1 < len(final) else None
        l.t1 = max(l.t1, l.t0 + 1.2) + 0.5
        if nxt is not None and l.t1 > nxt:
            l.t1 = nxt
        l.t1 = max(l.t1, l.t0 + 0.05)
    return final


# --------------------------------------------------------------------------- #
# Boundaries & labelling
# --------------------------------------------------------------------------- #
def _normalise(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    peak = float(np.max(x)) if x.size else 0.0
    return x / peak if peak > 1e-12 else np.zeros_like(x)


def _lyric_signature(lines: List[dict], start: float, end: float) -> str:
    """Normalized word signature of lines sung within a section — the identity
    used to spot a repeated chorus."""
    words: List[str] = []
    for ln in lines:
        mid = (float(ln["t0"]) + float(ln["t1"])) / 2
        if start <= mid < end:
            for w in str(ln["text"]).lower().split():
                w = "".join(c for c in w if c.isalnum())
                if w:
                    words.append(w)
    return " ".join(words)


def _gap_boundaries(lines: List[dict], duration: float) -> List[float]:
    """Cut candidates from line timing: start of the first line, end of the
    last, and the midpoint of every gap longer than ``GAP_S``. Works for both
    aligned lyrics and pseudo-lines built from vocal-activity intervals."""
    if not lines:
        return []
    ls = sorted(lines, key=lambda l: float(l["t0"]))
    cuts: List[float] = []
    first, last = float(ls[0]["t0"]), float(ls[-1]["t1"])
    if first > GAP_S:
        cuts.append(first)
    for a, b in zip(ls, ls[1:]):
        if float(b["t0"]) - float(a["t1"]) >= GAP_S:
            cuts.append((float(a["t1"]) + float(b["t0"])) / 2)
    if duration - last > GAP_S:
        cuts.append(last)
    return cuts


def _merge_boundaries(cluster_t: List[float], primary_t: List[float],
                      duration: float, min_gap: float = 6.0) -> List[float]:
    """Union of clustering + primary boundaries, deduped so none sit closer
    than ``min_gap`` (primary cuts win — they reflect real structure)."""
    kept = [0.0, duration]
    for t in sorted(primary_t) + sorted(cluster_t):
        if 0.0 < t < duration and all(abs(t - k) >= min_gap for k in kept):
            kept.append(t)
    return sorted(kept)


def _label_sections(bound_t: List[float], duration: float,
                    energies: List[float],
                    lyric_lines: Optional[List[dict]] = None) -> List[dict]:
    """Edges are intro/outro; the middle is labelled by lyric content when
    available (repeated block = chorus, unique = verse, instrumental =
    drop/build by energy), else by energy alone."""
    sections: List[dict] = []
    n = len(bound_t) - 1
    e_norm = _normalise(np.array(energies)) if energies else np.array([])
    sigs = ([_lyric_signature(lyric_lines, bound_t[i], bound_t[i + 1])
             for i in range(n)] if lyric_lines else [""] * n)
    sig_counts: dict = {}
    for s in sigs:
        if s:
            sig_counts[s] = sig_counts.get(s, 0) + 1
    for i in range(n):
        start, end = bound_t[i], bound_t[i + 1]
        e = float(e_norm[i]) if i < len(e_norm) else 0.0
        sig = sigs[i]
        if sig and sig_counts.get(sig, 0) >= 2:
            label = "chorus"
        elif sig:
            label = "verse"
        elif i == 0:
            label = "intro"
        elif i == n - 1:
            label = "outro"
        elif e >= 0.66:
            label = "drop"
        elif e >= 0.33:
            label = "build"
        else:
            label = "verse"
        sections.append({"start": round(start, 3), "end": round(end, 3),
                         "label": label, "energy": round(e, 3)})
    return sections


def _cluster_boundaries(y, sr, S, rms, duration) -> List[float]:
    """Base cut points: agglomerative clustering on chroma + MFCC."""
    k = max(2, min(8, int(round(duration / 25.0)) + 1))
    chroma = librosa.feature.chroma_stft(S=S ** 2, sr=sr)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, hop_length=HOP, n_mfcc=13)
    m = min(chroma.shape[1], mfcc.shape[1], len(rms))
    feat = np.vstack([chroma[:, :m], mfcc[:, :m]])
    try:
        bound_frames = librosa.segment.agglomerative(feat, k)
    except Exception:
        bound_frames = np.linspace(0, m - 1, k + 1).astype(int)
    bound_frames = np.unique(np.concatenate([[0], bound_frames, [m]]))
    return librosa.frames_to_time(bound_frames, sr=sr, hop_length=HOP).tolist()


# --------------------------------------------------------------------------- #
# Vocal activity (the "extracted voice" signal)
# --------------------------------------------------------------------------- #
def vocal_activity(vocals_path: str | Path, fps: int = 20,
                   thresh: float = 0.12, min_run_s: float = 0.5,
                   merge_gap_s: float = 1.0):
    """RMS envelope of the isolated vocals stem.

    Returns ``(envelope, times, voiced)``: a 0..1 loudness value per frame, its
    timestamps, and a list of ``(start, end)`` voiced intervals (runs above
    ``thresh`` longer than ``min_run_s``, with sub-``merge_gap_s`` holes filled).
    """
    y, sr = load_audio(vocals_path)
    hop = max(1, int(round(sr / fps)))
    env = _normalise(librosa.feature.rms(y=y, hop_length=hop)[0])
    times = (np.arange(len(env)) * hop / sr).tolist()

    voiced: List[Tuple[float, float]] = []
    above = env >= thresh
    i = 0
    n = len(above)
    while i < n:
        if above[i]:
            j = i
            while j < n and above[j]:
                j += 1
            voiced.append((i * hop / sr, j * hop / sr))
            i = j
        else:
            i += 1
    # Fill short holes, then drop short runs.
    merged: List[List[float]] = []
    for a, b in voiced:
        if merged and a - merged[-1][1] <= merge_gap_s:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    voiced = [(a, b) for a, b in merged if b - a >= min_run_s]
    return env.tolist(), times, voiced


# --------------------------------------------------------------------------- #
# Beat / bar grid + per-bar audio summary (for the LLM)
# --------------------------------------------------------------------------- #
def _beat_grid(y, sr):
    """Beat times, a 4/4 downbeat grid, and tempo. Downbeat phase = the
    ``beats[k::4]`` (k in 0..3) with the strongest onset energy."""
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    beats = librosa.frames_to_time(beat_frames, sr=sr)
    if len(beats) < 4:
        return beats, beats, float(np.atleast_1d(tempo)[0])
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)

    def strength(t):
        f = int(round(t * sr / 512))
        return float(onset_env[min(len(onset_env) - 1, max(0, f))])
    best_k = max(range(4), key=lambda k: sum(strength(t) for t in beats[k::4]))
    return beats, beats[best_k::4], float(np.atleast_1d(tempo)[0])


def _snap(t, downbeats, beats, window=1.5):
    """Nearest downbeat within ``window`` s, else nearest beat within window/2."""
    cand = [d for d in downbeats if abs(d - t) <= window]
    if cand:
        return float(min(cand, key=lambda d: abs(d - t)))
    cand = [b for b in beats if abs(b - t) <= window * 0.5]
    if cand:
        return float(min(cand, key=lambda b: abs(b - t)))
    return float(t)


def _snap_bounds(bound_t, downbeats, beats, duration):
    snapped = [0.0]
    for t in bound_t[1:-1]:
        s = _snap(t, downbeats, beats)
        if 0 < s < duration and all(abs(s - k) >= 1.0 for k in snapped):
            snapped.append(s)
    snapped.append(duration)
    return sorted(set(snapped))


def _bar_mean(env, sr, hop, t0, t1):
    f0 = int(t0 * sr / hop)
    f1 = max(f0 + 1, int(t1 * sr / hop))
    seg = env[f0:min(f1, len(env))]
    return float(np.mean(seg)) if len(seg) else 0.0


def build_bars(downbeats, duration, stem_paths, mix_y, sr):
    """One row per bar with full-mix + per-stem energy, onset rate, lyric slot."""
    edges = list(downbeats) + [duration]
    hop = 512
    mix_env = _normalise(librosa.feature.rms(y=mix_y, hop_length=hop)[0])
    stem_envs = {}
    for key in ("vocals", "drums", "bass", "other"):
        p = stem_paths.get(key)
        if p:
            ys, srs = load_audio(p)
            stem_envs[key] = (_normalise(librosa.feature.rms(y=ys, hop_length=hop)[0]), srs)
    onsets = librosa.onset.onset_detect(y=mix_y, sr=sr, units="time")
    bars = []
    for i in range(len(downbeats)):
        t0, t1 = edges[i], edges[i + 1]
        row = {"bar": i, "time": round(float(t0), 1),
               "rms": round(_bar_mean(mix_env, sr, hop, t0, t1), 2)}
        for key, lab in (("vocals", "vox"), ("drums", "drums"),
                         ("bass", "bass"), ("other", "other")):
            if key in stem_envs:
                e, srs = stem_envs[key]
                row[lab] = round(_bar_mean(e, srs, hop, t0, t1), 2)
            else:
                row[lab] = 0.0
        row["onset"] = round(sum(1 for o in onsets if t0 <= o < t1) / max(0.1, t1 - t0), 2)
        row["lyric"] = ""
        bars.append(row)
    return bars


def _attach_lyrics(bars, downbeats, duration, res_lines):
    """Append each aligned line's text to the bar it starts in."""
    edges = list(downbeats) + [duration]
    for ln in res_lines:
        if ln is None:
            continue
        for i in range(len(bars)):
            if edges[i] <= ln.t0 < edges[i + 1]:
                bars[i]["lyric"] = (bars[i]["lyric"] + " " + ln.text).strip()
                break


def _sections_from_bars(secs, downbeats, duration):
    """LLM sections [{label,start_bar}] -> [{start,end,label}] on downbeat times."""
    out = []
    for j, s in enumerate(secs):
        start = 0.0 if j == 0 else float(downbeats[s["start_bar"]])
        end = (float(downbeats[secs[j + 1]["start_bar"]])
               if j + 1 < len(secs) else duration)
        if end - start < 0.5:
            continue
        out.append({"start": round(start, 3), "end": round(min(end, duration), 3),
                    "label": s["label"]})
    if out:
        out[0]["start"] = 0.0
        out[-1]["end"] = round(duration, 3)
    return out


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
def propose_segments(audio_path: str | Path,
                     stems: Optional[dict] = None,
                     lyrics_text: Optional[str] = None,
                     model_name: str = "small", fps: int = 20) -> dict:
    """Propose musical segments for a track.

    ``audio_path`` is the full mix; ``stems`` is ``{vocals,drums,bass,other:
    path}`` (per-stem energy feeds the LLM; vocals drives Whisper + activity).
    Primary path: a local LLM reads a per-bar audio+lyrics table and returns the
    section structure on the bar grid. Falls back to heuristics if the LLM is
    unavailable. Returns ``segments``, ``vocal_envelope``, ``envelope_times``,
    ``duration``, ``lyric_lines``.
    """
    stems = stems or {}
    vocals_path = stems.get("vocals")
    y, sr = load_audio(audio_path)
    duration = float(len(y) / sr)
    S = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP))
    rms = _normalise(librosa.feature.rms(S=S)[0])

    voice_src = str(vocals_path) if vocals_path else str(audio_path)
    env, env_times, voiced = vocal_activity(voice_src, fps=fps)

    # Whisper alignment: per-line times (for bars) + display lines.
    res_lines: List[Optional[LyricLine]] = []
    lyric_lines: List[dict] = []
    if lyrics_text and lyrics_text.strip():
        try:
            words = transcribe_words(voice_src, model_name)
            lines = parse_plain(lyrics_text)
            res_lines = _resolve_lines(lines, words)
            disp = align_lines(lines, words)
            lyric_lines = [{"t0": l.t0, "t1": l.t1, "text": l.text,
                            "aligned": l.aligned} for l in disp]
        except Exception:
            res_lines, lyric_lines = [], []

    # --- primary: LLM on a per-bar audio+lyrics table ---
    segments = None
    try:
        beats, downbeats, _tempo = _beat_grid(y, sr)
        if len(downbeats) >= 2:
            bars = build_bars(downbeats, duration, stems, y, sr)
            if res_lines:
                _attach_lyrics(bars, downbeats, duration, res_lines)
            secs = llm.structure_sections(bars)
            segments = _sections_from_bars(secs, downbeats, duration)
    except Exception as e:  # noqa: BLE001
        print(f"segment: LLM structuring failed ({e}); using heuristic")
        segments = None

    # --- fallback: heuristic boundaries, beat-snapped ---
    if not segments:
        cluster_t = _cluster_boundaries(y, sr, S, rms, duration)
        primary = (_gap_boundaries(lyric_lines, duration) if lyric_lines
                   else _gap_boundaries([{"t0": a, "t1": b} for a, b in voiced],
                                        duration))
        bound_t = _merge_boundaries(cluster_t, primary, duration, min_gap=3.0)
        try:
            beats, downbeats, _t = _beat_grid(y, sr)
            bound_t = _snap_bounds(bound_t, downbeats, beats, duration)
        except Exception:  # noqa: BLE001
            pass
        bound_t[0], bound_t[-1] = 0.0, duration
        energies = []
        for a, b in zip(bound_t, bound_t[1:]):
            f0 = int(a * sr / HOP)
            f1 = max(f0 + 1, int(b * sr / HOP))
            seg = rms[f0:min(f1, len(rms))]
            energies.append(float(np.mean(seg)) if len(seg) else 0.0)
        segments = _label_sections(bound_t, duration, energies,
                                   lyric_lines or None)

    return {
        "segments": segments,
        "vocal_envelope": [round(v, 4) for v in env],
        "envelope_times": [round(t, 3) for t in env_times],
        "duration": round(duration, 3),
        "lyric_lines": lyric_lines,
    }


if __name__ == "__main__":
    import json
    import sys
    if len(sys.argv) < 2:
        print("usage: python segment.py <audio> [vocals] [lyrics.txt]")
        raise SystemExit(1)
    audio = sys.argv[1]
    vocals = sys.argv[2] if len(sys.argv) > 2 else None
    lyrics = Path(sys.argv[3]).read_text() if len(sys.argv) > 3 else None
    stems = {}
    if vocals:                       # infer sibling stems next to vocals.wav
        d = Path(vocals).parent
        stems = {k: str(d / f"{k}.wav") for k in ("vocals", "drums", "bass", "other")
                 if (d / f"{k}.wav").exists()}
    out = propose_segments(audio, stems, lyrics)
    out_print = {k: v for k, v in out.items()
                 if k not in ("vocal_envelope", "envelope_times")}
    out_print["envelope_len"] = len(out["vocal_envelope"])
    print(json.dumps(out_print, indent=2))
