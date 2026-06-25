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
            {"role": "user", "content": "Per-bar table:\n" + _table(bars)
             + "\n\nReturn the sections."},
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
