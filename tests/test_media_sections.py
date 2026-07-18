"""YouTube section downloads: user-typed timestamps → yt-dlp --download-sections flags.
Pure helpers only — yt-dlp itself is never run here."""

import pytest

from backend.media import parse_timestamp, _section_flags
from backend.routes.uploads import _clip_bounds


def test_parse_timestamp_formats():
    assert parse_timestamp("45") == 45.0
    assert parse_timestamp("2:05") == 125.0
    assert parse_timestamp("1:02:03") == 3723.0
    assert parse_timestamp(" 0:30.5 ") == 30.5  # fractions + whitespace


@pytest.mark.parametrize("bad", ["", "  ", "1:2:3:4", "1:", ":30", "abc", "-5", "1:75", "2:60:00"])
def test_parse_timestamp_rejects_garbage(bad):
    with pytest.raises(RuntimeError, match="timestamp"):
        parse_timestamp(bad)


def test_parse_timestamp_overflow_says_what_is_wrong():
    # '00:12:60' is the right FORMAT with an out-of-range value — the message must
    # name the actual problem, not re-explain the format.
    with pytest.raises(RuntimeError, match="below 60"):
        parse_timestamp("00:12:60")


def test_section_flags_shapes():
    # No bounds → no flags (the whole stream, exactly as before).
    assert _section_flags(None, None, precise_cuts=True) == []
    # Video gets keyframe-precise cuts (re-encode); audio doesn't (no re-encode).
    assert _section_flags(10.0, 30.0, precise_cuts=True) == [
        "--download-sections", "*10.0-30.0", "--force-keyframes-at-cuts",
    ]
    assert _section_flags(10.0, 30.0, precise_cuts=False) == ["--download-sections", "*10.0-30.0"]
    # Open-ended bounds.
    assert _section_flags(None, 20.0, precise_cuts=False) == ["--download-sections", "*0.0-20.0"]
    assert _section_flags(90.0, None, precise_cuts=False) == ["--download-sections", "*90.0-inf"]


def test_section_flags_rejects_empty_range():
    with pytest.raises(RuntimeError, match="after start"):
        _section_flags(30.0, 30.0, precise_cuts=False)


def test_clip_bounds_parses_and_validates():
    assert _clip_bounds(None, None) == (None, None)
    assert _clip_bounds(" ", "") == (None, None)
    assert _clip_bounds("1:00", "1:30") == (60.0, 90.0)
    assert _clip_bounds("", "0:20") == (None, 20.0)  # end-only: from the top
    with pytest.raises(RuntimeError, match="after start"):
        _clip_bounds("2:00", "1:00")
