"""Phase S1: segment-aware Project model + per-segment simulation (v2)."""
from __future__ import annotations

import numpy as np

from kaika.core.analyze import analyze
from kaika.core import recipe as R
from kaika.core.project import Project, Segment, _deep_merge
from kaika.core.simulate import simulate


def test_from_score_builds_segments(track_wav):
    score = analyze(track_wav, fps=24)
    rec = R.load_recipe("eclosion")
    proj = Project.from_score(score, rec, audio="track.wav")
    assert len(proj.segments) == len(score.sections)
    # prompts seeded from the recipe per label
    assert proj.segments[0].prompt == rec.prompt_for(score.sections[0].label)
    assert proj.fps == rec.canvas.fps


def test_deep_merge_partial_override():
    base = {"vorticity": {"min": 8, "max": 38}, "dissipation": 0.9}
    out = _deep_merge(base, {"vorticity": {"max": 60}})
    assert out["vorticity"] == {"min": 8, "max": 60}   # min preserved
    assert out["dissipation"] == 0.9


def test_frame_trees_apply_segment_overrides(track_wav):
    score = analyze(track_wav, fps=24)
    rec = R.from_dict({"version": 2})
    proj = Project.from_score(score, rec, audio="t.wav")
    # override the last segment only
    proj.segments[-1].fluid = {"field": {"vorticity": 99}}
    trees, _ = proj.frame_trees(score.n_frames, score)
    assert trees[0]["field"]["vorticity"] == rec.field_.vorticity
    assert trees[-1]["field"]["vorticity"] == 99
    # other leaves of the overridden segment keep their defaults
    assert trees[-1]["field"]["dissipation"] == rec.field_.dissipation


def test_frame_trees_smooth_across_boundary(track_wav):
    """Numeric params glide over SMOOTH_S at a boundary instead of jumping."""
    score = analyze(track_wav, fps=24)
    dur = score.audio.duration_s
    rec = R.from_dict({"version": 2, "field": {"vorticity": 20}})
    proj = Project(audio="t.wav", recipe=rec, fps=24, segments=[
        Segment(start=0.0, end=dur / 2, label="a", fluid={}),
        Segment(start=dur / 2, end=dur, label="b",
                fluid={"field": {"vorticity": 80}}),
    ])
    trees, _ = proj.frame_trees(score.n_frames, score)
    boundary = int(round(dur / 2 * 24))
    vals = [t["field"]["vorticity"] for t in trees]
    assert vals[0] == 20 and vals[-1] == 80
    near = vals[max(0, boundary - 8): boundary + 8]
    assert any(20 < v < 80 for v in near), near


def test_timeline_set_window_applies(track_wav):
    score = analyze(track_wav, fps=24)
    dur = score.audio.duration_s
    rec = R.from_dict({"version": 2, "field": {"vorticity": 10}})
    proj = Project.from_score(score, rec, audio="t.wav")
    proj.timeline = [{"between": [dur * 0.25, dur * 0.75], "action": "set",
                      "set": {"field.vorticity": 50}, "fade_s": 0.1}]
    trees, warnings = proj.frame_trees(score.n_frames, score)
    assert warnings == []
    mid = trees[score.n_frames // 2]["field"]["vorticity"]
    assert abs(mid - 50) < 1.0
    assert trees[0]["field"]["vorticity"] == 10


def test_timeline_unknown_path_warns(track_wav):
    score = analyze(track_wav, fps=24)
    rec = R.from_dict({"version": 2})
    proj = Project.from_score(score, rec, audio="t.wav")
    proj.timeline = [{"between": [0.0, 1.0], "action": "set",
                      "set": {"field.nope": 50}}]
    _, warnings = proj.frame_trees(score.n_frames, score)
    assert any("field.nope" in w for w in warnings)


def test_prompt_schedule_per_segment(track_wav):
    score = analyze(track_wav, fps=24)
    rec = R.load_recipe("eclosion")
    proj = Project.from_score(score, rec, audio="t.wav")
    proj.segments[-1].prompt = "UNIQUE LAST PROMPT"
    sched = proj.prompt_schedule(score.n_frames)
    assert len(sched) == score.n_frames
    assert sched[-1] == "UNIQUE LAST PROMPT"


def test_roundtrip(tmp_path, track_wav):
    score = analyze(track_wav, fps=24)
    rec = R.load_recipe("eclosion")
    proj = Project.from_score(score, rec, audio="t.wav")
    proj.segments[0].fluid = {"field": {"dissipation": 0.85}}
    proj.timeline = [{"at": 1.0, "action": "spawn", "count": 2}]
    proj.ui_pins = ["field.vorticity"]
    p = tmp_path / "project.json"
    proj.to_json(p)
    again = Project.from_json(p)
    assert len(again.segments) == len(proj.segments)
    assert again.segments[0].fluid == {"field": {"dissipation": 0.85}}
    assert again.recipe.seed == proj.recipe.seed
    assert again.timeline == proj.timeline
    assert again.ui_pins == ["field.vorticity"]


def test_simulation_respects_per_segment_emit(track_wav, tmp_path):
    """A segment that emits no dye must stay darker than one that does — proof
    that per-segment parameters actually drive the continuous simulation."""
    score = analyze(track_wav, fps=24)
    half = score.audio.duration_s / 2
    rec = R.from_dict({"version": 2, "seed": 1,
                       "canvas": {"width": 48, "height": 48,
                                  "sim_resolution": 48}})
    silent = {"field": {"ambient": {"strength": 0.0}},
              "emitters": {e.id: {"body": {"emit": 0.0}}
                           for e in rec.emitters}}
    proj = Project(audio="t.wav", recipe=rec, fps=24, segments=[
        Segment(start=0.0, end=half, label="silent", fluid=silent),
        Segment(start=half, end=score.audio.duration_s, label="loud", fluid={}),
    ])
    n = score.n_frames
    trees, _ = proj.frame_trees(n, score)
    sim = simulate(score, rec, tmp_path, frame_trees=trees)
    import imageio.v2 as imageio
    frames = sorted(sim.fluid_dir.glob("*.png"))
    h = len(frames) // 2
    first = np.mean([imageio.imread(f).mean() for f in frames[:h]])
    second = np.mean([imageio.imread(f).mean() for f in frames[h:]])
    assert first < second        # silent segment darker than the emitting one


def test_revisions(tmp_path, track_wav):
    from kaika.core.project import append_revision, list_revisions, load_revision
    score = analyze(track_wav, fps=24)
    proj = Project.from_score(score, R.from_dict({"version": 2}), audio="t.wav")
    proj.to_json(tmp_path / "project.json")
    append_revision(tmp_path, proj, note="first")
    proj.recipe.seed = 99
    append_revision(tmp_path, proj, note="second")
    revs = list_revisions(tmp_path)
    assert [r["note"] for r in revs] == ["first", "second"]
    assert load_revision(tmp_path, 1).recipe.seed == 99
