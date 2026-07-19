"""Characterization tests for `backend/segment.py`'s pure helpers.

segment.py is the largest untested module in the repo (420 statements, 13% covered) and
it drives the whole Review stage: lyric parsing and alignment, the beat grid, boundary
proposal, and section labelling. Everything below is a PURE function — no audio, no
Whisper, no LLM — so covering it needs no fixtures and runs in milliseconds. The
audio-dependent half (`load_audio`, `transcribe_words`, `_beat_grid`,
`_cluster_boundaries`, `propose_segments`) is still uncovered and wants real fixtures.

These are CHARACTERIZATION tests: they pin what the code does today so a future change
has to be deliberate. Where current behaviour looks arguable it is called out in the test
rather than quietly asserted as correct.
"""

from __future__ import annotations

import pytest

from backend import segment as S

# ---- lyric parsing -----------------------------------------------------------


def test_parse_plain_drops_blanks_section_marks_and_asides():
    text = """
    [Chorus]

    Les avions dessinent (ooh) dans le ciel
    Et moi je reste ici

    [Verse 2]
    Le temps passe
    """
    assert S.parse_plain(text) == [
        "Les avions dessinent dans le ciel",
        "Et moi je reste ici",
        "Le temps passe",
    ]


def test_parse_plain_drops_the_genius_trailer_and_everything_after_it():
    """The "You might also like" block is scraped junk — it and its trailing lines go,
    until the next section marker resets the state."""
    text = "real line\nYou might also like\nsome junk\nmore junk\n[Verse]\nback to lyrics"
    assert S.parse_plain(text) == ["real line", "back to lyrics"]


def test_parse_plain_collapses_the_double_spaces_an_aside_leaves_behind():
    assert S.parse_plain("a  (x)  b") == ["a b"]


def test_parse_lrc_derives_each_end_from_the_next_start():
    lrc = "[00:01.00]first\n[00:04.50]second\n[00:09.00]third"
    lines = S.parse_lrc(lrc)
    assert [(l.t0, l.t1, l.text) for l in lines] == [
        (1.0, 4.5, "first"),
        (4.5, 9.0, "second"),
        (9.0, 13.0, "third"),  # the last line gets a flat +4 s
    ]


def test_parse_lrc_expands_a_repeated_timestamp_line():
    """`[00:01.00][00:30.00]chorus` is one line sung twice — LRC's way of not repeating
    the text. Both instances must appear, in time order."""
    lines = S.parse_lrc("[00:30.00][00:01.00]chorus")
    assert [(l.t0, l.text) for l in lines] == [(1.0, "chorus"), (30.0, "chorus")]


def test_parse_lrc_skips_metadata_and_bodyless_tags():
    lines = S.parse_lrc("[ar:Someone]\n[ti:A Song]\n[00:02.00]\n[00:03.00]real")
    assert [l.text for l in lines] == ["real"]


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Café", "cafe"),  # accents stripped via NFKD
        ("DON'T", "dont"),  # punctuation dropped
        ("Hello, World!", "helloworld"),
        ("naïve—dash", "naivedash"),
        ("123abc", "123abc"),
        ("", ""),
    ],
)
def test_norm_reduces_a_token_to_comparable_letters(raw, expected):
    assert S._norm(raw) == expected


# ---- boundary proposal -------------------------------------------------------


def _line(t0, t1):
    return {"t0": t0, "t1": t1, "text": "x"}


def test_gap_boundaries_cuts_at_the_first_start_last_end_and_long_gaps():
    duration = 100.0
    lines = [_line(20.0, 25.0), _line(26.0, 30.0), _line(60.0, 65.0)]
    cuts = S._gap_boundaries(lines, duration)
    # 20.0: the first line starts well after 0. 45.0: midpoint of the 30->60 gap.
    # 65.0: the last line ends well before the end. The 25->26 gap is too short.
    assert cuts == [20.0, 45.0, 65.0]


def test_gap_boundaries_ignores_a_lead_in_shorter_than_the_gap_threshold():
    lines = [_line(S.GAP_S - 0.1, 10.0)]
    assert S._gap_boundaries(lines, 200.0)[0] != lines[0]["t0"]


def test_gap_boundaries_sorts_unordered_input():
    lines = [_line(60.0, 65.0), _line(20.0, 25.0)]
    assert S._gap_boundaries(lines, 100.0) == S._gap_boundaries(list(reversed(lines)), 100.0)


def test_gap_boundaries_of_nothing_is_nothing():
    assert S._gap_boundaries([], 100.0) == []


def test_merge_boundaries_always_brackets_the_track():
    assert S._merge_boundaries([], [], 90.0) == [0.0, 90.0]


def test_merge_boundaries_lets_primary_cuts_win_over_nearby_cluster_cuts():
    """Primary cuts reflect real structure (lyrics/vocal activity); a clustering cut
    within min_gap of one is the same boundary found twice, so it is dropped."""
    kept = S._merge_boundaries(cluster_t=[31.0], primary_t=[30.0], duration=120.0, min_gap=6.0)
    assert kept == [0.0, 30.0, 120.0]


def test_merge_boundaries_keeps_a_cluster_cut_that_stands_alone():
    kept = S._merge_boundaries(cluster_t=[60.0], primary_t=[30.0], duration=120.0, min_gap=6.0)
    assert kept == [0.0, 30.0, 60.0, 120.0]


def test_merge_boundaries_drops_cuts_crowding_the_track_ends():
    kept = S._merge_boundaries([], [2.0, 118.0], duration=120.0, min_gap=6.0)
    assert kept == [0.0, 120.0]


def test_merge_boundaries_ignores_cuts_outside_the_track():
    assert S._merge_boundaries([], [-5.0, 200.0], duration=120.0) == [0.0, 120.0]


# ---- beat snapping -----------------------------------------------------------

DOWNBEATS = [0.0, 8.0, 16.0, 24.0]
BEATS = [float(b) for b in range(0, 26, 2)]


def test_snap_prefers_a_downbeat_inside_the_window():
    assert S._snap(16.4, DOWNBEATS, BEATS, window=1.5) == 16.0


def test_snap_falls_back_to_a_beat_at_half_the_window():
    """No downbeat within 1.5 s of 10.3, but beat 10.0 is within 0.75."""
    assert S._snap(10.3, DOWNBEATS, BEATS, window=1.5) == 10.0


def test_snap_leaves_a_time_alone_when_nothing_is_close_enough():
    """Beat 10.0 is 0.9 s away — outside the 0.75 s beat window — so no snap."""
    assert S._snap(10.9, DOWNBEATS, BEATS, window=1.5) == 10.9


def test_snap_picks_the_nearest_of_several_candidates():
    assert S._snap(7.9, DOWNBEATS, BEATS, window=5.0) == 8.0


def test_snap_bounds_keeps_the_track_ends_exact():
    """The first and last boundary are the track edges — snapping them inward would
    drop audio from the first or last segment."""
    snapped = S._snap_bounds([0.0, 9.1, 24.0], DOWNBEATS, BEATS, duration=24.0)
    assert snapped[0] == 0.0 and snapped[-1] == 24.0
    assert snapped[1] == 8.0  # the interior cut did snap to a downbeat


def test_snap_bounds_never_returns_duplicates_or_goes_backwards():
    """Two nearby cuts can snap onto the SAME downbeat; a zero-length segment would
    follow. Whatever the dedup rule, the result must stay strictly increasing."""
    snapped = S._snap_bounds([0.0, 7.9, 8.2, 24.0], DOWNBEATS, BEATS, duration=24.0)
    assert snapped == sorted(snapped)
    assert len(snapped) == len(set(snapped))


# ---- section labelling -------------------------------------------------------


def _ln(t0, t1, text):
    return {"t0": t0, "t1": t1, "text": text}


def test_lyric_signature_uses_the_line_midpoint_to_decide_membership():
    """A line straddling a boundary belongs to the section its MIDDLE falls in — so a
    chorus that starts a beat early still signs as one block."""
    lines = [_ln(8.0, 12.0, "inside"), _ln(18.0, 30.0, "straddles out")]
    assert S._lyric_signature(lines, 0.0, 20.0) == "inside"


def test_lyric_signature_normalises_case_and_punctuation():
    lines = [_ln(1.0, 2.0, "Don't STOP, now!")]
    assert S._lyric_signature(lines, 0.0, 10.0) == "dont stop now"


def test_label_sections_calls_a_repeated_block_a_chorus_and_a_unique_one_a_verse():
    bounds = [0.0, 10.0, 20.0, 30.0, 40.0]
    lines = [
        _ln(1.0, 9.0, "hook hook"),  # repeats
        _ln(11.0, 19.0, "story one"),
        _ln(21.0, 29.0, "hook hook"),  # same signature -> chorus
        _ln(31.0, 39.0, "story two"),
    ]
    labels = [s["label"] for s in S._label_sections(bounds, 40.0, [0.5] * 4, lines)]
    assert labels == ["chorus", "verse", "chorus", "verse"]


def test_label_sections_falls_back_to_energy_when_a_section_is_instrumental():
    """No lyrics anywhere: the edges are intro/outro and the middle is graded by
    NORMALISED energy — 0.66+ is a drop, 0.33+ a build, below that a verse."""
    bounds = [0.0, 10.0, 20.0, 30.0, 40.0, 50.0]
    labels = [s["label"] for s in S._label_sections(bounds, 50.0, [0.0, 1.0, 5.0, 10.0, 2.0])]
    assert labels[0] == "intro" and labels[-1] == "outro"
    assert labels[1:-1] == ["verse", "build", "drop"]


def test_label_sections_reports_energy_normalised_against_the_PEAK():
    """`config.normalise` is x / max(x), not a min-max rescale — so the quietest section
    of a track keeps a non-zero energy unless it is actually silent. That matters for the
    0.33 / 0.66 label thresholds: on a track with a narrow dynamic range every middle
    section can land in "drop", which is current behaviour, not a bug I am papering over.
    """
    out = S._label_sections([0.0, 10.0, 20.0], 20.0, [5.0, 15.0])
    assert [s["energy"] for s in out] == [0.333, 1.0]  # 5/15, 15/15

    loud = S._label_sections([0.0, 10.0, 20.0, 30.0], 30.0, [9.0, 10.0, 10.0])
    assert [s["label"] for s in loud] == ["intro", "drop", "outro"]


def test_label_sections_survives_having_no_energies_at_all():
    out = S._label_sections([0.0, 10.0, 20.0], 20.0, [])
    assert [s["label"] for s in out] == ["intro", "outro"]


def test_attach_lyrics_puts_a_line_in_the_bar_it_starts_in():
    bars = [{"lyric": ""} for _ in range(3)]
    downbeats = [0.0, 4.0, 8.0]

    class L:
        def __init__(self, t0, text):
            self.t0, self.text = t0, text

    S._attach_lyrics(bars, downbeats, 12.0, [L(0.5, "one"), L(4.2, "two"), L(5.0, "three")])
    assert [b["lyric"] for b in bars] == ["one", "two three", ""]


def test_attach_lyrics_ignores_unaligned_lines():
    """`_resolve_lines` returns a None slot per line it could not place; those must not
    crash the walk."""
    bars = [{"lyric": ""}]
    S._attach_lyrics(bars, [0.0], 4.0, [None])
    assert bars[0]["lyric"] == ""


def test_sections_from_bars_maps_bar_indices_onto_downbeat_times():
    downbeats = [0.0, 4.0, 8.0, 12.0, 16.0]
    secs = [{"label": "intro", "start_bar": 0}, {"label": "verse", "start_bar": 2}]
    out = S._sections_from_bars(secs, downbeats, 20.0)
    assert out == [
        {"start": 0.0, "end": 8.0, "label": "intro"},
        {"start": 8.0, "end": 20.0, "label": "verse"},
    ]


def test_sections_from_bars_always_spans_the_whole_track():
    """Whatever the LLM returned, the first section starts at 0 and the last ends at the
    track end — a gap here would leave audio in no segment at all."""
    downbeats = [0.0, 4.0, 8.0]
    out = S._sections_from_bars([{"label": "a", "start_bar": 1}], downbeats, 20.0)
    assert out[0]["start"] == 0.0 and out[-1]["end"] == 20.0


def test_sections_from_bars_drops_a_degenerate_section():
    """Two labels on the same bar would produce a zero-length segment."""
    downbeats = [0.0, 4.0, 8.0]
    secs = [
        {"label": "a", "start_bar": 0},
        {"label": "b", "start_bar": 1},
        {"label": "c", "start_bar": 1},
    ]
    out = S._sections_from_bars(secs, downbeats, 12.0)
    assert all(s["end"] - s["start"] >= 0.5 for s in out)
