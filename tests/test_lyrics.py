"""Lyrics: parsing, forced alignment (pure), ASS overlay, fluid text masks."""
from __future__ import annotations

import json

import numpy as np
import pytest

from kaika.core import recipe as R
from kaika.core.lyrics import (LyricLine, align_lines, align_project_lyrics,
                               build_ass, parse_lrc, parse_plain, text_mask)


def _stream(*phrases, start=10.0, gap=20.0):
    """A synthetic word stream: each phrase's words at 0.4 s intervals."""
    words, t = [], start
    for ph in phrases:
        for w in ph.split():
            words.append((w, t, t + 0.3))
            t += 0.4
        t += gap
    return words


# ---- parsing -----------------------------------------------------------------

def test_parse_lrc_tags_and_meta():
    lines = parse_lrc("[ar:X]\n[00:12.5]Premiere\n[00:15.0][01:02.0]Refrain\n")
    assert [(l.t0, l.text) for l in lines] == [(12.5, "Premiere"),
                                               (15.0, "Refrain"),
                                               (62.0, "Refrain")]
    assert lines[0].t1 == 15.0 and lines[-1].t1 == 66.0


def test_parse_plain_drops_markers():
    assert parse_plain("Hello\n\n[Chorus]\n(x2)\nWorld") == ["Hello", "World"]


# ---- alignment ----------------------------------------------------------------

def test_align_accents_and_fuzzy():
    words = _stream("legere et brulante ce soir tonite")
    out, warn = align_lines(["Légère et brûlante, ce soir tonight !"], words)
    assert len(out) == 1 and out[0].aligned
    assert out[0].t0 == pytest.approx(10.0)
    assert warn == []


def test_align_repeated_chorus_is_monotonic():
    words = _stream("le refrain qui revient", "le refrain qui revient")
    out, _ = align_lines(["Le refrain qui revient",
                          "Le refrain qui revient"], words)
    assert len(out) == 2
    assert out[1].t0 > out[0].t1 - 0.6        # second occurrence, later


def test_align_missing_line_interpolated():
    words = _stream("debut du morceau ici", "la fin du morceau la")
    out, warn = align_lines(["Debut du morceau ici",
                             "Ligne jamais chantee pas la",
                             "La fin du morceau la"], words)
    assert len(out) == 3
    mid = out[1]
    assert not mid.aligned
    assert out[0].t1 <= mid.t0 < mid.t1 <= out[2].t0 + 1e-6
    assert any("interpolated" in w for w in warn)


def test_align_nothing_matches():
    out, warn = align_lines(["totalement different"],
                            _stream("rien a voir ici"))
    assert out == [] and warn


# ---- ASS ----------------------------------------------------------------------

def test_build_ass_positions_color_offset():
    lines = [LyricLine(10.0, 12.0, "Hello"), LyricLine(2.0, 4.0, "Early")]
    cfg = R.LyricsConfig(enabled=True, position="top", color="#FF8000",
                         outline=False)
    ass = build_ass(lines, cfg, offset_s=9.0)
    style = next(l for l in ass.splitlines() if l.startswith("Style:"))
    assert ",&H000080FF," in style          # BGR of #FF8000
    assert ",8," in style                   # top alignment
    assert ",0,0,8," in style               # outline/shadow off
    evs = [l for l in ass.splitlines() if l.startswith("Dialogue:")]
    assert len(evs) == 1                    # "Early" ends before the clip
    assert "0:00:01.00" in evs[0]           # 10.0 - 9.0
    for pos, code in (("bottom", ",2,"), ("lower_third", ",2,"),
                      ("center", ",5,")):
        s = next(l for l in build_ass(lines, R.LyricsConfig(
            position=pos)).splitlines() if l.startswith("Style:"))
        assert code in s


# ---- fluid text mask -----------------------------------------------------------

def test_text_mask_renders_centered():
    m = text_mask("KAIKA", (256, 256), center=(0.5, 0.5), height_frac=0.12)
    assert m.shape == (256, 256) and 0.99 <= m.max() <= 1.0
    ys, xs = np.nonzero(m > 0.3)
    assert abs(xs.mean() - 128) < 12 and abs(ys.mean() - 128) < 12
    assert (m > 0.3).mean() < 0.2           # glyphs, not a blob


def test_text_mask_shrinks_to_fit():
    m = text_mask("UN TRES TRES LONG TEXTE QUI DEPASSE", (128, 128),
                  height_frac=0.4)
    xs = np.nonzero(m > 0.3)[1]
    assert xs.size and xs.min() >= 0 and xs.max() < 128


# ---- the per-run job (lrc fast-path + mocked whisper) --------------------------

def test_align_project_lyrics_lrc(track_wav, tmp_path):
    import shutil
    shutil.copy2(track_wav, tmp_path / "audio.wav")
    (tmp_path / "lyrics.lrc").write_text("[00:01.0]Une ligne\n[00:02.0]Deux")
    (tmp_path / "run.json").write_text("{}")
    n = align_project_lyrics(tmp_path, tmp_path)
    assert n == 2
    data = json.loads((tmp_path / "lyrics.json").read_text())
    assert data[0]["text"] == "Une ligne"
    manifest = json.loads((tmp_path / "run.json").read_text())
    assert manifest["lyrics"]["status"] == "ready"


def test_align_project_lyrics_txt_mocked(track_wav, tmp_path):
    import shutil
    shutil.copy2(track_wav, tmp_path / "audio.wav")
    (tmp_path / "lyrics.txt").write_text("bonjour le monde")
    (tmp_path / "run.json").write_text("{}")
    fake = lambda *a, **k: _stream("bonjour le monde", start=2.0)
    n = align_project_lyrics(tmp_path, tmp_path, transcriber=fake)
    assert n == 1
    line = json.loads((tmp_path / "lyrics.json").read_text())[0]
    assert line["t0"] == pytest.approx(2.0) and line["aligned"]


def test_readability_never_overlaps():
    """Closely-spaced lines must not overlap after the readability pass."""
    words = []
    t = 1.0
    for ph in ("un", "deux", "trois", "quatre"):   # 1 word, 0.3s apart
        words.append((ph, t, t + 0.1)); t += 0.3
    out, _ = align_lines(["un", "deux", "trois", "quatre"], words)
    for a, b in zip(out, out[1:]):
        assert a.t1 <= b.t0 + 1e-9 and a.t1 > a.t0
