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
