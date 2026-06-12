"""Phase 2: recipe loading, defaults, validation, and prompt resolution (v2)."""
from __future__ import annotations

import pytest

from kaika.core import recipe as R


def test_load_named_recipe():
    r = R.load_recipe("eclosion")
    assert r.name == "eclosion"
    assert r.seed == 4217
    assert r.version == 2
    assert {e.id for e in r.emitters} >= {"kicks", "hats"}
    assert r.diffusion.strength == 0.5


def test_prompt_base_is_prefixed():
    r = R.load_recipe("eclosion")
    p = r.prompt_for("drop")
    assert p.startswith(r.prompts["base"])
    assert "peonies" in p


def test_unknown_label_falls_back_to_default():
    r = R.load_recipe("eclosion")
    p = r.prompt_for("chorus")  # not defined
    assert r.prompts["default"] in p


def test_partial_dict_uses_defaults():
    r = R.from_dict({"name": "tiny", "fluid": {"resolution": 32}})
    assert r.name == "tiny"
    assert r.canvas.sim_resolution == 32        # v1 fluid.resolution upgraded
    assert r.field_.dissipation == R.FieldConfig().dissipation
    assert r.diffusion.backend == "local"


def test_v1_upgrade_reproduces_mapping():
    """The v1 splats/vorticity/lookahead trio becomes emitters + modulators."""
    r = R.from_dict({"seed": 3, "fluid": {
        "splats": {"low": {"radius": 0.2, "emit": 0.5},
                   "high": {"max_per_beat": 7}},
        "vorticity": {"min": 4, "max": 24},
        "lookahead_s": 6.0,
        "palette": ["#111111", "#222222"]}})
    ids = [e.id for e in r.emitters]
    assert ids == ["kicks", "hats", "tension"]
    kicks = r.emitter("kicks")
    assert kicks.body.radius == 0.2 and kicks.body.emit == 0.5
    assert r.emitter("hats").trigger.max_per_frame == 7
    assert r.emitter("tension").trigger.window_s == 6.0
    vort = next(m for m in r.modulators if m.target == "field.vorticity")
    assert vort.range == [4, 24]
    assert r.palettes["main"] == ["#111111", "#222222"]


def test_yaml_roundtrip(tmp_path):
    r = R.load_recipe("eclosion")
    p = tmp_path / "r.yaml"
    r.to_yaml(p)
    again = R.load_recipe(p)
    assert again.seed == r.seed
    assert again.prompt_for("drop") == r.prompt_for("drop")
    assert [e.id for e in again.emitters] == [e.id for e in r.emitters]


def test_validation_rejects_bad_modulator_path():
    with pytest.raises(ValueError, match="field.nope"):
        R.from_dict({"version": 2, "modulators": [
            {"source": "rms", "target": "field.nope"}]})


def test_validation_rejects_live_apply_to():
    with pytest.raises(ValueError, match="reserved"):
        R.from_dict({"version": 2, "modulators": [
            {"source": "rms", "target": "field.vorticity",
             "apply_to": "live"}]})


def test_validation_rejects_unknown_types():
    with pytest.raises(ValueError, match="placement"):
        R.from_dict({"version": 2, "emitters": [
            {"id": "x", "placement": {"type": "teleport"}}]})


def test_canvas_grid_fft_friendly():
    h, w = R.Canvas(width=1080, height=1920, sim_resolution=256).grid()
    assert w == 256 and h >= 256
    for n in (h, w):
        k = n
        for p in (2, 3, 5):
            while k % p == 0:
                k //= p
        assert k == 1, f"{n} is not FFT-friendly"


def test_placement_from_to_aliases():
    r = R.from_dict({"version": 2, "emitters": [
        {"id": "x", "placement": {"type": "line", "from": [0.2, 0.5],
                                  "to": [0.8, 0.5]}}]})
    assert r.emitter("x").placement.points == [[0.2, 0.5], [0.8, 0.5]]


def test_spiral_placement_validation():
    import pytest as _pt
    ok = {"version": 2, "seed": 1, "emitters": [{
        "id": "s", "trigger": {"type": "onset", "band": "mid"},
        "placement": {"type": "spiral", "center": [0.5, 0.5], "radius": 0.3,
                      "inner_radius": 0.02, "turns": 3.0, "sequence": 8},
        "direction": {"type": "radial_out"},
        "color": {"type": "fixed", "hex": "#2255FF"}}]}
    rec = R.from_dict(ok)
    assert rec.emitter("s").placement.turns == 3.0
    d = rec.to_dict()                                   # round-trips
    assert d["emitters"][0]["placement"]["sequence"] == 8
    for bad_placement, frag in [
        ({"type": "spiral", "radius": 0.0}, "radius > 0"),
        ({"type": "spiral", "radius": 0.2, "turns": 0}, "turns != 0"),
        ({"type": "circle", "sequence": -1}, "sequence must be >= 0"),
        ({"type": "wander", "sequence": 4}, "parametric shapes"),
    ]:
        spec = {**ok, "emitters": [{**ok["emitters"][0],
                                    "placement": bad_placement}]}
        with _pt.raises(ValueError, match="invalid recipe"):
            R.from_dict(spec)


def test_old_recipe_loads_with_new_placement_defaults():
    rec = R.from_dict({"version": 2, "seed": 1, "emitters": [{
        "id": "k", "trigger": {"type": "beat"},
        "placement": {"type": "circle", "radius": 0.2}}]})
    p = rec.emitter("k").placement
    assert (p.inner_radius, p.turns, p.start_deg, p.sequence) == (0.0, 2.0,
                                                                  0.0, 0)


def test_lyrics_config_roundtrip_and_validation():
    import pytest as _pt
    rec = R.from_dict({"version": 2, "lyrics": {"enabled": True,
                                                "mode": "both",
                                                "position": "top",
                                                "scale": 1.4}})
    assert rec.lyrics.enabled and rec.lyrics.mode == "both"
    assert rec.to_dict()["lyrics"]["position"] == "top"
    for bad in ({"position": "nowhere"}, {"mode": "subtitles"},
                {"scale": 9.0}, {"color": "blue"}):
        with _pt.raises(ValueError, match="invalid recipe"):
            R.from_dict({"version": 2, "lyrics": bad})


def test_timeline_text_action_validation():
    assert R.validate_timeline([{"at": 3.0, "action": "text",
                                 "text": "KAIKA", "height": 0.1,
                                 "hold_s": 2.0, "color": "#FFFFFF"}]) == []
    errs = R.validate_timeline([{"at": 3.0, "action": "text", "text": " ",
                                 "color": "blue"}])
    assert len(errs) == 2
