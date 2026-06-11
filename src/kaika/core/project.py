"""Project model — the mutable working document the editor drives.

A run is a one-shot immutable artifact; a Project is the thing you *edit*: an
audio track split into segments (seeded from the analysis, then reworkable),
each segment carrying its own prompt and partial config overrides, plus the
project timeline (authored directives) and pinned UI controls. A single
continuous simulation reads these per-frame, so parameters vary by segment
without breaking the flow. Persisted as ``project.json`` (no hidden state).

Per-frame precedence: recipe < segment override < timeline ``set`` window <
modulator (the engine applies modulators last).
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import List, Optional

from .recipe import (Recipe, config_tree, resolve_path, _deep_merge,
                     from_dict as recipe_from_dict)
from .score import Score
from .timeline import resolve_directives

# Parameters glide across segment boundaries over this window instead of
# jumping — a hard cut in vorticity/exposure reads as a glitch in the fluid.
SMOOTH_S = 0.6


def _lerp_cfg(a: dict, b: dict, w: float) -> dict:
    """Numeric-field interpolation between two config dicts (w: 0=a, 1=b).

    Ints stay ints (counts), non-numeric fields switch at the midpoint."""
    out = {}
    for k, va in a.items():
        vb = b.get(k, va)
        both_num = (isinstance(va, (int, float)) and isinstance(vb, (int, float))
                    and not isinstance(va, bool) and not isinstance(vb, bool))
        if both_num:
            mixed = va + (vb - va) * w
            out[k] = int(round(mixed)) if isinstance(va, int) and isinstance(vb, int) else mixed
        elif isinstance(va, dict) and isinstance(vb, dict):
            out[k] = _lerp_cfg(va, vb, w)
        else:
            out[k] = va if w < 0.5 else vb
    return out


@dataclass
class Segment:
    start: float
    end: float
    label: str
    prompt: str = ""                       # full effective prompt for this segment
    fluid: dict = field(default_factory=dict)   # partial config-tree overrides


@dataclass
class Project:
    audio: str                             # audio id / filename under the run
    recipe: Recipe
    segments: List[Segment]
    fps: int = 24
    seconds: Optional[float] = None        # optional render-length cap
    timeline: List[dict] = field(default_factory=list)  # authored directives
    ui_pins: List[str] = field(default_factory=list)    # pinned schema paths

    # ---- construction ------------------------------------------------------
    @staticmethod
    def from_score(score: Score, recipe: Recipe, audio: str) -> "Project":
        segs = [Segment(start=s.start, end=s.end, label=s.label,
                        prompt=recipe.prompt_for(s.label), fluid={})
                for s in score.sections]
        return Project(audio=audio, recipe=recipe, segments=segs,
                       fps=recipe.canvas.fps,
                       timeline=list(recipe.timeline or []))

    def full_timeline(self) -> List[dict]:
        """Recipe-shipped defaults + project directives (project wins by being
        later in the list — later spawns coexist, later sets override)."""
        return list(self.recipe.timeline or []) + list(self.timeline or [])

    # ---- per-frame resolution ---------------------------------------------
    def _seg_index_for_frame(self, i: int) -> int:
        t = i / self.fps
        for idx, s in enumerate(self.segments):
            if s.start <= t < s.end:
                return idx
        return len(self.segments) - 1 if self.segments else 0

    def frame_trees(self, n_frames: int, score: Optional[Score] = None
                    ) -> tuple:
        """One effective config tree per frame: recipe base + segment override
        (numerics smoothed across boundaries over ``SMOOTH_S``) + timeline
        ``set`` windows (eased by ``fade_s``). Returns (trees, warnings)."""
        base = config_tree(self.recipe)
        warnings: List[str] = []
        if not self.segments:
            seg_trees = [base]
            seg_for_frame = lambda i: 0    # noqa: E731
        else:
            seg_trees = [_deep_merge(base, s.fluid or {}) for s in self.segments]
            seg_for_frame = self._seg_index_for_frame

        half = SMOOTH_S / 2.0
        out: List[dict] = []
        for i in range(n_frames):
            t = i / self.fps
            idx = seg_for_frame(i)
            tree = seg_trees[idx]
            if self.segments:
                if idx + 1 < len(self.segments):
                    tb = self.segments[idx].end
                    if t > tb - half:
                        w = (t - (tb - half)) / SMOOTH_S
                        tree = _lerp_cfg(seg_trees[idx], seg_trees[idx + 1], w)
                if idx > 0:
                    tb = self.segments[idx].start
                    if t < tb + half:
                        w = (t - (tb - half)) / SMOOTH_S
                        tree = _lerp_cfg(seg_trees[idx - 1], seg_trees[idx], w)
            out.append(tree)

        # Timeline `set` windows, eased at the edges.
        if score is not None:
            directives, warnings = resolve_directives(self.full_timeline(), score)
            owned: set = set()        # frames whose tree is a private copy
            for d in directives:
                if d["action"] != "set":
                    continue
                t0, t1 = d["t0"], d["t1"]
                fade = max(0.0, float(d.get("fade_s", 0.5)))
                f0 = max(0, int(t0 * self.fps))
                f1 = min(n_frames, int(t1 * self.fps) + 1)
                for fi in range(f0, f1):
                    t = fi / self.fps
                    w = 1.0
                    if fade > 0:
                        w = max(0.0, min(1.0, (t - t0) / fade, (t1 - t) / fade))
                    if w <= 0:
                        continue
                    if fi not in owned:
                        out[fi] = json.loads(json.dumps(out[fi]))
                        owned.add(fi)
                    tree = out[fi]
                    for path, target_v in (d.get("set") or {}).items():
                        hit = resolve_path(tree, path)
                        if hit is None:
                            msg = f"timeline set: unknown path '{path}' — skipped"
                            if msg not in warnings:
                                warnings.append(msg)
                            continue
                        parent, key = hit
                        cur = parent[key]
                        if isinstance(cur, (int, float)) and not isinstance(cur, bool):
                            parent[key] = cur + (float(target_v) - cur) * w
                        else:
                            parent[key] = target_v
        return out, warnings

    def prompt_schedule(self, n_frames: int) -> List[str]:
        if not self.segments:
            return [self.recipe.prompt_for("default")] * n_frames
        return [self.segments[self._seg_index_for_frame(i)].prompt
                for i in range(n_frames)]

    # ---- (de)serialisation -------------------------------------------------
    def to_dict(self) -> dict:
        return {"audio": self.audio, "fps": self.fps, "seconds": self.seconds,
                "recipe": self.recipe.to_dict(),
                "segments": [asdict(s) for s in self.segments],
                "timeline": self.timeline,
                "ui_pins": self.ui_pins}

    def to_json(self, path: str | Path) -> None:
        Path(path).write_text(json.dumps(self.to_dict(), indent=2))

    @staticmethod
    def from_dict(d: dict) -> "Project":
        return Project(
            audio=d["audio"],
            recipe=recipe_from_dict(d.get("recipe") or {}),
            segments=[Segment(**s) for s in d.get("segments", [])],
            fps=int(d.get("fps", 24)),
            seconds=d.get("seconds"),
            timeline=list(d.get("timeline") or []),
            ui_pins=list(d.get("ui_pins") or []),
        )

    @staticmethod
    def from_json(path: str | Path) -> "Project":
        return Project.from_dict(json.loads(Path(path).read_text()))


# ---------------------------------------------------------------------------
# Revisions — undo history for project mutations (UI + chat share it).
# ---------------------------------------------------------------------------

def append_revision(run_dir: str | Path, project: Project,
                    note: str = "") -> int:
    """Append the current project state to the run's revision log; returns the
    new revision index."""
    rd = Path(run_dir)
    revdir = rd / "revisions"
    revdir.mkdir(parents=True, exist_ok=True)
    existing = sorted(revdir.glob("*.json"))
    idx = len(existing)
    payload = {"index": idx, "time": time.time(), "note": note,
               "project": project.to_dict()}
    (revdir / f"{idx:05d}.json").write_text(json.dumps(payload))
    return idx


def list_revisions(run_dir: str | Path) -> List[dict]:
    revdir = Path(run_dir) / "revisions"
    out = []
    for p in sorted(revdir.glob("*.json")) if revdir.is_dir() else []:
        try:
            d = json.loads(p.read_text())
            out.append({"index": d["index"], "time": d["time"],
                        "note": d.get("note", "")})
        except (json.JSONDecodeError, KeyError):
            pass
    return out


def load_revision(run_dir: str | Path, index: int) -> Optional[Project]:
    p = Path(run_dir) / "revisions" / f"{index:05d}.json"
    if not p.exists():
        return None
    return Project.from_dict(json.loads(p.read_text())["project"])
