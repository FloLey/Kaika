"""The Dream card's per-frame plan (specs/dream/03).

`tests/fixtures/cut_schedule_cases.json` is the oracle and is read by the frontend suite
too — the timeline draws from `lib/cutSchedule.ts` and the render generates from
`backend/cut_schedule.py`, so a drift between them makes the editor lie about the render
without anything failing loudly. Neither side can be "fixed" alone while this holds.
"""

import json
from pathlib import Path

import pytest

import numpy as np

from backend.cut_schedule import (
    _clamped_fades,
    _shaped,
    _weight,
    dream_plan,
    effective_cuts,
    lyric_cuts,
    part_starts,
)

CASES = json.loads((Path(__file__).parent / "fixtures" / "cut_schedule_cases.json").read_text())[
    "cases"
]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_fixture(case):
    plan = dream_plan(
        case["cuts"],
        case["prompts"],
        case["fps"],
        case["nframes"],
        seed=case.get("seed", 1),
        seed_mode=case.get("seedMode", "gate"),
        reseed_frames=case.get("reseedFrames"),
        shape=case.get("shape", 1.0),
    )
    got = [[s["prompt_a"], s["prompt_b"], round(s["w"], 6), s["seed"]] for s in plan]
    assert got == [[a, b, round(w, 6), sd] for a, b, w, sd in case["expect"]]


# --------------------------------------------------------------------------- #
# The clamp — the invariant everything downstream depends on
# --------------------------------------------------------------------------- #


def test_clamp_scales_both_fades_proportionally():
    prompts = [{"text": "a", "fadeIn": 3.0, "fadeOut": 1.0}]
    fi, fo = _clamped_fades(prompts, [0], 4, 4)[0]  # a 1-second part
    assert fi + fo == pytest.approx(1.0)
    assert fi / fo == pytest.approx(3.0)  # the RATIO survives


def test_clamp_leaves_fitting_fades_alone():
    prompts = [{"text": "a", "fadeIn": 0.2, "fadeOut": 0.3}]
    assert _clamped_fades(prompts, [0], 40, 4)[0] == (0.2, 0.3)


def test_clamp_guarantees_at_most_two_prompts_blend():
    """The point of the clamp: adjacent transitions cannot overlap, so no frame ever
    needs a three-way blend. Every frame's plan entry has at most two prompts by
    construction — assert it over a schedule built to overlap without the clamp."""
    prompts = [
        {"text": "a", "fadeOut": 9},
        {"text": "b", "fadeIn": 9, "fadeOut": 9},
        {"text": "c", "fadeIn": 9},
    ]
    plan = dream_plan([4, 6], prompts, 4, 12, seed=1, seed_mode="fixed")
    for step in plan:
        assert step["prompt_a"] is not None
        # two named prompts max — the schema itself cannot express a third
        assert set(step.keys()) == {"prompt_a", "prompt_b", "w", "seed", "scale", "keep"}


def test_a_zero_length_part_degenerates_safely():
    """Two cuts on the same frame give a part of duration 0 — the clamp divides by the
    duration, so this is where a naive implementation raises."""
    prompts = [{"text": "a"}, {"text": "b", "fadeIn": 1}, {"text": "c"}]
    plan = dream_plan([4, 4], prompts, 4, 8, seed=1, seed_mode="fixed")
    assert len(plan) == 8


# --------------------------------------------------------------------------- #
# The weight function
# --------------------------------------------------------------------------- #


def test_hard_cut_flips_at_the_cut():
    assert _weight(0.9, 1.0, 0, 0) == 0.0
    assert _weight(1.0, 1.0, 0, 0) == 1.0


def test_weight_at_the_cut_is_the_out_share():
    """With o seconds before and i after, the cut frame sits o/(o+i) across."""
    assert _weight(1.0, 1.0, 0.3, 0.1) == pytest.approx(0.75)
    assert _weight(1.0, 1.0, 0.1, 0.3) == pytest.approx(0.25)


def test_weight_is_clamped_outside_the_span():
    assert _weight(0.0, 1.0, 0.2, 0.2) == 0.0
    assert _weight(5.0, 1.0, 0.2, 0.2) == 1.0


def test_weight_is_monotonic_across_the_span():
    prev = -1.0
    for k in range(21):
        w = _weight(0.8 + k * 0.02, 1.0, 0.2, 0.2)
        assert w >= prev
        prev = w


# --------------------------------------------------------------------------- #
# The fade SHAPE — the answer to Z-Image's steep interpolation
# --------------------------------------------------------------------------- #


def test_shape_one_is_the_identity():
    """Linear is the default, and SD-Turbo (which morphs evenly) wants exactly it."""
    for u in (0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0):
        assert _shaped(u, 1.0) == pytest.approx(u)


def test_shape_pins_the_endpoints_and_the_midpoint():
    """Whatever the curve, a fade must still START at prompt A and END at prompt B —
    and the midpoint has to stay the midpoint or the cut frame's o/(o+i) meaning breaks."""
    for shape in (0.5, 1.0, 2.0, 3.0, 5.0):
        assert _shaped(0.0, shape) == pytest.approx(0.0)
        assert _shaped(1.0, shape) == pytest.approx(1.0)
        assert _shaped(0.5, shape) == pytest.approx(0.5)


def test_shape_above_one_flattens_around_the_midpoint():
    """The point of the control: at shape 3 the ramp's middle frames land inside
    Z-Image's active band [0.42, 0.62], where a linear ramp puts them well outside it."""
    assert _shaped(0.25, 3.0) == pytest.approx(0.4375)  # linear would be 0.25
    assert _shaped(0.75, 3.0) == pytest.approx(0.5625)  # linear would be 0.75
    assert 0.42 <= _shaped(0.25, 3.0) <= 0.62
    assert 0.42 <= _shaped(0.75, 3.0) <= 0.62


def test_shape_below_one_steepens_around_the_midpoint():
    assert _shaped(0.25, 0.5) < 0.25
    assert _shaped(0.75, 0.5) > 0.75


def test_shape_stays_monotonic():
    """A non-monotonic curve would run the fade backwards partway through."""
    for shape in (0.5, 2.0, 3.0):
        prev = -1.0
        for k in range(21):
            w = _shaped(k / 20, shape)
            assert w >= prev
            prev = w


def test_shape_reaches_the_weight_function():
    """A symmetric 1s dissolve at t=0.75 is a quarter of the way through (linear 0.25);
    shape 3 pulls that to 0.4375 — inside the band instead of below it."""
    assert _weight(0.75, 1.0, 0.5, 0.5, 1.0) == pytest.approx(0.25)
    assert _weight(0.75, 1.0, 0.5, 0.5, 3.0) == pytest.approx(0.4375)
    assert _weight(1.25, 1.0, 0.5, 0.5, 1.0) == pytest.approx(0.75)
    assert _weight(1.25, 1.0, 0.5, 0.5, 3.0) == pytest.approx(0.5625)


# --------------------------------------------------------------------------- #
# part_starts (shared with the montage — pinned there too, kept honest here)
# --------------------------------------------------------------------------- #


def test_part_starts_matches_the_montage_rules():
    assert part_starts([6], [1, 1]) == [0, 6]
    assert part_starts([3, 6, 9], [1, 1]) == [0, 3]
    assert part_starts([3, 6, 9], [2, 1, 1]) == [0, 6, 9]
    assert part_starts([3], [2, 1]) == [0]


def test_dream_plan_needs_prompts():
    with pytest.raises(ValueError):
        dream_plan([], [], 4, 4)


def test_scale_curve_is_sampled_per_frame():
    plan = dream_plan([], [{"text": "a"}], 4, 4, seed_mode="fixed", scale=[0.1, 0.2, 0.3, 0.4])
    assert [s["scale"] for s in plan] == [0.1, 0.2, 0.3, 0.4]


def test_scale_defaults_when_unwired():
    plan = dream_plan([], [{"text": "a"}], 4, 2, seed_mode="fixed")
    assert [s["scale"] for s in plan] == [0.7, 0.7]


# --------------------------------------------------------------------------- #
# Lyric-derived cuts — the same shared fixture, read by the frontend twin too
# --------------------------------------------------------------------------- #

LYRIC_CASES = json.loads(
    (Path(__file__).parent / "fixtures" / "cut_schedule_cases.json").read_text()
)["lyricCases"]


@pytest.mark.parametrize("case", LYRIC_CASES, ids=[c["name"][:48] for c in LYRIC_CASES])
def test_lyric_cuts_shared_fixture(case):
    got = lyric_cuts(
        case["lines"],
        case["segStart"],
        case["fps"],
        case["nframes"],
        instrumental=case.get("instrumental", True),
        skip_unaligned=case.get("skipUnaligned", False),
    )
    assert [[f, g] for f, g in got] == [[f, bool(g)] for f, g in case["expect"]]


def test_lyric_cuts_join_the_same_union_as_manual_breakpoints():
    """A lyric cut is just another provenance — it must land in `effective_cuts`."""
    trig = np.zeros(24, np.float32)
    cuts = effective_cuts(trig, {"threshold": 0.5, "hysteresis": 0.1}, 4, 24, lyric=[8, 16])
    assert cuts == [8, 16]


def test_disabled_cuts_silence_a_LYRIC_cut_too():
    """The whole reason lyric cuts go through the union: an unwanted line boundary is
    switched off with the machinery that already exists, not a second mechanism."""
    trig = np.zeros(24, np.float32)
    d = {"threshold": 0.5, "hysteresis": 0.1, "disabledCuts": [2.0]}  # 2.0s @ 4fps = frame 8
    assert effective_cuts(trig, d, 4, 24, lyric=[8, 16]) == [16]


def test_a_song_absolute_line_becomes_a_window_local_frame():
    """The one place the two time bases meet. A line sung at 12s in a window starting at
    10s is 2s in — frame 8 at 4fps, not frame 48."""
    got = lyric_cuts([{"t0": 12.0, "t1": 13.0}], 10.0, 4, 40)
    assert got[0][0] == 8
