"""Creative suggestions: per-segment briefs, LLM plan parsing, apply/validate."""
from __future__ import annotations

import json

import pytest

from kaika.core.analyze import analyze
from kaika.core import recipe as R
from kaika.core import suggest as SG
from kaika.core.project import Project


@pytest.fixture
def setup(track_wav):
    lines = [{"t0": 0.3, "t1": 0.9, "text": "hello world"}]
    score = analyze(track_wav, fps=24, lyric_lines=lines)
    rec = R.load_recipe("eclosion")
    proj = Project.from_score(score, rec, audio="t.wav")
    return score, rec, proj, lines


def test_segment_briefs(setup):
    score, rec, proj, lines = setup
    briefs = SG.segment_briefs(score, lines, proj.segments)
    assert briefs["has_lyrics"] and briefs["tempo_bpm"] > 0
    s0 = briefs["segments"][0]
    assert set(s0["onsets_per_s"]) == {"low", "mid", "high"}
    assert "hello world" in s0["lyrics"]
    assert 0.0 <= s0["vocal_presence"] <= 1.0


class _StubBackend:
    def __init__(self, plan, as_string=False):
        self.plan = plan
        self.as_string = as_string

    def complete(self, system, messages, tools):
        assert tools[0]["name"] == "propose_plan"
        plan = json.dumps(self.plan) if self.as_string else self.plan
        return {"text": "", "tool_calls": [
            {"id": "c0", "name": "propose_plan", "input": {"plan": plan}}]}


_PLAN = {
    "global": {"title": "Neon", "reasoning": "bright",
               "recipe_values": {"palettes.main.0": "#00C0FF",
                                 "render.exposure": 2.1}},
    "segments": [{"segment_index": 0, "label": "intro", "reasoning": "calm",
                  "fluid": {"field": {"vorticity": 12}},
                  "prompt": "soft glow",
                  "timeline": [{"action": "text", "at": 0.4, "text": "GO",
                                "color": "#FFFFFF"}]}],
}


@pytest.mark.parametrize("as_string", [False, True])   # native vs Gemini string
def test_generate_plan_parses(setup, as_string):
    score, rec, proj, lines = setup
    plan = SG.generate_plan(_StubBackend(_PLAN, as_string), score, rec,
                            proj.segments, lines)
    assert plan["global"]["title"] == "Neon"
    assert plan["segments"][0]["segment_index"] == 0


def test_apply_global_and_segment(setup):
    score, rec, proj, lines = setup
    g = SG.apply_to_project(proj, {"global": _PLAN["global"]})
    assert g.recipe.palettes["main"][0] == "#00C0FF"
    assert g.recipe.render.exposure == 2.1
    s = SG.apply_to_project(proj, _PLAN["segments"][0])
    assert s.segments[0].fluid["field"]["vorticity"] == 12
    assert s.segments[0].prompt == "soft glow"
    assert s.timeline[-1]["text"] == "GO"
    # original project untouched (deep copy)
    assert proj.segments[0].fluid == {}


def test_invalid_proposal_rejected(setup):
    score, rec, proj, lines = setup
    bad = {"segment_index": 0, "fluid": {"render": {"background_color":
           {"type": "palette", "palette": "ghost"}}}}
    with pytest.raises(ValueError):
        SG.apply_to_project(proj, bad)
    plan = {"global": None, "segments": [bad]}
    _, warnings = SG.validate_plan(proj, plan)
    assert warnings and "invalid" in plan["segments"][0]
