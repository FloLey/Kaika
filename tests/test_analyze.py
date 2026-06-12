"""Phase 1: E1 audio analysis."""
from __future__ import annotations

from kaika.core.analyze import analyze
from kaika.core.score import Score


def test_frame_count_matches_fps(track_wav):
    fps = 24
    score = analyze(track_wav, fps=fps)
    expected = score.audio.duration_s * fps
    # one row per video frame, within a couple of frames of duration*fps
    assert abs(score.n_frames - expected) <= 3
    assert score.audio.hop_length == round(score.audio.sr / fps)


def test_tempo_detected(track_wav):
    score = analyze(track_wav, fps=24)
    # beat tracking can land on an octave; accept 120 or its common multiples
    assert any(abs(score.tempo_bpm - t) < 6 for t in (60, 120, 240))
    assert len(score.beats) >= 4


def test_low_onsets_present(track_wav):
    score = analyze(track_wav, fps=24)
    # kicks every 0.5s over 4s -> several low-band onsets
    assert len(score.onsets["low"]) >= 4
    assert all(0.0 <= e.mag <= 1.0 for e in score.onsets["low"])


def test_onsets_are_precise_not_noisy(track_wav):
    """HPSS + strict peak picking: counts must stay near the real event counts
    (8 kicks, 8 hats), not balloon — every onset spawns a visual source."""
    score = analyze(track_wav, fps=24)
    assert len(score.onsets["low"]) <= 14      # was 23 before HPSS
    assert 5 <= len(score.onsets["high"]) <= 12
    # mid-track kicks land on the beat grid (±1 frame)
    times = [e.t for e in score.onsets["low"]]
    for expected in (0.5, 1.0, 1.5, 2.0, 2.5):
        assert any(abs(t - expected) < 0.06 for t in times), expected


def test_bands_normalised(track_wav):
    score = analyze(track_wav, fps=24)
    for f in score.frames:
        assert abs(sum(f.bands) - 1.0) < 1e-3 or sum(f.bands) == 0.0
        assert 0.0 <= f.rms <= 1.0


def test_sections_cover_track(track_wav):
    score = analyze(track_wav, fps=24)
    assert len(score.sections) >= 2
    assert score.sections[0].start == 0.0
    assert abs(score.sections[-1].end - score.audio.duration_s) < 0.1
    # sections are contiguous
    for a, b in zip(score.sections, score.sections[1:]):
        assert abs(a.end - b.start) < 1e-6


def test_json_roundtrip(track_wav, tmp_path):
    score = analyze(track_wav, fps=24)
    p = tmp_path / "score.json"
    score.to_json(p)
    again = Score.from_json(p)
    assert again.tempo_bpm == score.tempo_bpm
    assert again.n_frames == score.n_frames
    assert again.sections[0].label == score.sections[0].label


def test_analyze_cached_roundtrip(track_wav, tmp_path):
    """Second call with the same content + params hits the cache and returns
    an identical score; the cache file is keyed on content, not filename."""
    from kaika.core.analyze import analyze_cached
    import shutil
    cache = tmp_path / "cache"
    s1 = analyze_cached(track_wav, cache, fps=24)
    files = list(cache.glob("*.json"))
    assert len(files) == 1
    # Same bytes under another name -> same cache entry, equal result.
    copy = tmp_path / "renamed.wav"
    shutil.copy2(track_wav, copy)
    s2 = analyze_cached(copy, cache, fps=24)
    assert len(list(cache.glob("*.json"))) == 1
    assert s2.to_dict() == s1.to_dict()
    # Different params -> a distinct entry.
    analyze_cached(track_wav, cache, fps=30)
    assert len(list(cache.glob("*.json"))) == 2


# ---- lyrics-informed analysis ------------------------------------------------

def test_lyric_boundaries_and_labels():
    from kaika.core.analyze import (_lyric_boundaries, _label_sections,
                                    _merge_boundaries)
    lines = [{"t0": 2, "t1": 5, "text": "na na hey"},
             {"t0": 35, "t1": 38, "text": "couplet unique"},
             {"t0": 65, "t1": 68, "text": "na na hey"}]
    # instrumental gaps (5->35, 38->65) become boundaries; intro before 2s
    cuts = _lyric_boundaries(lines, 72)
    assert len(cuts) == 2          # two big gaps (first line at 2s, no intro)
    merged = _merge_boundaries([0, 40, 72], cuts, 72)
    assert merged[0] == 0.0 and merged[-1] == 72
    secs = _label_sections([0, 20, 50, 72], 72, [0.3, 0.5, 0.7], lines)
    labels = [s.label for s in secs]
    assert labels.count("chorus") == 2     # repeated "na na hey"
    assert "verse" in labels


def test_voiced_array_and_voice_signal(track_wav):
    from kaika.core.analyze import analyze
    from kaika.core import simulate as S
    lines = [{"t0": 0.3, "t1": 0.8, "text": "hello"}]
    score = analyze(track_wav, fps=24, lyric_lines=lines)
    assert any(f.voiced > 0 for f in score.frames)
    sig = S._signal_array(score, "voice", score.n_frames)
    assert sig.max() == 1.0 and sig[5:20].sum() > 0   # voiced ~0.3-0.8s
    # no lyrics -> proxy, still 0..1
    plain = analyze(track_wav, fps=24)
    assert all(f.voiced == 0 for f in plain.frames)
    sig2 = S._signal_array(plain, "voice", plain.n_frames)
    assert 0.0 <= sig2.max() <= 1.0


def test_analyze_cached_keys_on_lyrics(track_wav, tmp_path):
    from kaika.core.analyze import analyze_cached
    cache = tmp_path / "c"
    analyze_cached(track_wav, cache, fps=24)
    analyze_cached(track_wav, cache, fps=24,
                   lyric_lines=[{"t0": 1, "t1": 2, "text": "x"}])
    assert len(list(cache.glob("*.json"))) == 2     # distinct cache entries
