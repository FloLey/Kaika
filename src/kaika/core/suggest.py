"""Creative director: an LLM proposes recipe settings from the analysis and
lyrics, globally and per segment, which the user previews and accepts or
rejects one by one.

The model returns a single free-form ``plan`` object (one tool, one turn) —
a global proposal plus one per segment. Each proposal carries a human-readable
rationale and concrete edits expressed in the same vocabulary the chat copilot
uses: ``recipe_values`` dot-paths, ``Segment.fluid`` partial overrides,
timeline directives, and the diffusion prompt. Applying/previewing reuses the
existing merge + render plumbing; this module only generates and validates.
"""
from __future__ import annotations

import copy
import json
from dataclasses import asdict
from typing import List, Optional, Tuple

from . import recipe as R
from .project import Project
from .score import Score
from .schema import chat_reference
from . import chat as C


# ---------------------------------------------------------------------------
# Analysis context per segment
# ---------------------------------------------------------------------------

def segment_briefs(score: Score, lyric_lines: Optional[List[dict]],
                   segments: List) -> dict:
    """A compact, LLM-friendly description of the track and each segment:
    energy, onset density, vocal presence, and the lyric lines sung in it."""
    fps = score.audio.fps
    n = score.n_frames

    def onset_count(band: str, t0: float, t1: float) -> int:
        return sum(1 for e in score.onsets.get(band, []) if t0 <= e.t < t1)

    def voiced_frac(t0: float, t1: float) -> float:
        f0, f1 = int(t0 * fps), min(n, int(t1 * fps))
        if f1 <= f0:
            return 0.0
        vals = [getattr(score.frames[i], "voiced", 0.0)
                for i in range(f0, f1)]
        return round(sum(vals) / len(vals), 2) if vals else 0.0

    def lyric_text(t0: float, t1: float) -> List[str]:
        out = []
        for ln in (lyric_lines or []):
            mid = (float(ln["t0"]) + float(ln["t1"])) / 2
            if t0 <= mid < t1:
                out.append(str(ln["text"]))
        return out

    seg_briefs = []
    for i, s in enumerate(segments):
        dur = max(0.01, s.end - s.start)
        seg_briefs.append({
            "index": i, "label": s.label,
            "start": round(s.start, 1), "end": round(s.end, 1),
            "duration_s": round(dur, 1),
            "onsets_per_s": {b: round(onset_count(b, s.start, s.end) / dur, 2)
                             for b in ("low", "mid", "high")},
            "vocal_presence": voiced_frac(s.start, s.end),
            "lyrics": lyric_text(s.start, s.end),
        })
    return {
        "duration_s": score.audio.duration_s,
        "tempo_bpm": score.tempo_bpm,
        "has_lyrics": bool(lyric_lines),
        "structure": [s["label"] for s in seg_briefs],
        "segments": seg_briefs,
    }


# ---------------------------------------------------------------------------
# Prompt + generation
# ---------------------------------------------------------------------------

_SUGGEST_RULES = """You are Kaika's creative director. From a track's audio analysis and lyrics you design how a music-driven fluid-simulation video should look — a GLOBAL art direction for the whole song plus one proposal PER SEGMENT (verse, chorus, drop...). The user previews each proposal and accepts or rejects it, so make each one a distinct, motivated idea.

You output ONE JSON object via the propose_plan tool, in the `plan` argument:
{
  "global": {
    "title": "short name of the look",
    "reasoning": "one or two sentences: the overall mood and why it fits the song",
    "recipe_values": { "<dot.path>": <value>, ... }   // song-wide defaults
  },
  "segments": [
    {
      "segment_index": <int>,
      "label": "<segment label>",
      "reasoning": "one sentence tying the choice to this segment's energy/onsets/lyrics",
      "fluid": { "field": {...}, "render": {...}, "emitters": { "<id>": {...} } },  // per-segment overrides, optional
      "prompt": "<diffusion style prompt for this segment>",                         // optional
      "timeline": [ <directive>, ... ]                                              // optional accents, see below
    }, ...
  ]
}

Rules:
- Use ONLY the dot-paths and value ranges in the schema reference below. Never invent fields.
- `global.recipe_values` is the place for song-wide choices, including `palettes.<name>` (a list of #RRGGBB) and base `render.*` / `field.*`. Palettes can ONLY be set globally.
- `segments[].fluid` overrides field/render/emitters FOR THAT SEGMENT only (it deep-merges over the recipe). Good levers: render.background_color (band_mix/chroma_palette/centroid_ramp/palette), render.bloom.amount, render.exposure, field.vorticity, field.ambient.strength, field.detail, emitters.<id>.color / .body.
- `segments[].timeline` are accents scoped to the segment: a `set` window {action:"set", between:[start,end], set:{"dot.path":v}, fade_s}, a one-off `spawn`, or fluid `text` {action:"text", at, text, center, height, color, hold_s}. Use them for drops/peaks.
- Match the music: high energy / dense onsets -> brighter colors, more bloom, higher vorticity; calm/verse -> softer; a repeated chorus -> a recognizable recurring look; lyrics can inspire colors or fluid text words.
- Keep every proposal self-contained and reversible. Give every segment a proposal."""


def _propose_tool() -> dict:
    return {"name": "propose_plan",
            "description": "Return the global + per-segment proposal plan as "
                           "one JSON object in `plan`.",
            "input_schema": {"type": "object",
                             "properties": {"plan": {"type": "object"}},
                             "required": ["plan"]}}


def _system_prompt(briefs: dict, recipe: R.Recipe) -> str:
    state = {"current_palettes": recipe.palettes,
             "current_render": recipe.to_dict()["render"],
             "emitter_ids": [e.id for e in recipe.emitters],
             "analysis": briefs}
    return (_SUGGEST_RULES
            + "\n\n# Recipe schema reference (every editable path)\n"
            + chat_reference()
            + "\n\n# Track analysis and current look\n"
            + json.dumps(state, separators=(",", ":")))


def generate_plan(backend, score: Score, recipe: R.Recipe,
                  segments: List, lyric_lines: Optional[List[dict]],
                  extra: str = "") -> dict:
    """Call the LLM once and return the parsed (unvalidated) plan dict."""
    briefs = segment_briefs(score, lyric_lines, segments)
    system = _system_prompt(briefs, recipe)
    user = ("Design the global look and a proposal for each of the "
            f"{len(segments)} segments." + (f" {extra}" if extra else ""))
    out = backend.complete(system, [{"role": "user", "text": user}],
                           [_propose_tool()])
    for tc in (out.get("tool_calls") or []):
        if tc["name"] == "propose_plan":
            plan = tc["input"].get("plan")
            if isinstance(plan, str):           # Gemini free-form -> string
                plan = json.loads(plan)
            return plan or {}
    # Fallback: a model that answered in text with a JSON block.
    text = out.get("text", "")
    start, end = text.find("{"), text.rfind("}")
    if 0 <= start < end:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            pass
    return {"global": None, "segments": []}


# ---------------------------------------------------------------------------
# Applying a proposal (shared by preview-in-memory and accept-on-disk)
# ---------------------------------------------------------------------------

def _step(node, key):
    """One hop into a dict (by key) or a list (by int index, or by an
    emitter's ``id`` so the model can address ``emitters.<id>...``)."""
    if isinstance(node, list):
        try:
            return node[int(key)]
        except (ValueError, TypeError):
            for item in node:
                if isinstance(item, dict) and item.get("id") == key:
                    return item
            raise ValueError(f"no list item '{key}'")
    if isinstance(node, dict):
        if key not in node:
            raise ValueError(f"unknown key '{key}'")
        return node[key]
    raise ValueError(f"'{key}' does not address a container")


def _set_dot_path(d: dict, path: str, value) -> None:
    parts = [p for p in str(path).split(".") if p]
    if not parts:
        raise ValueError("empty path")
    node = d
    for p in parts[:-1]:
        node = _step(node, p)
    last = parts[-1]
    if isinstance(node, list):
        try:
            node[int(last)] = value
        except (ValueError, TypeError):
            raise ValueError(f"path '{path}': cannot index a list by '{last}'")
    elif isinstance(node, dict):
        node[last] = value          # new keys allowed (palettes.<name>, ...)
    else:
        raise ValueError(f"path '{path}' does not address a container")


def apply_global(recipe: R.Recipe, recipe_values: dict) -> R.Recipe:
    """Return a new recipe with the global proposal's dot-path values set.
    A malformed path raises ValueError (caught upstream) rather than
    corrupting the recipe."""
    d = recipe.to_dict()
    for path, val in (recipe_values or {}).items():
        _set_dot_path(d, path, val)
    return R.from_dict(d)


def apply_to_project(project: Project, proposal: dict) -> Project:
    """Merge a proposal (global recipe_values and/or a per-segment fluid +
    prompt + timeline) into a COPY of the project. Raises ValueError on an
    invalid result so callers can reject it."""
    proj = copy.deepcopy(project)
    gv = (proposal.get("global") or {}).get("recipe_values") \
        if "global" in proposal else proposal.get("recipe_values")
    if gv:
        proj.recipe = apply_global(proj.recipe, gv)
    idx = proposal.get("segment_index")
    if idx is not None and 0 <= idx < len(proj.segments):
        seg = proj.segments[idx]
        if proposal.get("fluid"):
            seg.fluid = R._deep_merge(seg.fluid or {}, proposal["fluid"])
            _validate_fluid(proj.recipe, seg.fluid)
        if proposal.get("prompt"):
            seg.prompt = str(proposal["prompt"])
        for d in (proposal.get("timeline") or []):
            errs = R.validate_timeline([d])
            if errs:
                raise ValueError("; ".join(errs))
            proj.timeline = list(proj.timeline) + [d]
    errs = R.validate(proj.recipe)
    if errs:
        raise ValueError("; ".join(errs))
    return proj


def _validate_fluid(recipe: R.Recipe, fluid: dict) -> None:
    """A segment.fluid override only touches field/render/emitters; validate
    it by merging it into a probe recipe (catches e.g. a background_color
    pointing at a non-existent palette) so a bad override is rejected before
    preview/apply, not silently dropped at render time."""
    d = recipe.to_dict()
    if fluid.get("field"):
        d["field"] = R._deep_merge(d["field"], fluid["field"])
    if fluid.get("render"):
        d["render"] = R._deep_merge(d["render"], fluid["render"])
    for eid, patch in (fluid.get("emitters") or {}).items():
        for e in d["emitters"]:
            if e.get("id") == eid:
                e.update(R._deep_merge(e, patch))
                break
    errs = R.validate(R.from_dict(d))   # from_dict raises on structural issues
    if errs:
        raise ValueError("; ".join(errs))


def validate_plan(project: Project, plan: dict) -> Tuple[dict, List[str]]:
    """Annotate each proposal with whether it validates; collect warnings for
    the ones that don't (so the UI can grey them out)."""
    warnings: List[str] = []
    base = project       # segments validate ON TOP of the global look (the
                         # proposals are designed as a set: a segment may use
                         # a palette the global proposal introduces).
    g = plan.get("global")
    if g and g.get("recipe_values"):
        try:
            base = apply_to_project(project, {"global": g})
        except Exception as e:                              # noqa: BLE001
            warnings.append(f"global: {e}")
            g["invalid"] = str(e)
    for sp in (plan.get("segments") or []):
        try:
            apply_to_project(base, sp)
        except Exception as e:                              # noqa: BLE001
            warnings.append(f"segment {sp.get('segment_index')}: {e}")
            sp["invalid"] = str(e)
    return plan, warnings
