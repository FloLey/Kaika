"""Chat copilot: JSON Patch, the tool layer, and the agent loop (fake backend)."""
from __future__ import annotations

import json

import pytest

from kaika.core import chat as C
from kaika.core import recipe as R
from kaika.core.analyze import analyze
from kaika.core.project import Project


@pytest.fixture
def ctx(track_wav, tmp_path):
    score = analyze(track_wav, fps=24)
    proj = Project.from_score(score, R.from_dict({"version": 2}), audio="t.wav")
    proj.to_json(tmp_path / "project.json")
    return C.ToolContext(run_dir=tmp_path, score=score,
                         submit_preview=lambda t0, t1: "job-123")


# ---- JSON Patch -------------------------------------------------------------

def test_json_patch_ops():
    doc = {"a": {"b": 1}, "list": [1, 2]}
    out = C.apply_json_patch(doc, [
        {"op": "replace", "path": "/a/b", "value": 5},
        {"op": "add", "path": "/list/-", "value": 3},
        {"op": "remove", "path": "/list/0"},
    ])
    assert out == {"a": {"b": 5}, "list": [2, 3]}
    assert doc == {"a": {"b": 1}, "list": [1, 2]}     # original untouched


def test_json_patch_bad_path():
    with pytest.raises(ValueError, match="does not exist"):
        C.apply_json_patch({}, [{"op": "replace", "path": "/nope/x", "value": 1}])


# ---- tools ------------------------------------------------------------------

def test_tool_patch_recipe_validates(ctx):
    res = C.run_tool(ctx, "patch_recipe", {"ops": [
        {"op": "replace", "path": "/field/vorticity", "value": 33}]})
    assert res == "ok"
    assert ctx.project().recipe.field_.vorticity == 33
    # invalid value -> verbatim validation error, project unchanged
    res = C.run_tool(ctx, "patch_recipe", {"ops": [
        {"op": "add", "path": "/modulators/-",
         "value": {"source": "rms", "target": "field.nope"}}]})
    assert "VALIDATION ERROR" in res and "field.nope" in res
    assert ctx.project().recipe.field_.vorticity == 33


def test_tool_emitter_crud(ctx):
    res = C.run_tool(ctx, "add_emitter", {"spec": {
        "id": "pulse", "trigger": {"type": "beat", "every": 4},
        "placement": {"type": "circle", "center": [0.5, 0.5], "radius": 0.2},
        "count": 8}})
    assert res == "ok"
    assert ctx.project().recipe.emitter("pulse").count == 8
    res = C.run_tool(ctx, "update_emitter",
                     {"id": "pulse", "patch": {"body": {"radius": 0.2}}})
    assert res == "ok"
    assert ctx.project().recipe.emitter("pulse").body.radius == 0.2
    assert C.run_tool(ctx, "remove_emitter", {"id": "pulse"}) == "ok"
    assert ctx.project().recipe.emitter("pulse") is None
    assert "ERROR" in C.run_tool(ctx, "update_emitter",
                                 {"id": "ghost", "patch": {}})


def test_tool_timeline_directive(ctx):
    res = C.run_tool(ctx, "add_timeline_directive", {"spec": {
        "at": 2.0, "action": "spawn", "emitter": "kicks", "count": 3,
        "placement": {"type": "line", "from": [0.3, 0.5], "to": [0.7, 0.5]},
        "mag": 1.0}})
    assert res == "ok"
    assert ctx.project().timeline[0]["count"] == 3
    res = C.run_tool(ctx, "add_timeline_directive",
                     {"spec": {"action": "set"}})       # invalid
    assert "VALIDATION ERROR" in res


def test_tool_set_canvas_and_preview(ctx):
    assert C.run_tool(ctx, "set_canvas",
                      {"spec": {"width": 1080, "height": 1920}}) == "ok"
    assert ctx.project().recipe.canvas.height == 1920
    res = C.run_tool(ctx, "preview", {"t0": 1.0, "t1": 4.0})
    assert "job-123" in res
    assert ctx.preview_job == "job-123"


def test_tool_update_segment(ctx):
    res = C.run_tool(ctx, "update_segment", {"index": 0, "patch": {
        "prompt": "NEW PROMPT", "fluid": {"field": {"vorticity": 44}}}})
    assert res == "ok"
    seg = ctx.project().segments[0]
    assert seg.prompt == "NEW PROMPT"
    assert seg.fluid["field"]["vorticity"] == 44


def test_revisions_appended_per_mutation(ctx):
    from kaika.core.project import list_revisions
    C.run_tool(ctx, "set_canvas", {"spec": {"width": 512, "height": 512}})
    C.run_tool(ctx, "add_timeline_directive",
               {"spec": {"at": 1.0, "action": "spawn"}})
    assert len(list_revisions(ctx.run_dir)) == 2


# ---- agent loop -------------------------------------------------------------

def test_chat_turn_with_fake_backend(ctx):
    backend = C.FakeBackend()
    msg = ('Please do this: '
           'CALL add_timeline_directive {"spec": {"at": 2.0, "action": "spawn", '
           '"emitter": "kicks", "count": 3, "placement": {"type": "line", '
           '"from": [0.3, 0.5], "to": [0.7, 0.5]}, "mag": 1.0}} '
           'CALL preview {"t0": 0.5, "t1": 5.0}')
    events = []
    out = C.run_chat_turn(ctx, backend, [], msg, on_event=events.append)
    assert any(e["type"] == "tool_call" for e in events)
    assert out["preview_job"] == "job-123"
    assert ctx.project().timeline[0]["at"] == 2.0
    assert any("timeline" in c for c in out["changes"])


def test_backend_selection():
    assert isinstance(C.get_backend({"llm_provider": "fake"}), C.FakeBackend)
    b = C.get_backend({"llm_provider": "anthropic", "anthropic_api_key": "k"})
    assert isinstance(b, C.AnthropicBackend)
    assert b.model == C.DEFAULT_MODELS["anthropic"]
    b = C.get_backend({"llm_provider": "gemini", "gemini_api_key": "k",
                       "llm_model": "gemini-x"})
    assert isinstance(b, C.GeminiBackend) and b.model == "gemini-x"
    with pytest.raises(ValueError, match="API key missing"):
        C.get_backend({"llm_provider": "anthropic"})


# ---- new tools: generic setter, modulators, palettes, segments, render ------

def test_tool_set_recipe_values(ctx):
    res = C.run_tool(ctx, "set_recipe_values", {"values": {
        "seed": 7, "diffusion.strength": 0.7, "post.grain": 0.2,
        "prompts.drop": "explosive bloom", "palettes.main.0": "#0040FF"}})
    assert res == "ok"
    rec = ctx.project().recipe
    assert rec.seed == 7
    assert rec.diffusion.strength == 0.7
    assert rec.post.grain == 0.2
    assert rec.prompts["drop"] == "explosive bloom"
    assert rec.palettes["main"][0] == "#0040FF"
    assert "PATH ERROR" in C.run_tool(ctx, "set_recipe_values",
                                      {"values": {"nope.x.y": 1}})
    assert "ERROR" in C.run_tool(ctx, "set_recipe_values", {"values": {}})


def test_tool_update_modulator(ctx):
    C.run_tool(ctx, "add_modulator", {"spec": {
        "source": "rms", "target": "field.vorticity", "range": [8, 38]}})
    idx = len(ctx.project().recipe.modulators) - 1
    res = C.run_tool(ctx, "update_modulator",
                     {"index": idx, "patch": {"range": [5, 20],
                                              "smooth_s": 0.5}})
    assert res == "ok"
    m = ctx.project().recipe.modulators[idx]
    assert m.range == [5, 20] and m.smooth_s == 0.5
    assert "out of range" in C.run_tool(ctx, "update_modulator",
                                        {"index": 99, "patch": {}})
    res = C.run_tool(ctx, "update_modulator",
                     {"index": idx, "patch": {"target": "field.nope"}})
    assert "VALIDATION ERROR" in res
    assert ctx.project().recipe.modulators[idx].target == "field.vorticity"


def test_tool_set_palette(ctx):
    res = C.run_tool(ctx, "set_palette", {
        "name": "ocean", "colors": ["#0040FF", "#1060C0", "#208080"]})
    assert res == "ok"
    assert ctx.project().recipe.palettes["ocean"][0] == "#0040FF"
    assert "ERROR" in C.run_tool(ctx, "set_palette",
                                 {"name": "bad", "colors": ["blue"]})
    # immediately usable by an emitter
    res = C.run_tool(ctx, "add_emitter", {"spec": {
        "id": "h", "trigger": {"type": "beat"},
        "color": {"type": "palette", "palette": "ocean"}}})
    assert res == "ok"


def test_tool_segments_crud(ctx):
    n = len(ctx.project().segments)
    res = C.run_tool(ctx, "add_segment", {"spec": {
        "start": 1.0, "end": 2.5, "label": "fill", "prompt": "x"}})
    assert res == "ok"
    segs = ctx.project().segments
    assert len(segs) == n + 1
    assert segs == sorted(segs, key=lambda s: s.start)
    assert "ERROR" in C.run_tool(ctx, "add_segment",
                                 {"spec": {"start": 3, "end": 2}})
    idx = next(i for i, s in enumerate(ctx.project().segments)
               if s.label == "fill")
    assert C.run_tool(ctx, "remove_segment", {"index": idx}) == "ok"
    assert len(ctx.project().segments) == n
    assert "out of range" in C.run_tool(ctx, "remove_segment", {"index": 99})


def test_tool_start_render(ctx):
    assert "ERROR" in C.run_tool(ctx, "start_render", {})    # no callback
    ctx.submit_render = lambda: "render-7"
    res = C.run_tool(ctx, "start_render", {})
    assert "render-7" in res and ctx.render_job == "render-7"


def test_score_summary_onset_times(ctx):
    res = json.loads(C.run_tool(ctx, "get_score_summary",
                                {"t0": 0.0, "t1": 5.0}))
    assert set(res["onset_times_in_window"]) == {"low", "mid", "high"}
    for evs in res["onset_times_in_window"].values():
        for t, mag in evs:
            assert 0.0 <= t <= 5.0 and 0.0 <= mag <= 1.0
    res = json.loads(C.run_tool(ctx, "get_score_summary", {}))
    assert "onset_times_in_window" not in res


# ---- system prompt: schema-driven, anti-drift --------------------------------

def test_system_prompt_covers_whole_schema(ctx):
    """Every leaf of the generated recipe schema must be documented in the
    system prompt — a new engine field that misses the prompt is a bug."""
    from kaika.core.schema import recipe_schema
    C.run_tool(ctx, "set_recipe_values", {"values": {"field.vorticity": 33.5}})
    prompt = C.system_prompt(ctx)

    def walk(node, path):
        props = node.get("properties")
        if props is not None:
            for k, v in props.items():
                walk(v, f"{path}.{k}" if path else k)
            return
        ap = node.get("additionalProperties")
        if isinstance(ap, dict):
            if ap.get("properties"):
                walk(ap, path + ".<name>")
            else:
                assert f"{path}.<name>:" in prompt, path
            return
        items = node.get("items")
        if isinstance(items, dict) and items.get("properties"):
            walk(items, path + "[]")
            return
        assert f"{path}:" in prompt, f"schema leaf '{path}' not in prompt"

    walk(recipe_schema(), "")
    assert "spiral" in prompt and "field.detail:" in prompt
    assert "33.5" in prompt              # current recipe values are embedded
    assert "section:drop" in prompt      # timeline grammar block


# ---- end-to-end: the spiral-at-the-drop scenario ------------------------------

def test_chat_spiral_scenario(ctx):
    """The acceptance scenario: rapid onsets traced as a spiral from the
    center, flowing outward, blue, confined to a moment, then previewed."""
    backend = C.FakeBackend()
    msg = (
        'CALL add_emitter {"spec": {"id": "drop_spiral", '
        '"trigger": {"type": "onset", "band": "high"}, '
        '"placement": {"type": "spiral", "center": [0.5, 0.5], '
        '"inner_radius": 0.02, "radius": 0.35, "turns": 2, "sequence": 12}, '
        '"direction": {"type": "radial_out"}, '
        '"color": {"type": "fixed", "hex": "#2255FF"}}} '
        'CALL add_timeline_directive {"spec": {"at": 0, "action": "mute", '
        '"emitter": "drop_spiral"}} '
        'CALL add_timeline_directive {"spec": {"at": 2.8, "action": "unmute", '
        '"emitter": "drop_spiral"}} '
        'CALL preview {"t0": 2.0, "t1": 7.0}')
    out = C.run_chat_turn(ctx, backend, [], msg)
    em = ctx.project().recipe.emitter("drop_spiral")
    assert em.placement.type == "spiral" and em.placement.sequence == 12
    assert em.direction.type == "radial_out"
    assert em.color.hex == "#2255FF"
    acts = [d["action"] for d in ctx.project().timeline]
    assert acts == ["mute", "unmute"]
    assert out["preview_job"] == "job-123"
    assert len(out["changes"]) == 3
    from kaika.core.project import list_revisions
    assert len(list_revisions(ctx.run_dir)) == 3


def test_update_timeline_directive_deep_merges(ctx):
    C.run_tool(ctx, "add_timeline_directive", {"spec": {
        "action": "set", "between": [2.0, 8.0],
        "set": {"emitters.kicks.placement.type": "spiral",
                "emitters.kicks.color.hex": "#0000FF"}}})
    res = C.run_tool(ctx, "update_timeline_directive", {"index": 0, "patch": {
        "set": {"emitters.kicks.placement.sequence": 12}}})
    assert res == "ok"
    s = ctx.project().timeline[0]["set"]
    assert s["emitters.kicks.placement.sequence"] == 12
    assert s["emitters.kicks.placement.type"] == "spiral"   # not clobbered
    assert s["emitters.kicks.color.hex"] == "#0000FF"


def test_update_emitter_accepts_dotted_keys(ctx):
    """Models mix dot notation into merge patches; dotted keys must expand
    instead of being silently dropped by validation."""
    C.run_tool(ctx, "set_palette",
               {"name": "ocean", "colors": ["#001F3F", "#004080"]})
    res = C.run_tool(ctx, "update_emitter",
                     {"id": "hats", "patch": {"color.palette": "ocean",
                                              "body.radius": 0.05}})
    assert res == "ok"
    em = ctx.project().recipe.emitter("hats")
    assert em.color.palette == "ocean"
    assert em.body.radius == 0.05


def test_tool_split_segment(ctx):
    seg0 = ctx.project().segments[0]
    mid = (seg0.start + seg0.end) / 2
    n = len(ctx.project().segments)
    res = C.run_tool(ctx, "split_segment",
                     {"index": 0, "at": mid, "label": "drop-intro"})
    assert res == "ok"
    segs = ctx.project().segments
    assert len(segs) == n + 1
    assert segs[0].end == pytest.approx(mid)
    assert segs[1].start == pytest.approx(mid)
    assert segs[1].label == "drop-intro"
    assert "must fall inside" in C.run_tool(
        ctx, "split_segment", {"index": 0, "at": seg0.end + 99})
    assert "out of range" in C.run_tool(ctx, "split_segment",
                                        {"index": 99, "at": 1.0})
