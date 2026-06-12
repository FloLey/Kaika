"""Chat copilot: an LLM that edits the project only through typed tools.

Provider-swappable by design: one internal interface —
``complete(system, messages, tools) -> {"text", "tool_calls"}`` — with a
backend per provider. v2 ships Anthropic (Claude) and Google (Gemini), both of
which support JSON-schema tool calling natively; a deterministic ``fake``
backend exists for tests. Everything below the interface (tools, validation,
revisions) is provider-neutral.

Every mutation goes through the same validated functions the UI uses; invalid
input returns the validation error verbatim so the model can self-correct.
Each mutating turn appends one revision (undo history).
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional

from . import recipe as R
from .project import Project, Segment, append_revision
from .score import Score

MAX_TOOL_TURNS = 16

DEFAULT_MODELS = {
    "anthropic": "claude-sonnet-4-6",
    "gemini": "gemini-2.5-flash",
}


# ---------------------------------------------------------------------------
# JSON Patch (RFC 6902 subset: add / replace / remove)
# ---------------------------------------------------------------------------

def _pointer_parts(pointer: str) -> List[str]:
    if pointer in ("", "/"):
        return []
    return [p.replace("~1", "/").replace("~0", "~")
            for p in pointer.lstrip("/").split("/")]


def apply_json_patch(doc, ops: List[dict]):
    """Apply add/replace/remove ops; raises ValueError on bad paths."""
    import copy
    doc = copy.deepcopy(doc)
    for i, op in enumerate(ops or []):
        kind = op.get("op")
        parts = _pointer_parts(op.get("path", ""))
        if not parts:
            raise ValueError(f"ops[{i}]: empty path")
        node = doc
        for p in parts[:-1]:
            if isinstance(node, list):
                node = node[int(p)]
            elif isinstance(node, dict):
                if p not in node:
                    if kind == "add":
                        node[p] = {}
                    else:
                        raise ValueError(f"ops[{i}]: path '{op['path']}' does "
                                         "not exist")
                node = node[p]
            else:
                raise ValueError(f"ops[{i}]: path '{op['path']}' does not exist")
        last = parts[-1]
        if kind in ("add", "replace"):
            if isinstance(node, list):
                if last == "-":
                    node.append(op.get("value"))
                else:
                    idx = int(last)
                    if kind == "add":
                        node.insert(idx, op.get("value"))
                    else:
                        node[idx] = op.get("value")
            else:
                if kind == "replace" and last not in node:
                    raise ValueError(f"ops[{i}]: '{op['path']}' does not exist "
                                     "(use add)")
                node[last] = op.get("value")
        elif kind == "remove":
            if isinstance(node, list):
                del node[int(last)]
            elif last in node:
                del node[last]
            else:
                raise ValueError(f"ops[{i}]: '{op['path']}' does not exist")
        else:
            raise ValueError(f"ops[{i}]: unsupported op '{kind}' "
                             "(add | replace | remove)")
    return doc


# ---------------------------------------------------------------------------
# Tool layer — operates on a run dir's project.json
# ---------------------------------------------------------------------------

@dataclass
class ToolContext:
    run_dir: Path
    score: Score
    submit_preview: Optional[Callable[[float, float], str]] = None
    submit_render: Optional[Callable[[], str]] = None
    changes: List[str] = field(default_factory=list)
    preview_job: Optional[str] = None
    render_job: Optional[str] = None

    def project(self) -> Project:
        return Project.from_json(self.run_dir / "project.json")

    def save(self, project: Project, note: str) -> None:
        append_revision(self.run_dir, self.project(), note=note)
        project.to_json(self.run_dir / "project.json")
        self.changes.append(note)


def _score_summary(score: Score, t0: Optional[float], t1: Optional[float],
                   include_onset_times: bool = False) -> dict:
    lo = t0 if t0 is not None else 0.0
    hi = t1 if t1 is not None else score.audio.duration_s
    out = {
        "duration_s": score.audio.duration_s,
        "tempo_bpm": score.tempo_bpm,
        "fps": score.audio.fps,
        "n_beats": len(score.beats),
        "window": [lo, hi],
        "sections": [{"start": s.start, "end": s.end, "label": s.label,
                      "energy": s.energy} for s in score.sections
                     if s.end > lo and s.start < hi],
        "onsets_in_window": {k: sum(1 for e in v if lo <= e.t <= hi)
                             for k, v in score.onsets.items()},
        "beats_in_window": [round(b.t, 3) for b in score.beats
                            if lo <= b.t <= hi][:64],
    }
    if include_onset_times:
        out["onset_times_in_window"] = {
            k: [[round(e.t, 3), round(e.mag, 2)]
                for e in v if lo <= e.t <= hi][:120]
            for k, v in score.onsets.items()}
    return out


def _set_dot_path(d: dict, path: str, value) -> None:
    """Set a value at a dot-path (dict keys + integer list indices, e.g.
    'palettes.main.0'). Raises on paths that do not exist — structural
    changes belong to patch_recipe."""
    parts = [p for p in str(path).split(".") if p]
    if not parts:
        raise ValueError("empty path")
    node = d
    for p in parts[:-1]:
        if isinstance(node, list):
            node = node[int(p)]
        elif isinstance(node, dict) and p in node:
            node = node[p]
        else:
            raise ValueError(f"path '{path}': '{p}' does not exist")
    last = parts[-1]
    if isinstance(node, list):
        node[int(last)] = value
    elif isinstance(node, dict):
        node[last] = value      # new dict keys OK (prompts.<label>, ...)
    else:
        raise ValueError(f"path '{path}' does not address a container")


def _set_recipe(ctx: ToolContext, new_recipe_dict: dict, note: str) -> str:
    """Validate + persist a new recipe; returns 'ok' or the validation error."""
    proj = ctx.project()
    try:
        proj.recipe = R.from_dict(new_recipe_dict)
    except ValueError as e:
        return f"VALIDATION ERROR: {e}"
    ctx.save(proj, note)
    return "ok"


def run_tool(ctx: ToolContext, name: str, args: dict) -> str:
    """Execute one tool call; always returns a string for the model."""
    args = args or {}
    try:
        if name == "get_project":
            return json.dumps(ctx.project().to_dict())
        if name == "get_score_summary":
            windowed = args.get("t0") is not None or args.get("t1") is not None
            return json.dumps(_score_summary(ctx.score, args.get("t0"),
                                             args.get("t1"),
                                             include_onset_times=windowed))
        if name == "patch_recipe":
            proj = ctx.project()
            try:
                patched = apply_json_patch(proj.recipe.to_dict(),
                                           args.get("ops", []))
            except (ValueError, IndexError, KeyError) as e:
                return f"PATCH ERROR: {e}"
            return _set_recipe(ctx, patched,
                               f"recipe patch ({len(args.get('ops', []))} ops)")
        if name == "add_emitter":
            proj = ctx.project()
            d = proj.recipe.to_dict()
            spec = args.get("spec") or {}
            d["emitters"].append(spec)
            res = _set_recipe(ctx, d, f"+ emitter '{spec.get('id', '?')}'")
            return res
        if name == "update_emitter":
            proj = ctx.project()
            d = proj.recipe.to_dict()
            eid = args.get("id", "")
            hit = next((e for e in d["emitters"] if e["id"] == eid), None)
            if hit is None:
                return (f"ERROR: no emitter '{eid}' "
                        f"(have: {[e['id'] for e in d['emitters']]})")
            _deep_update(hit, args.get("patch") or {})
            return _set_recipe(ctx, d, f"~ emitter '{eid}'")
        if name == "remove_emitter":
            proj = ctx.project()
            d = proj.recipe.to_dict()
            eid = args.get("id", "")
            before = len(d["emitters"])
            d["emitters"] = [e for e in d["emitters"] if e["id"] != eid]
            if len(d["emitters"]) == before:
                return f"ERROR: no emitter '{eid}'"
            return _set_recipe(ctx, d, f"- emitter '{eid}'")
        if name == "set_recipe_values":
            proj = ctx.project()
            d = proj.recipe.to_dict()
            values = args.get("values") or {}
            if not isinstance(values, dict) or not values:
                return ("ERROR: values must be a non-empty object of "
                        "{\"dot.path\": value}")
            try:
                for path, val in values.items():
                    _set_dot_path(d, path, val)
            except (ValueError, IndexError, KeyError, TypeError) as e:
                return f"PATH ERROR: {e}"
            shown = ", ".join(list(values)[:4])
            if len(values) > 4:
                shown += f" (+{len(values) - 4})"
            return _set_recipe(ctx, d, f"set {shown}")
        if name == "update_modulator":
            proj = ctx.project()
            d = proj.recipe.to_dict()
            idx = int(args.get("index", -1))
            if not (0 <= idx < len(d["modulators"])):
                return f"ERROR: modulator index {idx} out of range"
            d["modulators"][idx] = {**d["modulators"][idx],
                                    **(args.get("patch") or {})}
            return _set_recipe(ctx, d, f"~ modulator [{idx}]")
        if name == "set_palette":
            proj = ctx.project()
            d = proj.recipe.to_dict()
            pname = str(args.get("name", "")).strip()
            colors = args.get("colors") or []
            if not pname:
                return "ERROR: palette name required"
            bad = [c for c in colors
                   if not (isinstance(c, str)
                           and re.fullmatch(r"#[0-9a-fA-F]{6}", c))]
            if not colors or bad:
                return ("ERROR: colors must be a non-empty list of '#RRGGBB' "
                        f"hex strings (bad: {bad[:3]})")
            d.setdefault("palettes", {})[pname] = colors
            return _set_recipe(ctx, d,
                               f"palette '{pname}' ({len(colors)} colors)")
        if name == "add_segment":
            proj = ctx.project()
            spec = args.get("spec") or {}
            try:
                start, end = float(spec["start"]), float(spec["end"])
            except (KeyError, TypeError, ValueError):
                return "ERROR: spec needs numeric start and end (seconds)"
            if end <= start:
                return "ERROR: end must be > start"
            seg = Segment(start=start, end=end,
                          label=str(spec.get("label", "segment")),
                          prompt=str(spec.get("prompt", "")),
                          fluid=spec.get("fluid") or {})
            proj.segments.append(seg)
            proj.segments.sort(key=lambda s: s.start)
            ctx.save(proj, f"+ segment '{seg.label}' {start:.1f}-{end:.1f}s")
            return "ok"
        if name == "remove_segment":
            proj = ctx.project()
            idx = int(args.get("index", -1))
            if not (0 <= idx < len(proj.segments)):
                return f"ERROR: segment index {idx} out of range"
            seg = proj.segments.pop(idx)
            ctx.save(proj, f"- segment [{idx}] '{seg.label}'")
            return "ok"
        if name == "start_render":
            if ctx.submit_render is None:
                return "ERROR: rendering is not available in this context"
            ctx.render_job = ctx.submit_render()
            return f"ok: full render job {ctx.render_job} started"
        if name == "add_modulator":
            proj = ctx.project()
            d = proj.recipe.to_dict()
            d["modulators"].append(args.get("spec") or {})
            return _set_recipe(ctx, d, "+ modulator "
                               f"{(args.get('spec') or {}).get('source', '?')}"
                               f" -> {(args.get('spec') or {}).get('target', '?')}")
        if name == "remove_modulator":
            proj = ctx.project()
            d = proj.recipe.to_dict()
            idx = int(args.get("index", -1))
            if not (0 <= idx < len(d["modulators"])):
                return f"ERROR: modulator index {idx} out of range"
            d["modulators"].pop(idx)
            return _set_recipe(ctx, d, f"- modulator [{idx}]")
        if name == "add_timeline_directive":
            proj = ctx.project()
            spec = args.get("spec") or {}
            errs = R.validate_timeline([spec])
            if errs:
                return "VALIDATION ERROR: " + "; ".join(errs)
            proj.timeline.append(spec)
            ctx.save(proj, f"+ timeline {spec.get('action', 'spawn')} @"
                           f"{spec.get('at', spec.get('between', '?'))}")
            return "ok"
        if name == "update_timeline_directive":
            proj = ctx.project()
            idx = int(args.get("index", -1))
            if not (0 <= idx < len(proj.timeline)):
                return f"ERROR: timeline index {idx} out of range"
            merged = {**proj.timeline[idx], **(args.get("patch") or {})}
            errs = R.validate_timeline([merged])
            if errs:
                return "VALIDATION ERROR: " + "; ".join(errs)
            proj.timeline[idx] = merged
            ctx.save(proj, f"~ timeline [{idx}]")
            return "ok"
        if name == "remove_timeline_directive":
            proj = ctx.project()
            idx = int(args.get("index", -1))
            if not (0 <= idx < len(proj.timeline)):
                return f"ERROR: timeline index {idx} out of range"
            proj.timeline.pop(idx)
            ctx.save(proj, f"- timeline [{idx}]")
            return "ok"
        if name == "update_segment":
            proj = ctx.project()
            idx = int(args.get("index", -1))
            if not (0 <= idx < len(proj.segments)):
                return (f"ERROR: segment index {idx} out of range "
                        f"(0..{len(proj.segments) - 1})")
            patch = args.get("patch") or {}
            seg = proj.segments[idx]
            for k in ("label", "prompt", "start", "end"):
                if k in patch:
                    setattr(seg, k, patch[k])
            if "fluid" in patch:
                seg.fluid = R._deep_merge(seg.fluid or {}, patch["fluid"] or {})
            ctx.save(proj, f"~ segment [{idx}] '{seg.label}'")
            return "ok"
        if name == "set_canvas":
            proj = ctx.project()
            d = proj.recipe.to_dict()
            d["canvas"] = {**d["canvas"], **(args.get("spec") or {})}
            return _set_recipe(ctx, d, f"canvas -> {d['canvas']['width']}x"
                                       f"{d['canvas']['height']}")
        if name == "preview":
            if ctx.submit_preview is None:
                return "ERROR: preview is not available in this context"
            t0 = float(args.get("t0", 0.0))
            t1 = float(args.get("t1", t0 + 6.0))
            ctx.preview_job = ctx.submit_preview(t0, t1)
            return f"ok: preview job {ctx.preview_job} queued for {t0:.1f}-{t1:.1f}s"
        return f"ERROR: unknown tool '{name}'"
    except Exception as e:                                   # noqa: BLE001
        return f"ERROR: {type(e).__name__}: {e}"


def _deep_update(dst: dict, patch: dict) -> None:
    for k, v in (patch or {}).items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _deep_update(dst[k], v)
        else:
            dst[k] = v


def tool_definitions() -> List[dict]:
    """Neutral tool schemas (converted per provider)."""
    obj = lambda props, req=None: {"type": "object", "properties": props,   # noqa: E731
                                   **({"required": req} if req else {})}
    return [
        {"name": "get_project", "description":
            "Current project: recipe, segments, timeline, pins.",
         "input_schema": obj({})},
        {"name": "get_score_summary", "description":
            "Track structure: sections, beats, onset counts — optionally "
            "limited to a [t0, t1] window (seconds). Pass t0/t1 to also get "
            "the exact onset times+magnitudes per band in that window, for "
            "precise timeline work.",
         "input_schema": obj({"t0": {"type": "number"},
                              "t1": {"type": "number"}})},
        {"name": "set_recipe_values", "description":
            "Set one or more recipe values by dot-path (paths exactly as in "
            "the schema reference, list indices as numbers — e.g. "
            "{\"field.vorticity\": 20, \"palettes.main.0\": \"#0040FF\", "
            "\"prompts.drop\": \"...\", \"seed\": 7}). Preferred tool for "
            "scalar/string edits anywhere in the recipe.",
         "input_schema": obj({"values": {"type": "object"}}, ["values"])},
        {"name": "patch_recipe", "description":
            "Apply JSON Patch (RFC 6902 add/replace/remove) ops to the recipe "
            "document. Schema-validated; returns errors verbatim. Use for "
            "STRUCTURAL edits (insert/remove list elements, delete keys); for "
            "plain value edits prefer set_recipe_values.",
         "input_schema": obj({"ops": {"type": "array", "items": {
             "type": "object", "properties": {
                 "op": {"type": "string", "enum": ["add", "replace", "remove"]},
                 "path": {"type": "string"},
                 "value": {}}, "required": ["op", "path"]}}}, ["ops"])},
        {"name": "add_emitter", "description":
            "Add an emitter. spec: {id, trigger:{type,band,...}, placement:"
            "{type,...}, direction:{type,...}, color:{type,...}, body:{...}, "
            "count}.",
         "input_schema": obj({"spec": {"type": "object"}}, ["spec"])},
        {"name": "update_emitter", "description":
            "Deep-merge a patch into the emitter with this id.",
         "input_schema": obj({"id": {"type": "string"},
                              "patch": {"type": "object"}}, ["id", "patch"])},
        {"name": "remove_emitter", "description": "Remove an emitter by id.",
         "input_schema": obj({"id": {"type": "string"}}, ["id"])},
        {"name": "add_modulator", "description":
            "Add a modulator. spec: {source, target, range:[lo,hi], mode:"
            "absolute|add|scale, curve, smooth_s}.",
         "input_schema": obj({"spec": {"type": "object"}}, ["spec"])},
        {"name": "update_modulator", "description":
            "Shallow-merge a patch into the modulator at this index (e.g. "
            "{range: [5, 20]} or {smooth_s: 0.5}).",
         "input_schema": obj({"index": {"type": "integer"},
                              "patch": {"type": "object"}},
                             ["index", "patch"])},
        {"name": "remove_modulator", "description":
            "Remove the modulator at this index.",
         "input_schema": obj({"index": {"type": "integer"}}, ["index"])},
        {"name": "set_palette", "description":
            "Create or replace a named palette with a list of '#RRGGBB' hex "
            "colors.",
         "input_schema": obj({"name": {"type": "string"},
                              "colors": {"type": "array",
                                         "items": {"type": "string"}}},
                             ["name", "colors"])},
        {"name": "add_timeline_directive", "description":
            "Add a timeline directive. spec: {at: seconds | 'section:drop+4' "
            "| 'beat:32' | 'bar:8', action: spawn|set|mute|unmute, emitter?, "
            "count?, mag?, placement?, color?, body?, between?:[t0,t1], "
            "set?:{path:value}, fade_s?}.",
         "input_schema": obj({"spec": {"type": "object"}}, ["spec"])},
        {"name": "update_timeline_directive", "description":
            "Merge a patch into the project timeline directive at this index.",
         "input_schema": obj({"index": {"type": "integer"},
                              "patch": {"type": "object"}},
                             ["index", "patch"])},
        {"name": "remove_timeline_directive", "description":
            "Remove the project timeline directive at this index.",
         "input_schema": obj({"index": {"type": "integer"}}, ["index"])},
        {"name": "update_segment", "description":
            "Patch a segment: {label?, prompt?, start?, end?, fluid?: partial "
            "config overrides like {field:{vorticity:30}}}.",
         "input_schema": obj({"index": {"type": "integer"},
                              "patch": {"type": "object"}},
                             ["index", "patch"])},
        {"name": "add_segment", "description":
            "Add a segment. spec: {start, end (seconds), label?, prompt?, "
            "fluid?: partial config overrides}. Segments stay sorted by "
            "start.",
         "input_schema": obj({"spec": {"type": "object"}}, ["spec"])},
        {"name": "remove_segment", "description":
            "Remove the segment at this index.",
         "input_schema": obj({"index": {"type": "integer"}}, ["index"])},
        {"name": "start_render", "description":
            "Start the FULL final render of the project (slow, minutes). Only "
            "when the user explicitly asks to render; for iteration use "
            "preview instead.",
         "input_schema": obj({})},
        {"name": "set_canvas", "description":
            "Set output dimensions/fps. spec: {width?, height?, fps?, "
            "sim_resolution?}.",
         "input_schema": obj({"spec": {"type": "object"}}, ["spec"])},
        {"name": "preview", "description":
            "Queue a draft window preview of [t0, t1] seconds so the user sees "
            "the change. Call this after visible edits.",
         "input_schema": obj({"t0": {"type": "number"},
                              "t1": {"type": "number"}}, ["t0", "t1"])},
    ]


_PROMPT_RULES = """You are Kaika's studio copilot. You edit a music-driven fluid simulation project ONLY through the provided tools — never invent fields; every editable path is listed in the schema reference below. Coordinates are normalized 0..1 per axis.

How to work:
- Scalar/string edits anywhere: set_recipe_values with the dot-paths from the reference. Structural list edits: patch_recipe. Emitters/modulators/palettes/segments/timeline have dedicated tools.
- If a tool returns a VALIDATION ERROR or PATH ERROR, read it, fix your input and retry.
- Time precision: get_score_summary(t0, t1) returns the exact onset times per band in that window — use it before anchoring timeline work.
- After visible changes call preview(t0, t1) around the affected moment so the user sees the result. Only start_render when the user explicitly asks for the final render.
- Ask (in text) rather than guess when a request is genuinely ambiguous.

Common intents:
- Confine an effect to a moment: a timeline `set` window {between, set, fade_s}, or a mute/unmute pair around a section for an emitter.
- A run of hits tracing a shape (spiral, ring, sweep): give the emitter a parametric placement (line/circle/spiral) with placement.sequence = N — successive trigger hits advance along the shape (hit k at position (k mod N)/N). direction radial_out makes matter flow outward from the shape's center.
- React to the music continuously: a modulator (signal -> numeric path); for hit-like reactions use emitter triggers instead.
- One-off accent at an instant: timeline spawn with overrides; recurring behavior: an emitter."""


def system_prompt(ctx: ToolContext) -> str:
    proj = ctx.project()
    timeline = proj.timeline[:40]
    state = {
        "recipe": proj.recipe.to_dict(),
        "timeline": timeline,
        "segments": [{"index": i, "label": s.label, "start": s.start,
                      "end": s.end, "prompt": s.prompt}
                     for i, s in enumerate(proj.segments)],
        "score": _score_summary(ctx.score, None, None),
    }
    if len(proj.timeline) > 40:
        state["timeline_truncated"] = (f"{len(proj.timeline) - 40} more — "
                                       "use get_project")
    from .schema import chat_reference
    return (_PROMPT_RULES
            + "\n\n# Recipe schema reference (every editable path)\n"
            + chat_reference()
            + "\n\n# Current project state\n"
            + json.dumps(state, separators=(",", ":")))


# ---------------------------------------------------------------------------
# Provider backends
# ---------------------------------------------------------------------------

class LLMBackend:
    """One internal interface; a backend per provider."""

    def complete(self, system: str, messages: List[dict],
                 tools: List[dict]) -> dict:
        raise NotImplementedError


class AnthropicBackend(LLMBackend):
    def __init__(self, api_key: str, model: str = ""):
        self.api_key = api_key
        self.model = model or DEFAULT_MODELS["anthropic"]

    def complete(self, system, messages, tools):
        import httpx
        a_msgs = []
        for m in messages:
            if m["role"] == "user":
                a_msgs.append({"role": "user", "content": m["text"]})
            elif m["role"] == "assistant":
                content = []
                if m.get("text"):
                    content.append({"type": "text", "text": m["text"]})
                for tc in m.get("tool_calls", []):
                    content.append({"type": "tool_use", "id": tc["id"],
                                    "name": tc["name"], "input": tc["input"]})
                a_msgs.append({"role": "assistant", "content": content})
            elif m["role"] == "tool":
                a_msgs.append({"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": m["tool_call_id"],
                     "content": m["content"]}]})
        a_tools = [{"name": t["name"], "description": t["description"],
                    "input_schema": t["input_schema"]} for t in tools]
        r = httpx.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": self.api_key,
                     "anthropic-version": "2023-06-01"},
            json={"model": self.model, "max_tokens": 4096, "system": system,
                  "messages": a_msgs, "tools": a_tools},
            timeout=120.0)
        r.raise_for_status()
        data = r.json()
        text = "".join(b.get("text", "") for b in data.get("content", [])
                       if b.get("type") == "text")
        calls = [{"id": b["id"], "name": b["name"], "input": b.get("input", {})}
                 for b in data.get("content", []) if b.get("type") == "tool_use"]
        return {"text": text, "tool_calls": calls}


class GeminiBackend(LLMBackend):
    def __init__(self, api_key: str, model: str = ""):
        self.api_key = api_key
        self.model = model or DEFAULT_MODELS["gemini"]

    def complete(self, system, messages, tools):
        from google import genai
        from google.genai import types as gt
        client = genai.Client(api_key=self.api_key)
        decls = [gt.FunctionDeclaration(
            name=t["name"], description=t["description"],
            parameters=_gemini_schema(t["input_schema"])) for t in tools]
        contents = []
        for m in messages:
            if m["role"] == "user":
                contents.append(gt.Content(role="user", parts=[
                    gt.Part(text=m["text"])]))
            elif m["role"] == "assistant":
                parts = []
                if m.get("text"):
                    parts.append(gt.Part(text=m["text"]))
                for tc in m.get("tool_calls", []):
                    parts.append(gt.Part(function_call=gt.FunctionCall(
                        name=tc["name"], args=tc["input"])))
                contents.append(gt.Content(role="model", parts=parts))
            elif m["role"] == "tool":
                contents.append(gt.Content(role="user", parts=[
                    gt.Part(function_response=gt.FunctionResponse(
                        name=m.get("name", ""),
                        response={"result": m["content"]}))]))
        resp = client.models.generate_content(
            model=self.model, contents=contents,
            config=gt.GenerateContentConfig(
                system_instruction=system,
                tools=[gt.Tool(function_declarations=decls)]))
        text = ""
        calls = []
        cand = (resp.candidates or [None])[0]
        if cand and cand.content and cand.content.parts:
            for i, part in enumerate(cand.content.parts):
                if getattr(part, "text", None):
                    text += part.text
                fc = getattr(part, "function_call", None)
                if fc is not None:
                    calls.append({"id": f"call_{i}", "name": fc.name,
                                  "input": dict(fc.args or {})})
        return {"text": text, "tool_calls": calls}


def _gemini_schema(schema: dict) -> dict:
    """Gemini rejects empty property maps and bare {} schemas; sanitize."""
    import copy
    s = copy.deepcopy(schema)

    def fix(node):
        if not isinstance(node, dict):
            return node
        if node.get("type") == "object":
            props = node.get("properties") or {}
            node["properties"] = {k: fix(v if v else {"type": "string"})
                                  for k, v in props.items()}
            if not node["properties"]:
                node["properties"] = {"_": {"type": "string"}}
        if "items" in node:
            node["items"] = fix(node["items"] or {"type": "string"})
        if not node.get("type") and "enum" not in node:
            node["type"] = "string"
        return node
    return fix(s)


class FakeBackend(LLMBackend):
    """Deterministic test backend: parses 'CALL tool {json}' commands from the
    last user message; otherwise echoes."""

    def complete(self, system, messages, tools):
        last_user = next((m for m in reversed(messages)
                          if m["role"] == "user"), {"text": ""})
        already = sum(1 for m in messages if m["role"] == "assistant")
        cmds = re.findall(r"CALL (\w+) (\{.*?\})(?=\s*CALL|\s*$)",
                          last_user.get("text", ""), re.S)
        if cmds and already == 0:
            calls = [{"id": f"c{i}", "name": name, "input": json.loads(arg)}
                     for i, (name, arg) in enumerate(cmds)]
            return {"text": "Working on it.", "tool_calls": calls}
        return {"text": "Done.", "tool_calls": []}


def get_backend(settings: dict) -> LLMBackend:
    provider = (settings.get("llm_provider") or "anthropic").lower()
    model = settings.get("llm_model") or ""
    if provider == "fake":
        return FakeBackend()
    if provider == "gemini":
        key = settings.get("gemini_api_key") or ""
        if not key:
            raise ValueError("Gemini API key missing — set it in Settings")
        return GeminiBackend(key, model)
    key = settings.get("anthropic_api_key") or ""
    if not key:
        raise ValueError("Anthropic API key missing — set it in Settings")
    return AnthropicBackend(key, model)


# ---------------------------------------------------------------------------
# The agent loop
# ---------------------------------------------------------------------------

def run_chat_turn(ctx: ToolContext, backend: LLMBackend,
                  history: List[dict], user_text: str,
                  on_event: Optional[Callable[[dict], None]] = None) -> dict:
    """One user turn: call the model, execute tool calls (max
    ``MAX_TOOL_TURNS`` rounds), stream events via ``on_event``. Returns
    {"text", "changes", "preview_job", "history"}."""
    emit = on_event or (lambda e: None)
    tools = tool_definitions()
    system = system_prompt(ctx)
    messages = list(history) + [{"role": "user", "text": user_text}]
    final_text = ""
    for _ in range(MAX_TOOL_TURNS):
        out = backend.complete(system, messages, tools)
        if out.get("text"):
            final_text = out["text"]
            emit({"type": "text", "text": out["text"]})
        calls = out.get("tool_calls") or []
        messages.append({"role": "assistant", "text": out.get("text", ""),
                         "tool_calls": calls})
        if not calls:
            break
        for tc in calls:
            emit({"type": "tool_call", "name": tc["name"],
                  "input": tc["input"]})
            result = run_tool(ctx, tc["name"], tc["input"])
            emit({"type": "tool_result", "name": tc["name"],
                  "result": result[:2000]})
            messages.append({"role": "tool", "tool_call_id": tc["id"],
                             "name": tc["name"], "content": result})
    return {"text": final_text, "changes": ctx.changes,
            "preview_job": ctx.preview_job, "render_job": ctx.render_job,
            "history": messages}
