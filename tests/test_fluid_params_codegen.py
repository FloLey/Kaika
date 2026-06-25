"""No-drift guard for the generated frontend fluid param spec (B2.6 / B8.6).

`frontend/src/lib/fluidParams.js` is generated from `animation_params.FLUID_PARAM_SPEC`
by `backend.gen_fluid_params`. This asserts the committed file matches what the spec
would generate, so the front/back param mirror can never silently drift — if it
fails, run `make gen-params` and commit.
"""
from pathlib import Path

from backend import gen_fluid_params
from backend.animation_params import FLUID_PARAM_SPEC, PARAMS


def test_committed_fluid_params_matches_spec():
    out = Path(gen_fluid_params._OUT)
    assert out.exists(), "fluidParams.js missing — run `make gen-params`"
    assert out.read_text() == gen_fluid_params.render(), (
        "fluidParams.js is stale — run `make gen-params` and commit the result.")


def test_params_view_is_derived_from_spec():
    # The compact PARAMS dict the executor reads is exactly the spec's projection.
    assert set(PARAMS) == {p["key"] for p in FLUID_PARAM_SPEC}
    for p in FLUID_PARAM_SPEC:
        assert PARAMS[p["key"]] == (p["sim_group"], p["min"], p["max"], p["default"])
