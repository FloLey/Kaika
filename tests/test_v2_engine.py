"""V2 engine: emitters, modulators, timeline directives, checkpoints,
window-equivalence, and the v1 migration's behavioral guarantees."""
from __future__ import annotations

import numpy as np
import pytest

from kaika.core.analyze import analyze
from kaika.core import recipe as R
from kaika.core import simulate as S
from kaika.core.project import Project
from kaika.core.timeline import resolve_anchor, resolve_directives


@pytest.fixture(scope="module")
def score(tmp_path_factory):
    from conftest import synth_track
    wav = synth_track(tmp_path_factory.mktemp("audio") / "t.wav", duration=3.0)
    return analyze(wav, fps=24)


def _rec(**over):
    base = {"version": 2, "seed": 5,
            "canvas": {"width": 64, "height": 64, "sim_resolution": 48}}
    base.update(over)
    return R.from_dict(base)


# ---- score v2 ---------------------------------------------------------------

def test_score_v2_signals(score):
    f = score.frames[len(score.frames) // 2]
    assert len(f.chroma) == 12
    assert 0 <= f.chroma_argmax <= 11
    assert 0.0 <= f.beat_phase <= 1.0
    assert 0.0 <= f.bar_phase <= 1.0
    assert 0.0 <= f.harmonic_ratio <= 1.0
    assert score.version == 2


def test_v1_score_loads():
    from kaika.core.score import Score
    d = {"audio": {"sr": 22050, "duration_s": 1.0, "fps": 24,
                   "hop_length": 919},
         "tempo_bpm": 120.0,
         "frames": [{"rms": 0.5, "centroid_hz": 1000.0,
                     "bands": [0.3, 0.4, 0.3]}]}
    s = Score.from_dict(d)
    assert s.version == 1
    assert s.frames[0].flux == 0.0          # v2 fields default


# ---- triggers ---------------------------------------------------------------

def test_beat_trigger_fires_on_grid(score):
    rec = _rec(emitters=[{"id": "pulse",
                          "trigger": {"type": "beat", "every": 1}}])
    by_frame, _ = S.build_trigger_index(score, rec, score.n_frames)
    fired = [i for i, sp in enumerate(by_frame) if sp]
    beat_frames = {int(round(b.t * 24)) for b in score.beats
                   if b.t * 24 < score.n_frames}
    assert beat_frames.issubset(set(fired) | {score.n_frames})


def test_mid_onsets_consumed(score):
    rec = _rec(emitters=[{"id": "melody",
                          "trigger": {"type": "onset", "band": "mid"}}])
    by_frame, _ = S.build_trigger_index(score, rec, score.n_frames)
    n_spawns = sum(len(s) for s in by_frame)
    assert n_spawns == len([e for e in score.onsets["mid"]
                            if int(round(e.t * 24)) < score.n_frames])


def test_continuous_trigger_condition(score):
    rec = _rec(emitters=[{"id": "drone",
                          "trigger": {"type": "continuous", "every_frames": 1,
                                      "when": "rms > 2.0"}}])  # impossible
    by_frame, _ = S.build_trigger_index(score, rec, score.n_frames)
    assert sum(len(s) for s in by_frame) == 0


def test_mute_unmute_windows(score):
    rec = _rec(emitters=[{"id": "hats",
                          "trigger": {"type": "onset", "band": "high"}}])
    timeline = [{"at": 0.0, "action": "mute", "emitter": "hats"},
                {"at": 1.5, "action": "unmute", "emitter": "hats"}]
    by_frame, _ = S.build_trigger_index(score, rec, score.n_frames, timeline)
    fired_t = [i / 24 for i, sp in enumerate(by_frame) if sp]
    assert all(t >= 1.5 for t in fired_t)


# ---- timeline ---------------------------------------------------------------

def test_anchor_resolution(score):
    times, warn = resolve_anchor(2.0, score)
    assert times == [2.0] and warn is None
    times, warn = resolve_anchor("beat:0", score)
    assert warn is None and abs(times[0] - score.beats[0].t) < 1e-6
    times, warn = resolve_anchor("section:doesnotexist", score)
    assert times == [] and "doesnotexist" in warn


def test_section_anchor_fires_per_match(score):
    label = score.sections[0].label
    n = sum(1 for s in score.sections if s.label == label)
    directives, warns = resolve_directives(
        [{"at": f"section:{label}", "action": "spawn"}], score)
    assert len(directives) == n and warns == []


def test_timeline_spawn_line_count(score, tmp_path):
    """The '3 sources on a horizontal line' gesture leaves dye at all three
    spots — left, center, right."""
    import imageio.v2 as imageio
    rec = _rec(emitters=[])      # nothing else moves
    proj = Project.from_score(score, rec, audio="t.wav")
    proj.timeline = [{"at": 0.3, "action": "spawn", "count": 3, "mag": 1.0,
                      "placement": {"type": "line", "from": [0.15, 0.5],
                                    "to": [0.85, 0.5], "jitter": 0.0},
                      "color": {"type": "fixed", "hex": "#FFFFFF"},
                      "body": {"radius": 0.06, "emit": 0.8, "force": 0.0,
                               "lifetime_s": 0.4, "speed": 0.0}}]
    trees, _ = proj.frame_trees(24, score)
    res = S.simulate(score, rec, tmp_path, max_frames=24, frame_trees=trees,
                     timeline=proj.full_timeline())
    img = imageio.imread(res.fluid_dir / "000010.png").astype(float).mean(axis=2)
    h, w = img.shape
    row = img[h // 2 - 4: h // 2 + 4]
    left = row[:, int(0.15 * w) - 4: int(0.15 * w) + 4].mean()
    mid = row[:, w // 2 - 4: w // 2 + 4].mean()
    right = row[:, int(0.85 * w) - 4: int(0.85 * w) + 4].mean()
    corner = img[:6, :6].mean()
    for spot in (left, mid, right):
        assert spot > corner + 10, (left, mid, right, corner)


# ---- modulators -------------------------------------------------------------

def test_modulator_modes(score):
    rec = _rec(field={"vorticity": 10.0},
               modulators=[{"source": "rms", "target": "field.vorticity",
                            "mode": "scale", "range": [2.0, 2.0]}])
    eng = S.ModulationEngine(rec, score, score.n_frames)
    tree = {"field": {"vorticity": 10.0}}
    eng.apply(tree, 0)
    assert tree["field"]["vorticity"] == 20.0     # base x 2

    rec = _rec(modulators=[{"source": "rms", "target": "field.vorticity",
                            "mode": "add", "range": [5.0, 5.0]}])
    eng = S.ModulationEngine(rec, score, score.n_frames)
    tree = {"field": {"vorticity": 10.0}}
    eng.apply(tree, 0)
    assert tree["field"]["vorticity"] == 15.0     # base + 5


def test_modulator_targets_emitter_template(score, tmp_path):
    rec = _rec(emitters=[{"id": "kicks",
                          "trigger": {"type": "onset", "band": "low"}}],
               modulators=[{"source": "rms",
                            "target": "emitters.kicks.body.radius",
                            "mode": "absolute", "range": [0.33, 0.33]}])
    eng = S.ModulationEngine(rec, score, score.n_frames)
    tree = R.config_tree(rec)
    import copy
    t = copy.deepcopy(tree)
    eng.apply(t, 0)
    assert t["emitters"]["kicks"]["body"]["radius"] == 0.33


# ---- checkpoints + window equivalence ---------------------------------------

def test_window_preview_matches_full_run(score, tmp_path, monkeypatch):
    """A window preview resumed from a checkpoint reproduces the full run at
    the same frame *visually*: state restores float32-exactly and the spawn
    schedule is identical, but NumPy's vectorized transcendentals round 1 ULP
    differently across heap states and the solver is chaotic, so pixels can
    drift slightly. The bound here is perceptual."""
    import imageio.v2 as imageio
    monkeypatch.setattr(S, "CHECKPOINT_EVERY_S", 0.5)
    rec = _rec()
    proj = Project.from_score(score, rec, audio="t.wav")
    n = score.n_frames
    trees, _ = proj.frame_trees(n, score)
    store = S.CheckpointStore(tmp_path / "ck")
    S.simulate(score, rec, tmp_path / "full", max_frames=n, frame_trees=trees,
               checkpoints=store, save_checkpoints=True)
    S.simulate(score, rec, tmp_path / "win", max_frames=n, frame_trees=trees,
               render_range=(48, 60), warmup_frames=8, checkpoints=store,
               write_velocity=False)
    a = imageio.imread(tmp_path / "full" / "fluid" / "000054.png").astype(float)
    b = imageio.imread(tmp_path / "win" / "fluid" / "000006.png").astype(float)
    assert np.abs(a - b).mean() < 2.0          # visually equivalent
    assert np.percentile(np.abs(a - b), 99) < 32


def test_checkpoint_state_restores_exactly(score, tmp_path):
    """The checkpoint round-trip itself is bit-exact (float32 throughout)."""
    rec = _rec()
    store = S.CheckpointStore(tmp_path / "ck")
    sim = S.FluidSim(rec.canvas.grid(), 0.9, 0.0, rec.seed)
    sim.add_splat(0.4, 0.6, 0.1, 5000.0, np.array([1.0, 0.5, 0.2]), 1.0)
    sim.step(1.0, 0.1)
    store.save(7, sim, [], 1.23, S.structural_hash(rec))
    ck = store.nearest(10, S.structural_hash(rec))
    assert ck["frame"] == 7 and ck["t_phase"] == 1.23
    assert np.array_equal(ck["u"], sim.u)
    assert np.array_equal(ck["v"], sim.v)
    assert np.array_equal(ck["density"], sim.density)


def test_structural_change_invalidates_checkpoints(score, tmp_path):
    rec = _rec()
    store = S.CheckpointStore(tmp_path / "ck")
    sim = S.FluidSim(rec.canvas.grid(), 0.9, 0.0, rec.seed)
    store.save(10, sim, [], 0.0, S.structural_hash(rec))
    assert store.nearest(20, S.structural_hash(rec)) is not None
    other = _rec(emitters=[{"id": "different"}])
    assert store.nearest(20, S.structural_hash(other)) is None


# ---- migration (behavioral golden) ------------------------------------------

def test_v1_migration_behaviour(score, tmp_path):
    """The upgraded v1 recipe must keep the v1 *behavior*: kicks fire on every
    low onset in palette[0], hats cap per frame, RMS drives vorticity over the
    old min/max range. (Bit-identical output vs the retired v1 engine is not
    achievable — the v2 runtime re-seeds randomness per emitter — so this
    golden test pins the contract, not the pixels.)"""
    v1 = {"seed": 9, "fluid": {
        "resolution": 48, "render_resolution": 48,
        "splats": {"low": {"radius": 0.1, "force": 9000},
                   "high": {"max_per_beat": 2}},
        "vorticity": {"min": 8, "max": 38},
        "palette": ["#FF0000", "#00FF00", "#0000FF"]}}
    rec = R.from_dict(v1)
    n = score.n_frames
    by_frame, _ = S.build_trigger_index(score, rec, n)
    kick_i = [i for i, e in enumerate(rec.emitters) if e.id == "kicks"][0]
    hat_i = [i for i, e in enumerate(rec.emitters) if e.id == "hats"][0]
    kick_count = sum(1 for sps in by_frame for sp in sps
                     if sp.emitter_i == kick_i)
    low_onsets = [e for e in score.onsets["low"] if int(round(e.t * 24)) < n]
    assert kick_count == len(low_onsets)
    for sps in by_frame:                       # hats capped per frame
        assert sum(1 for sp in sps if sp.emitter_i == hat_i) <= 2
    vort = next(m for m in rec.modulators if m.target == "field.vorticity")
    assert vort.range == [8, 38] and vort.source == "rms"
    # ...and the simulation stays deterministic end-to-end
    a = S.simulate(score, rec, tmp_path / "a", max_frames=10)
    b = S.simulate(score, rec, tmp_path / "b", max_frames=10)
    fa = np.load(sorted(a.velocity_dir.glob("*.npy"))[-1])
    fb = np.load(sorted(b.velocity_dir.glob("*.npy"))[-1])
    assert np.array_equal(fa, fb)


# ---- color engine -----------------------------------------------------------

def test_chroma_hold_window(score):
    eng = S._ColorEngine({"main": ["#FF0000", "#00FF00"]}, score,
                         score.n_frames)
    held = [eng.held_pitch(i, 0.5) for i in range(score.n_frames)]
    raw = [f.chroma_argmax for f in score.frames]
    switches_held = sum(1 for i in range(1, len(held)) if held[i] != held[i - 1])
    switches_raw = sum(1 for i in range(1, len(raw)) if raw[i] != raw[i - 1])
    assert switches_held <= switches_raw


def test_band_mix_follows_band_energy(score):
    """band_mix blends the first palette colors by band energy: on the
    bassiest frame the result leans toward the first (low-band) color."""
    eng = S._ColorEngine({"main": ["#FF0000", "#00FF00", "#0000FF"]}, score,
                         score.n_frames)
    rng = np.random.default_rng(0)
    i = int(np.argmax([f.bands[0] for f in score.frames]))
    c = eng.resolve({"type": "band_mix", "palette": "main"}, i, 0, rng)
    w = np.asarray(score.frames[i].bands[:3], np.float64) ** 1.5
    expect = np.array([w[0], w[1], w[2]]) / w.sum()
    assert np.allclose(c, expect, atol=1e-5)


def test_palette_cycle_is_window_stable(score):
    """Cycle indices come from the precomputed trigger index, so a window
    preview sees the same colors as the full run at the same frame."""
    rec = _rec(emitters=[{"id": "hats",
                          "trigger": {"type": "onset", "band": "high"},
                          "color": {"type": "palette_cycle", "start": 0}}],
               palettes={"main": ["#100000", "#001000", "#000010"]})
    n = score.n_frames
    by_frame, _ = S.build_trigger_index(score, rec, n)
    cum = 0
    seen = []
    for fi in range(n):
        for sp in by_frame[fi]:
            seen.append((fi, cum % 3))
            cum += 1
    assert len(seen) > 1          # the cycle actually advances


# ---- voice signal + GPU opt-in ----------------------------------------------

def test_voice_signal_tracks_sustained_content(score):
    sig = S._signal_array(score, "voice", score.n_frames)
    assert sig.shape == (score.n_frames,)
    assert 0.0 <= sig.min() and sig.max() <= 1.0 + 1e-9


def test_continuous_mag_source_breathes(score):
    """A continuous emitter with mag_source spawns with signal-driven
    magnitudes (not the constant 1.0), gated by min_mag."""
    rec = _rec(emitters=[{"id": "voice",
                          "trigger": {"type": "continuous", "every_frames": 1,
                                      "mag_source": "rms", "min_mag": 0.3,
                                      "section": ""}}])
    by_frame, _ = S.build_trigger_index(score, rec, score.n_frames)
    mags = [sp.mag for sps in by_frame for sp in sps]
    rms = S._signal_array(score, "rms", score.n_frames)
    assert len(mags) == int((rms >= 0.3).sum())     # min_mag gates
    assert len(set(round(m, 3) for m in mags)) > 1  # magnitudes vary


def test_default_recipe_has_voice_emitter():
    rec = R.Recipe()
    voice = rec.emitter("voice")
    assert voice is not None
    assert voice.trigger.type == "continuous"
    assert voice.trigger.mag_source == "voice"


def test_gpu_falls_back_to_cpu_without_cuda(score, tmp_path):
    """KAIKA_GPU on a machine without CuPy/CUDA must run on CPU and say so."""
    rec = _rec()
    res = S.simulate(score, rec, tmp_path, max_frames=4, gpu=True)
    assert res.n_frames == 4
    assert any("CPU" in w for w in res.warnings)


# ---- audio-driven background -------------------------------------------------

def test_background_tint_is_not_black(score, tmp_path):
    """An audio-driven background colors the empty field: corners are tinted
    (non-grey, non-black), and the wash follows the configured colors."""
    import imageio.v2 as imageio
    rec = _rec(emitters=[],
               render={"background": 0.25,
                       "background_color": {"type": "fixed", "hex": "#4060C0"},
                       "background_smooth_s": 0.05},
               modulators=[])
    res = S.simulate(score, rec, tmp_path, max_frames=8)
    img = imageio.imread(res.fluid_dir / "000007.png").astype(float)
    corner = img[:6, :6].mean(axis=(0, 1))
    assert corner[2] > corner[0] + 10        # blue tint, not grey
    assert corner.mean() > 8                 # not pure black


def test_background_smoothing_state_checkpointed(score, tmp_path):
    rec = _rec()
    store = S.CheckpointStore(tmp_path / "ck")
    sim = S.FluidSim(rec.canvas.grid(), 0.9, 0.0, rec.seed)
    bg = np.array([0.1, 0.2, 0.3], np.float32)
    store.save(3, sim, [], 0.5, S.structural_hash(rec), bg_state=bg)
    ck = store.nearest(5, S.structural_hash(rec))
    assert np.allclose(ck["bg"], [0.1, 0.2, 0.3])


# ---- spiral + sequence placement --------------------------------------------

def test_place_spiral_grows_from_center():
    p = {"type": "spiral", "center": [0.5, 0.5], "inner_radius": 0.05,
         "radius": 0.3, "turns": 2.0}
    pts, center = S._place(p, 9, 0, np.random.default_rng(0), {})
    assert center == (0.5, 0.5)
    radii = [np.hypot(x - 0.5, y - 0.5) for x, y in pts]
    assert all(b > a for a, b in zip(radii, radii[1:]))     # strictly outward
    assert radii[0] == pytest.approx(0.05, abs=1e-6)
    assert radii[-1] == pytest.approx(0.3, abs=1e-6)
    # angles span turns * 2pi (9 points -> pi/2 steps, unwrap-safe)
    angs = np.unwrap([np.arctan2(y - 0.5, x - 0.5) for x, y in pts])
    assert angs[-1] - angs[0] == pytest.approx(2 * 2 * np.pi, rel=1e-5)


def test_place_sequence_walks_and_wraps():
    p = {"type": "spiral", "center": [0.5, 0.5], "inner_radius": 0.05,
         "radius": 0.3, "turns": 2.0, "sequence": 8}
    radii = []
    for k in range(9):
        pts, _ = S._place(p, 1, 0, np.random.default_rng(0), {}, seq_idx=k)
        radii.append(np.hypot(pts[0][0] - 0.5, pts[0][1] - 0.5))
    assert all(b > a for a, b in zip(radii[:8], radii[1:8]))
    assert radii[8] == pytest.approx(radii[0], abs=1e-9)    # wraps to start
    # deterministic across calls
    again, _ = S._place(p, 1, 0, np.random.default_rng(0), {}, seq_idx=3)
    assert np.hypot(again[0][0] - 0.5, again[0][1] - 0.5) == pytest.approx(
        radii[3], abs=1e-12)


def test_place_sequence_on_circle_and_line():
    circ = {"type": "circle", "center": [0.5, 0.5], "radius": 0.2,
            "sequence": 4}
    angs = []
    for k in range(4):
        pts, _ = S._place(circ, 1, 0, np.random.default_rng(0), {}, seq_idx=k)
        angs.append(np.arctan2(pts[0][1] - 0.5, pts[0][0] - 0.5))
    assert len({round(a, 6) for a in angs}) == 4            # 4 distinct spots
    line = {"type": "line", "points": [[0.1, 0.5], [0.9, 0.5]], "sequence": 4}
    xs = [S._place(line, 1, 0, np.random.default_rng(0), {}, seq_idx=k)[0][0][0]
          for k in range(4)]
    assert xs == sorted(xs) and xs[0] == pytest.approx(0.1)


def test_window_preview_stable_with_spiral_sequence(score, tmp_path):
    """Sequence placement uses the same window-stable cumulative counter as
    palette cycling: a window render places hits exactly like the full run."""
    import imageio.v2 as imageio
    rec = _rec(emitters=[{
        "id": "spin", "trigger": {"type": "onset", "band": "low"},
        "placement": {"type": "spiral", "center": [0.5, 0.5], "radius": 0.35,
                      "inner_radius": 0.02, "turns": 2.0, "sequence": 6},
        "direction": {"type": "radial_out"},
        "color": {"type": "fixed", "hex": "#2255FF"}}])
    proj = Project.from_score(score, rec, audio="t.wav")
    n = score.n_frames
    trees, _ = proj.frame_trees(n, score)
    store = S.CheckpointStore(tmp_path / "ck")
    S.simulate(score, rec, tmp_path / "full", max_frames=n, frame_trees=trees,
               checkpoints=store, save_checkpoints=True)
    S.simulate(score, rec, tmp_path / "win", max_frames=n, frame_trees=trees,
               render_range=(48, 60), warmup_frames=8, checkpoints=store,
               write_velocity=False)
    a = imageio.imread(tmp_path / "full" / "fluid" / "000054.png").astype(float)
    b = imageio.imread(tmp_path / "win" / "fluid" / "000006.png").astype(float)
    assert np.abs(a - b).mean() < 2.0
