"""No-drift guard for the generated frontend param specs (B2.6 / B8.6).

`frontend/src/lib/fluidParams.js` is generated from the backend specs
(`animation_params.FLUID_PARAM_SPEC` / `COLOR_PARAM_SPEC` / `SOURCE_PARAM_SPEC`)
by `backend.gen_fluid_params`. This asserts the committed file matches what the
specs would generate, so the front/back param mirror can never silently drift —
if it fails, run `make gen-params` and commit.
"""

from pathlib import Path

from backend import gen_fluid_params
from backend.animation_params import (
    COLOR_PARAM_SPEC,
    COLOR_PARAMS,
    FLUID_PARAM_SPEC,
    PARAMS,
    SOURCE_PARAM_SPEC,
)
from backend.sources import SOURCE_PARAMS


def test_committed_fluid_params_matches_spec():
    out = Path(gen_fluid_params._OUT)
    assert out.exists(), "fluidParams.js missing — run `make gen-params`"
    assert (
        out.read_text() == gen_fluid_params.render()
    ), "fluidParams.js is stale — run `make gen-params` and commit the result."


def test_committed_graph_constants_match_the_backend():
    """`lib/graph/generated.ts` carries the three tables that used to be hand-copied
    across the language barrier: VIDEO_PRODUCERS, _SIGNAL_HASH_FIELDS, _SLOT_CARDS.

    Drift here was silent by construction — the two sides hash independently and the
    digests differ on purpose, so nothing ever failed loudly. A missing producer makes
    the editor refuse to draw a card; a missing hash field makes the preview and the
    export compute different cache keys and quietly disagree about what a graph IS.
    """
    out = Path(gen_fluid_params._GRAPH_OUT)
    assert out.exists(), "graph/generated.ts missing — run `make gen-params`"
    assert (
        out.read_text() == gen_fluid_params.render_graph_constants()
    ), "graph/generated.ts is stale — run `make gen-params` and commit the result."


def test_generated_graph_constants_carry_every_backend_entry():
    """Belt and braces: the no-diff check above would also pass if the RENDERER silently
    dropped entries. Assert the content directly against the backend tables."""
    from backend.graph_common import VIDEO_PRODUCERS
    from backend.graph_hash import _SIGNAL_HASH_FIELDS, _SLOT_CARDS

    text = gen_fluid_params.render_graph_constants()
    for t in VIDEO_PRODUCERS:
        assert f'"{t}"' in text, f"producer {t!r} missing from the generated constants"
    for f in _SIGNAL_HASH_FIELDS:
        assert f'"{f}"' in text, f"signal hash field {f!r} missing"
    for c in _SLOT_CARDS:
        assert f'"{c}"' in text, f"slot card {c!r} missing"
    # Order is significant for the signal fields — the backend hashes them positionally.
    positions = [text.index(f'"{f}"') for f in _SIGNAL_HASH_FIELDS]
    assert positions == sorted(positions), "SIGNAL_HASH_FIELDS emitted out of order"


def test_generated_file_covers_color_and_source_specs():
    # The generated JS carries every color + source spec row (key/min/max/default),
    # so nodeParams.ts consumes the backend values instead of a hand mirror.
    text = gen_fluid_params.render()
    assert "export const COLOR_PARAMS" in text
    assert "export const SOURCE_PARAMS" in text
    for p in COLOR_PARAM_SPEC:
        assert f'key: "{p["key"]}"' in text
    for card, spec in SOURCE_PARAM_SPEC.items():
        assert f'"{card}": [' in text
        for p in spec:
            assert f'key: "{p["key"]}"' in text


def test_params_view_is_derived_from_spec():
    # The compact PARAMS dict the executor reads is exactly the spec's projection.
    assert set(PARAMS) == {p["key"] for p in FLUID_PARAM_SPEC}
    for p in FLUID_PARAM_SPEC:
        assert PARAMS[p["key"]] == (p["sim_group"], p["min"], p["max"], p["default"])


def test_color_and_source_views_are_derived_from_specs():
    # Same guarantee for the color card and the source layer cards.
    assert set(COLOR_PARAMS) == {p["key"] for p in COLOR_PARAM_SPEC}
    for p in COLOR_PARAM_SPEC:
        assert COLOR_PARAMS[p["key"]] == (p["min"], p["max"], p["default"])
    assert set(SOURCE_PARAMS) == set(SOURCE_PARAM_SPEC)
    for card, spec in SOURCE_PARAM_SPEC.items():
        assert SOURCE_PARAMS[card] == {p["key"]: (p["min"], p["max"], p["default"]) for p in spec}
