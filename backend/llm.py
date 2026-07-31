"""Local-LLM song structuring via Ollama (schema-constrained JSON output).

Given a per-bar table of audio features (per-stem energy, onsets) + the lyrics
landing in each bar, the model splits the song into sections and labels them,
choosing boundaries on the bar grid. We only trust its grouping/labels — the
times come from the precomputed downbeats — so it can't drift off the beat.
"""

from __future__ import annotations

import json
import os
import urllib.request

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3.6:35b-a3b")
# Let the model reason about structure (better cuts); it still emits schema JSON
# in `content`, with the reasoning in a separate `thinking` field. Off via env.
OLLAMA_THINK = os.environ.get("OLLAMA_THINK", "1") != "0"

LABELS = ["intro", "verse", "pre-chorus", "chorus", "bridge", "drop", "break", "outro"]

_SCHEMA = {
    "type": "object",
    "properties": {
        "sections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string", "enum": LABELS},
                    "start_bar": {"type": "integer"},
                },
                "required": ["label", "start_bar"],
            },
        }
    },
    "required": ["sections"],
}

_SYSTEM = (
    "You are a music structure analyst. You get a per-bar table for ONE song: "
    "each row is a bar with its time and audio energy of the full mix and the "
    "separated stems (vox, drums, bass, other), an onset rate, and any lyrics "
    "sung in that bar. Split the whole song into contiguous sections and label "
    "each. Use BOTH the audio dynamics (energy rising/falling, drums or vocals "
    "entering/dropping) AND the lyrics (a block of lyrics that repeats is the "
    "chorus; unique sung blocks are verses). Mark lyric-less spans as intro / "
    "break / outro by position, and big energy jumps as drop/build. Sections "
    "must be in order, cover the song, the first start_bar must be 0, and every "
    "start_bar must be a bar number from the table. Output JSON only."
)


def _table(bars: list) -> str:
    head = "bar | time | rms | vox drums bass other | onset | lyric"
    rows = [
        f"{b['bar']} | {b['time']:.0f}s | {b['rms']:.2f} | "
        f"{b['vox']:.2f} {b['drums']:.2f} {b['bass']:.2f} {b['other']:.2f} | "
        f"{b['onset']:.2f} | {b.get('lyric', '')}"
        for b in bars
    ]
    return head + "\n" + "\n".join(rows)


def structure_sections(bars: list, timeout: float = 180.0) -> list:
    """Return ``[{label, start_bar}]`` in order. Raises on any failure so the
    caller can fall back to the heuristic."""
    if not bars:
        raise RuntimeError("no bars to structure")
    payload = {
        "model": OLLAMA_MODEL,
        "stream": False,
        "think": OLLAMA_THINK,
        "format": _SCHEMA,
        "messages": [
            {"role": "system", "content": _SYSTEM},
            {
                "role": "user",
                "content": "Per-bar table:\n" + _table(bars) + "\n\nReturn the sections.",
            },
        ],
    }
    req = urllib.request.Request(
        OLLAMA_URL.rstrip("/") + "/api/chat",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    resp = json.load(urllib.request.urlopen(req, timeout=timeout))
    data = json.loads(resp["message"]["content"])
    n = len(bars)
    out = []
    for s in data.get("sections", []):
        try:
            sb = int(s["start_bar"])
            lab = str(s["label"])
        except (KeyError, ValueError, TypeError):
            continue
        sb = max(0, min(n - 1, sb))
        if lab not in LABELS:
            lab = "verse"
        out.append({"label": lab, "start_bar": sb})
    if not out:
        raise RuntimeError("LLM returned no sections")
    out.sort(key=lambda x: x["start_bar"])
    # dedup identical start bars, force first to 0
    dedup = []
    for s in out:
        if dedup and dedup[-1]["start_bar"] == s["start_bar"]:
            continue
        dedup.append(s)
    dedup[0]["start_bar"] = 0
    return dedup


# --------------------------------------------------------------------------- #
# Lyric alignment
# --------------------------------------------------------------------------- #
_ALIGN_SCHEMA = {
    "type": "object",
    "properties": {
        "map": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "line": {"type": "integer"},
                    "first_word": {"type": "integer"},
                    "last_word": {"type": "integer"},
                },
                "required": ["line", "first_word", "last_word"],
            },
        }
    },
    "required": ["map"],
}

_ALIGN_SYSTEM = (
    "You align written song lyrics to an automatic transcript of the same recording.\n"
    "The transcript is noisy: proper nouns come out mangled (Weeknd->Weekend, YOLO->Your "
    "low) and words get dropped. The written lyrics are the truth about the WORDS; the "
    "transcript is the truth about the ORDER and the TIMING.\n"
    "For each written line, give the range of transcript word indices it is sung over. "
    "Ranges must not overlap and must increase with the line number — the singer performs "
    "the lines in order.\n"
    "A repeated chorus appears several times in the transcript: match the FIRST written "
    "occurrence to the FIRST sung one, the second to the second.\n"
    "Omit a line entirely if it is genuinely not sung in the recording."
)


def align_lyrics(lines: list[str], words: list[tuple], timeout: float = 300.0) -> dict:
    """Map written lyric lines onto a Whisper transcript → ``{line_index: (i0, i1)}``
    of WORD indices. Raises on any failure so the caller falls back to the string matcher.

    Only the MATCHING is the model's: the caller reads the times out of `words` at the
    returned indices, so a hallucinated number cannot become a timestamp. Same contract
    as `structure_sections`, where the labels are the model's and the times come from the
    downbeat grid.

    Why a model at all: string matching compares characters, so a chorus written twice
    with a one-word variation ("I heard that years ago" / "I did that years ago") can
    anchor the audio's FIRST chorus onto the text's SECOND one — and everything before
    it, verses included, is then stranded and dropped. A model reads "Weekend I like your
    outfit" as "Weeknd, I like your outfit" and places the verse where it is actually
    sung."""
    if not lines or not words:
        raise RuntimeError("nothing to align")
    lyr = "\n".join(f"{i}: {t}" for i, t in enumerate(lines))
    hyp = " ".join(f"[{j}]{w}" for j, (w, _t0, _t1) in enumerate(words))
    payload = {
        "model": OLLAMA_MODEL,
        "stream": False,
        "think": OLLAMA_THINK,
        "format": _ALIGN_SCHEMA,
        "messages": [
            {"role": "system", "content": _ALIGN_SYSTEM},
            {
                "role": "user",
                "content": f"WRITTEN LYRICS:\n{lyr}\n\nTRANSCRIPT:\n{hyp}\n\nReturn the map.",
            },
        ],
    }
    req = urllib.request.Request(
        OLLAMA_URL.rstrip("/") + "/api/chat",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    resp = json.load(urllib.request.urlopen(req, timeout=timeout))
    data = json.loads(resp["message"]["content"])

    # Validate hard. The model may hand back out-of-range indices, backwards ranges, or a
    # line placed before the previous one — none of which may reach a timestamp.
    n_w = len(words)
    out: dict[int, tuple[int, int]] = {}
    used_to = -1
    for m in sorted(data.get("map", []), key=lambda r: int(r.get("line", 0))):
        try:
            li, a, b = int(m["line"]), int(m["first_word"]), int(m["last_word"])
        except (KeyError, ValueError, TypeError):
            continue
        if not 0 <= li < len(lines):
            continue
        a, b = max(0, min(n_w - 1, a)), max(0, min(n_w - 1, b))
        if b < a or a <= used_to:  # backwards, or overlapping the previous line
            continue
        out[li] = (a, b)
        used_to = b
    if len(out) < max(1, len(lines) // 4):
        raise RuntimeError(f"LLM aligned only {len(out)}/{len(lines)} lines")
    return out
