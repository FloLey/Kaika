"""Score data model — the machine-readable "partition" produced by E1.

A Score holds everything the downstream stages need to know about a track,
with one ``FrameData`` row per *video* frame so no interpolation is required.
It is a plain dataclass tree that serialises to/from ``score.json``.

Version 2 adds per-frame chroma (pitch content), spectral flux, beat/bar phase
and the harmonic/percussive ratio. v1 scores load fine: new fields default to
neutral values.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import List, Dict

SCORE_VERSION = 2


@dataclass
class AudioInfo:
    sr: int
    duration_s: float
    fps: int
    hop_length: int


@dataclass
class Event:
    """A point event on the timeline (beat or onset)."""
    t: float          # time in seconds
    mag: float        # magnitude / strength, normalised 0..1


@dataclass
class FrameData:
    """One row per video frame, frame-aligned with the simulation."""
    rms: float                 # 0..1 normalised loudness
    centroid_hz: float         # spectral centroid in Hz
    bands: List[float]         # [low, mid, high], per-frame energy split summing ~1
    # ---- v2 signals (defaults keep v1 scores loadable) ----------------------
    chroma: List[float] = field(default_factory=list)   # 12 pitch classes, 0..1
    chroma_argmax: int = 0     # dominant pitch class 0..11
    flux: float = 0.0          # spectral flux (onset envelope), 0..1
    beat_phase: float = 0.0    # 0..1 phase between consecutive beats
    bar_phase: float = 0.0     # 0..1 phase within a 4-beat bar (4/4 assumed)
    harmonic_ratio: float = 0.5  # harmonic / (harmonic + percussive) energy


@dataclass
class Section:
    start: float
    end: float
    label: str
    energy: float              # 0..1 mean energy of the section


@dataclass
class Score:
    audio: AudioInfo
    tempo_bpm: float
    beats: List[Event] = field(default_factory=list)
    onsets: Dict[str, List[Event]] = field(default_factory=dict)  # keys: low/mid/high
    frames: List[FrameData] = field(default_factory=list)
    sections: List[Section] = field(default_factory=list)
    version: int = SCORE_VERSION

    # ---- (de)serialisation -------------------------------------------------
    def to_dict(self) -> dict:
        return asdict(self)

    def to_json(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.to_dict(), indent=2))

    @property
    def n_frames(self) -> int:
        return len(self.frames)

    @staticmethod
    def from_dict(d: dict) -> "Score":
        return Score(
            audio=AudioInfo(**d["audio"]),
            tempo_bpm=d["tempo_bpm"],
            beats=[Event(**e) for e in d.get("beats", [])],
            onsets={k: [Event(**e) for e in v] for k, v in d.get("onsets", {}).items()},
            frames=[FrameData(**f) for f in d.get("frames", [])],
            sections=[Section(**s) for s in d.get("sections", [])],
            version=int(d.get("version", 1)),
        )

    @staticmethod
    def from_json(path: str | Path) -> "Score":
        return Score.from_dict(json.loads(Path(path).read_text()))
