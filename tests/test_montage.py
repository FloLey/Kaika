"""The montage card on COMPOSITION EXTRACTS (specs/compositions step 03): each extract
plays a child composition in a private recursive Dag, re-timed so local frame 0 lands
on the cut. Pinned here: the effective-cut schedule (gate ∪ manual − disabled),
hold-last semantics, spans, the extract in-point, the whole-clip vs block-streaming
lockstep, the 3ch→RGBA compositing equivalence, nesting (a montage inside a child),
window sensitivity (a sync="song" child re-renders when the cuts move; a leaf does
not), missing-reference validation, and the re-render economy: per-extract frame
caches keyed so appending an extract renders only the new one and editing a child
re-renders only its extracts."""

import copy
import shutil
import subprocess

import numpy as np
import pytest
from PIL import Image

from backend import graph as G
from backend import paths
from backend import sources as S
from backend.graph_render import (
    _effective_cuts,
    _montage_cut_frames,
    _montage_starts,
    _to_rgba,
    _window_sensitive,
)

from helpers import assert_moves, no_audio as NOAUDIO

_needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

OUT = {"width": 64, "height": 64, "quality": "draft", "fps": 12}
SEG = {"start": 0.0, "end": 1.0, "signals": []}


def _edge(s, t, tp):
    return {"id": f"{s}-{t}-{tp}", "source": s, "sourcePort": "out", "target": t, "targetPort": tp}


def _image_node(nid, url):
    return {
        "id": nid,
        "type": "image",
        "data": {
            "assetUrl": url,
            "box_x": 0,
            "box_y": 0,
            "box_w": 1,
            "box_h": 1,
            "fit": "cover",
            "ports": {},
        },
    }


def _video_data(url, start=0.0, sync="segment", loop=True):
    return {
        "assetUrl": url,
        "box_x": 0,
        "box_y": 0,
        "box_w": 1,
        "box_h": 1,
        "fit": "cover",
        "sync": sync,
        "start": start,
        "loop": loop,
        "ports": {"speed": {"binding": {"kind": "const", "value": 1}}},
    }


def _leaf(cid, inner_node):
    """A minimal composition: <inner producer> → output."""
    return {
        "id": cid,
        "name": cid,
        "graph": {
            "version": 30,
            "nodes": [inner_node, {"id": f"{cid}-o", "type": "output", "data": {}}],
            "edges": [_edge(inner_node["id"], f"{cid}-o", "video")],
        },
    }


def _montage_node(nid, extracts, trigger_src=None, manual=None, disabled=None):
    ports = {}
    if trigger_src:
        ports["trigger"] = {"binding": {"kind": "node", "nodeId": trigger_src, "lo": 0, "hi": 1}}
    return {
        "id": nid,
        "type": "montage",
        "data": {
            "extracts": extracts,
            "manualBreakpoints": [{"id": f"bp{i}", "t": t} for i, t in enumerate(manual or [])],
            "disabledCuts": list(disabled or []),
            "threshold": 0.5,
            "hysteresis": 0.1,
            "ports": ports,
        },
    }


def _lfo(rate=2):
    return {
        "id": "lfo",
        "type": "lfo",
        "data": {"shape": "square", "rateMode": "cycles", "rate": rate, "duty": 0.5},
    }


def _x(cid, span=None, in_point=None):
    ex = {"id": f"x-{cid}", "compositionId": cid}
    if span:
        ex["span"] = span
    if in_point:
        ex["inPoint"] = in_point
    return ex


def _host(extracts, trigger="lfo", lfo_rate=2, manual=None, disabled=None):
    """A host graph: (lfo →) montage(extracts) → output."""
    nodes = ([_lfo(lfo_rate)] if trigger else []) + [
        _montage_node("mt", extracts, trigger, manual, disabled),
        {"id": "o", "type": "output", "data": {}},
    ]
    edges = ([_edge("lfo", "mt", "trigger")] if trigger else []) + [_edge("mt", "o", "video")]
    return {"version": 30, "nodes": nodes, "edges": edges}


@pytest.fixture
def assets(tmp_path, monkeypatch):
    """Two solid-colour stills under a patched ASSETS_DIR."""
    monkeypatch.setattr(paths, "ASSETS_DIR", tmp_path)
    d = tmp_path / "job"
    d.mkdir()
    Image.new("RGB", (8, 8), (255, 0, 0)).save(d / "red.png")
    Image.new("RGB", (8, 8), (0, 0, 255)).save(d / "blue.png")
    return ["/assets/job/red.png", "/assets/job/blue.png"]


@pytest.fixture
def video_asset(tmp_path, monkeypatch):
    """A time-varying test clip (`testsrc`) so re-timing shows up as different frames."""
    monkeypatch.setattr(paths, "ASSETS_DIR", tmp_path)
    d = tmp_path / "job"
    d.mkdir(exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=32x32:rate=12:duration=3",
            "-pix_fmt",
            "yuv420p",
            str(d / "clip.mp4"),
        ],
        check=True,
    )
    return "/assets/job/clip.mp4"


def _pool_images(assets, n=2):
    """n image-leaf compositions cycling red/blue."""
    return {
        f"c{i + 1}": _leaf(f"c{i + 1}", _image_node(f"im{i + 1}", assets[i % len(assets)]))
        for i in range(n)
    }


red = lambda f: f[32, 32, 0] > 200 and f[32, 32, 2] < 50  # noqa: E731
blue = lambda f: f[32, 32, 2] > 200 and f[32, 32, 0] < 50  # noqa: E731


# --------------------------------------------------------------------------- #
# The cut schedule — pure functions
# --------------------------------------------------------------------------- #
def test_starts_frame_zero_is_extract_zero_and_cuts_advance():
    assert _montage_starts([6], [1, 1]) == [0, 6]


def test_starts_holds_the_last_extract_when_cuts_exceed_extracts():
    assert _montage_starts([3, 6, 9], [1, 1]) == [0, 3]  # extra cuts ignored


def test_starts_span_swallows_extra_cuts():
    assert _montage_starts([3, 6, 9], [2, 1, 1]) == [0, 6, 9]


def test_starts_span_beyond_available_cuts_holds():
    assert _montage_starts([3], [2, 1]) == [0]  # the ×2 never gets its 2nd cut


def _sq(rate, n=12):
    """A square trigger curve with `rate` cycles over n frames, starting HIGH."""
    t = np.arange(n) / n
    return (np.sin(2 * np.pi * rate * t + 1e-6) >= 0).astype(np.float32)


def test_effective_cuts_gate_only_matches_the_rises():
    d = {"threshold": 0.5, "hysteresis": 0.1}
    cuts = _effective_cuts(_sq(2), d, 12, 12)
    assert cuts == [6]  # starts high → the mid-clip rise is the one cut


def test_effective_cuts_unions_manual_and_dedupes_frames():
    d = {"threshold": 0.5, "hysteresis": 0.1, "manualBreakpoints": [{"t": 0.25}, {"t": 0.5}]}
    # gate rise at frame 6 (0.5s at 12fps) collides with the 0.5s manual — one cut.
    assert _effective_cuts(_sq(2), d, 12, 12) == [3, 6]


def test_effective_cuts_disables_a_gate_cut_within_half_a_frame():
    d = {"threshold": 0.5, "hysteresis": 0.1, "disabledCuts": [0.5 + 0.3 / 12]}
    assert _effective_cuts(_sq(2), d, 12, 12) == []  # the frame-6 rise is silenced
    d2 = {"threshold": 0.5, "hysteresis": 0.1, "disabledCuts": [0.5 + 0.7 / 12]}
    assert _effective_cuts(_sq(2), d2, 12, 12) == [6]  # outside the band — untouched


def test_effective_cuts_clamps_inside_the_window():
    d = {"threshold": 0.5, "hysteresis": 0.1, "manualBreakpoints": [{"t": 0.0}, {"t": 99.0}]}
    assert _effective_cuts(np.zeros(12, np.float32), d, 12, 12) == []


def test_a_disabled_time_silences_a_manual_on_the_same_frame():
    """The bridge bug (v17): a gate cut disabled at 0.5s PLUS a manual breakpoint at
    the same second (a mis-click, or a copied layout) — the manual used to resurrect
    the cut the user had just clicked off, while the timeline showed it silenced.
    A disabled entry now suppresses ANY cut source within half a frame."""
    d = {
        "threshold": 0.5,
        "hysteresis": 0.1,
        "disabledCuts": [0.5],
        "manualBreakpoints": [{"t": 0.5}],
    }
    assert _effective_cuts(_sq(2), d, 12, 12) == []
    # …and only that time: a manual clear of the band still cuts.
    d["manualBreakpoints"].append({"t": 0.25})
    assert _effective_cuts(_sq(2), d, 12, 12) == [3]


# --------------------------------------------------------------------------- #
# schedule_fps — the cut schedule pinned to the EDITOR's rate on HD exports
# --------------------------------------------------------------------------- #
def test_schedule_fps_pins_cuts_to_the_editor_rate(assets):
    """An export rendering at another fps must cut at the same MUSICAL instants the
    editor timeline showed (gate-rise detection is sampling-dependent — a 30fps
    export once found an extra rise and played every later extract one slot early).
    With `schedule_fps` in the output dict, cuts are detected at the editor's rate
    and converted; without it, behavior is byte-identical to before."""
    pool = _pool_images(assets)
    g = _host([_x("c1"), _x("c2")], lfo_rate=4)
    mont = next(n for n in g["nodes"] if n["type"] == "montage")
    a = G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool)  # the editor: 12fps
    hd = {**OUT, "fps": 30, "schedule_fps": OUT["fps"]}
    b = G.Dag("job", SEG, g, NOAUDIO, hd, pool=pool)  # the export: 30fps, 12fps schedule
    d = mont["data"]
    ca = _montage_cut_frames(a, mont, d, a._fx_params(mont)["trigger"], round(a.duration * a.fps))
    cb = _montage_cut_frames(b, mont, d, b._fx_params(mont)["trigger"], round(b.duration * b.fps))
    assert len(ca) == len(cb)  # SAME rise set — no extra/missing cut at the other rate
    for ta, tb in zip((c / 12 for c in ca), (c / 30 for c in cb)):
        assert abs(ta - tb) <= 0.5 / 12 + 1e-6  # same instant, ±half an editor frame
    a.close(), b.close()


def test_schedule_fps_render_switches_at_the_converted_frame(assets):
    """End-to-end at the export fps: the first cut (0.25s at the editor rate) lands
    on frame round(0.25*30) — red before it, blue from it on."""
    pool = _pool_images(assets)
    g = _host([_x("c1"), _x("c2")], lfo_rate=4)
    hd = {**OUT, "fps": 30, "schedule_fps": OUT["fps"]}
    whole = G.Dag("job", SEG, g, NOAUDIO, hd, pool=pool).video("o")
    cut = round(3 / 12 * 30)  # editor cut frame 3 @12fps → 0.25s → frame 8 @30fps
    assert red(whole[cut - 1]) and blue(whole[cut])


def test_export_with_schedule_enriches_only_on_differing_fps():
    from backend.song_render import export_with_schedule, output_from_export

    exp = {"fps": 30, "width": 64, "height": 64}
    same = export_with_schedule(exp, {"fps": 30})
    assert same is exp  # equal fps: untouched — existing cache keys stay valid
    diff = export_with_schedule(exp, {"fps": 24})
    assert diff["schedule_fps"] == 24
    assert output_from_export(diff)["schedule_fps"] == 24
    assert "schedule_fps" not in output_from_export(exp)


# --------------------------------------------------------------------------- #
# 3ch → RGBA equivalence (unchanged by the rework)
# --------------------------------------------------------------------------- #
def test_to_rgba_composites_identically():
    from backend.graph_common import composite

    rgb = np.zeros((2, 4, 4, 3), np.uint8)
    rgb[..., 0] = 200  # premultiplied dye-on-black
    rgba = _to_rgba(rgb)
    assert rgba.shape[-1] == 4
    direct = composite([rgb.astype(np.float32) / 255.0], [1.0])
    via = composite([rgba.astype(np.float32) / 255.0], [1.0])
    assert np.allclose(direct, via, atol=1 / 255)


def test_to_rgba_passes_rgba_through():
    x = np.random.default_rng(0).integers(0, 255, (2, 4, 4, 4), np.uint8)
    assert _to_rgba(x) is x


# --------------------------------------------------------------------------- #
# Rendering — cuts, hold, spans, manual/disabled, lockstep
# --------------------------------------------------------------------------- #
def test_montage_cuts_between_extracts(assets):
    """12 frames, square LFO at 2 cycles (starts high → one rise at frame 6): red plays
    0..5, blue 6..11 — and the streamed render matches the whole clip exactly, with a
    block seam straddling the cut."""
    pool = _pool_images(assets)
    g = _host([_x("c1"), _x("c2")])
    G.validate(g)
    whole = G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool).video("o")
    assert whole.shape[0] == 12 and whole.shape[-1] == 4
    assert red(whole[0]) and blue(whole[6])
    # DELIBERATELY static within an extract: these leaves hold still IMAGES.
    assert np.array_equal(whole[5], whole[0]) and np.array_equal(whole[11], whole[6])
    streamed = np.concatenate(
        [f for *_, f in G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool).stream_blocks("o", 5)]
    )
    assert np.array_equal(whole, streamed)  # the lockstep invariant, cut mid-block


def test_montage_holds_last_extract(assets):
    """3 extracts but the trigger only rises once — the 2nd holds to the end and the
    3rd never shows."""
    pool = _pool_images(assets, 3)  # c3 is red again (assets wrap)
    g = _host([_x("c1"), _x("c2"), _x("c3")])
    whole = G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool).video("o")
    assert blue(whole[-1])  # never red again


def test_montage_span_extract_plays_through_two_intervals(assets):
    """A ×2 extract keeps its picture up across the cut it swallows: with rises at
    3/6/9, spans [2,1,1] show red through frame 5, blue at 6-8, red again from 9."""
    pool = _pool_images(assets, 3)
    g = _host([_x("c1", span=2), _x("c2"), _x("c3")], lfo_rate=4)
    whole = G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool).video("o")
    assert red(whole[4])  # past the swallowed cut (frame 3)
    assert blue(whole[6]) and blue(whole[8])
    assert red(whole[9])
    streamed = np.concatenate(
        [f for *_, f in G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool).stream_blocks("o", 5)]
    )
    assert np.array_equal(whole, streamed)


def test_montage_cuts_on_manual_breakpoints_alone(assets):
    """No trigger wired at all: the manual breakpoints ARE the schedule."""
    pool = _pool_images(assets)
    g = _host([_x("c1"), _x("c2")], trigger=None, manual=[0.25])
    G.validate(g)
    whole = G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool).video("o")
    assert red(whole[2]) and blue(whole[3])  # the 0.25s (frame 3) cut


def test_montage_disabled_gate_cut_does_not_cut(assets):
    """The frame-6 gate rise is stored as a disabled exception: extract 1 holds."""
    pool = _pool_images(assets)
    g = _host([_x("c1"), _x("c2")], disabled=[0.5])
    whole = G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool).video("o")
    assert red(whole[6]) and red(whole[11])  # no cut — blue never shows


@_needs_ffmpeg
def test_montage_retimes_each_extract_to_its_cut(video_asset):
    """The trim mechanism: a leaf whose video starts at S begins at S exactly on the
    cut — the montage frame at the cut equals that composition's own frame 0."""
    pool = {
        "cv1": _leaf("cv1", {"id": "v1", "type": "video", "data": _video_data(video_asset)}),
        "cv2": _leaf(
            "cv2", {"id": "v2", "type": "video", "data": _video_data(video_asset, start=1.5)}
        ),
    }
    g = _host([_x("cv1"), _x("cv2")])
    whole = G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool).video("o")
    # standalone: the same composition rendered alone — its frame 0 is the in-point.
    ref = G.Dag("job", SEG, pool["cv2"]["graph"], NOAUDIO, OUT).video("cv2-o")
    assert np.array_equal(whole[6], ref[0])  # the cut lands exactly on the in-point
    assert not np.array_equal(whole[6], whole[5])  # and it IS a visible cut
    assert_moves(whole, "montage of real clips")  # the clips PLAY, they don't freeze


@_needs_ffmpeg
def test_extract_in_point_offsets_the_child(video_asset):
    """extract.inPoint=T ≡ the leaf's video starting T later — the montage-resume
    'align it' contract, byte-exact."""
    leaf0 = _leaf("ca", {"id": "va", "type": "video", "data": _video_data(video_asset)})
    leaf15 = _leaf("cb", {"id": "vb", "type": "video", "data": _video_data(video_asset, start=1.5)})
    via_inpoint = G.Dag(
        "job", SEG, _host([_x("ca", in_point=1.5)]), NOAUDIO, OUT, pool={"ca": leaf0}
    ).video("o")
    via_start = G.Dag("job", SEG, _host([_x("cb")]), NOAUDIO, OUT, pool={"cb": leaf15}).video("o")
    assert np.array_equal(via_inpoint, via_start)


def test_montage_accepts_a_3ch_child(assets):
    """A dye-on-black producer (backdrop) as a child converts to RGBA and still shows."""
    pool = {
        "cbd": _leaf(
            "cbd", {"id": "bd", "type": "backdrop", "data": {"color": "#ff8800", "ports": {}}}
        ),
        "cim": _leaf("cim", _image_node("im", assets[1])),
    }
    g = _host([_x("cbd"), _x("cim")])
    whole = G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool).video("o")
    assert whole.shape[-1] == 4
    assert whole[0, 32, 32, 0] > 200  # the backdrop's orange shows in extract 1
    streamed = np.concatenate(
        [f for *_, f in G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool).stream_blocks("o", 5)]
    )
    assert np.array_equal(whole, streamed)


def test_montage_nests_a_montage_child(assets):
    """Recursion: extract 1 is itself a montage (of two stills on manual cuts). The
    grandchildren render through the same handler, depth-free."""
    pool = _pool_images(assets)
    pool["cmid"] = {
        "id": "cmid",
        "name": "inner",
        "graph": _host([_x("c1"), _x("c2")], trigger=None, manual=[0.25]),
    }
    g = _host([_x("cmid"), _x("c1")])  # outer: inner montage, then red
    G.validate(g)
    G.validate_pool(pool)
    whole = G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool).video("o")
    # outer cut at frame 6; the INNER montage's own local 0.25s cut lands at frame 3.
    assert red(whole[0]) and blue(whole[4]) and red(whole[6])
    streamed = np.concatenate(
        [f for *_, f in G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool).stream_blocks("o", 5)]
    )
    assert np.array_equal(whole, streamed)


# --------------------------------------------------------------------------- #
# Validation & missing references
# --------------------------------------------------------------------------- #
def test_validate_rejects_an_extract_without_a_reference():
    g = _host([{"id": "x1", "compositionId": ""}])
    with pytest.raises(ValueError, match="no composition reference"):
        G.validate(g)


def test_render_raises_on_a_missing_composition(assets):
    g = _host([_x("c-gone")])
    with pytest.raises(ValueError, match="missing composition"):
        G.Dag("job", SEG, g, NOAUDIO, OUT, pool={}).video("o")


def test_render_raises_on_a_child_with_no_output(assets):
    pool = {"c1": {"id": "c1", "name": "broken", "graph": {"nodes": [], "edges": []}}}
    with pytest.raises(ValueError, match="no output"):
        G.Dag("job", SEG, _host([_x("c1")]), NOAUDIO, OUT, pool=pool).video("o")


def test_montage_with_no_extracts_raises(assets):
    g = _host([])
    with pytest.raises(ValueError, match="no extracts"):
        G.Dag("job", SEG, g, NOAUDIO, OUT, pool={}).video("o")


# --------------------------------------------------------------------------- #
# Window sensitivity — what decides an extract's cache regime
# --------------------------------------------------------------------------- #
def test_window_sensitivity_walks_the_closure():
    leaf_seg = _leaf("a", {"id": "v", "type": "video", "data": _video_data("/assets/j/x.mp4")})
    leaf_song = _leaf(
        "b", {"id": "v", "type": "video", "data": _video_data("/assets/j/x.mp4", sync="song")}
    )
    sig = _leaf("c", {"id": "sg", "type": "signal", "data": {"signalId": "s1"}})
    assert not _window_sensitive({}, leaf_seg["graph"])
    assert _window_sensitive({}, leaf_song["graph"])
    assert _window_sensitive({}, sig["graph"])
    # …and through a NESTED reference: a montage child whose grandchild is sensitive.
    mid = {"id": "m", "name": "m", "graph": _host([_x("b")], trigger=None, manual=[0.25])}
    assert _window_sensitive({"b": leaf_song, "m": mid}, mid["graph"])
    over_leaf = _host([_x("a")], trigger=None, manual=[0.25])
    assert not _window_sensitive({"a": leaf_seg}, over_leaf)


# --------------------------------------------------------------------------- #
# Re-render economy — per-extract frame caches
# --------------------------------------------------------------------------- #
def _boom(*_a, **_k):
    raise AssertionError("this extract should have come from the frame cache")


def test_extract_cache_serves_a_second_whole_clip_render(assets, monkeypatch):
    """Re-rendering the same montage decodes nothing: break the image producer and
    the render still succeeds, byte-identical, entirely from the extract cache."""
    pool = _pool_images(assets)
    g = _host([_x("c1"), _x("c2")])
    first = G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool).video("o")
    monkeypatch.setattr(S, "image", _boom)
    assert np.array_equal(G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool).video("o"), first)


def test_appending_an_extract_renders_only_the_new_one(assets, monkeypatch):
    """The point of the whole exercise: building a montage clip-by-clip pays for the
    clip you just added, not for the ones already there."""
    pool = _pool_images(assets, 3)
    two = _host([_x("c1"), _x("c2")], lfo_rate=4)
    G.Dag("job", SEG, two, NOAUDIO, OUT, pool=pool).video("o")  # cold: both rendered

    three = _host([_x("c1"), _x("c2"), _x("c3")], lfo_rate=4)
    calls = []
    real = S.image
    monkeypatch.setattr(S, "image", lambda *a, **k: (calls.append(1), real(*a, **k))[1])
    frames = G.Dag("job", SEG, three, NOAUDIO, OUT, pool=pool).video("o")
    assert len(calls) == 1  # c1/c2 came from the cache; only c3 was produced
    assert frames.shape[0] == 12


def test_retiming_rerenders_only_extracts_that_grew(assets, monkeypatch):
    """Extract caches are keyed on the child + the HOST window for window-INsensitive
    children, so moving the cuts reuses every cached run that is still long enough —
    only an extract that GREW past its cached length renders again."""
    pool = _pool_images(assets)
    G.Dag("job", SEG, _host([_x("c1"), _x("c2")], lfo_rate=4), NOAUDIO, OUT, pool=pool).video("o")
    # rate 4 → cuts at 3/6/9: c1 cached 3 frames, c2 cached 9. Retimed to rate 2
    # (cut at 6): c1 needs 6 (> 3 — grew, re-renders), c2 needs 6 (≤ 9 — cached).
    calls = []
    real = S.image
    monkeypatch.setattr(S, "image", lambda *a, **k: (calls.append(1), real(*a, **k))[1])
    out = G.Dag("job", SEG, _host([_x("c1"), _x("c2")], lfo_rate=2), NOAUDIO, OUT, pool=pool).video(
        "o"
    )
    assert len(calls) == 1
    assert out.shape[0] == 12


def test_extract_cache_invalidates_when_the_child_changes(assets, monkeypatch):
    """The key folds the child's graph — editing it (here: swapping its asset)
    re-renders THAT extract only."""
    pool = _pool_images(assets)
    g = _host([_x("c1"), _x("c2")])
    G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool).video("o")
    edited = copy.deepcopy(pool)
    next(n for n in edited["c1"]["graph"]["nodes"] if n["type"] == "image")["data"]["assetUrl"] = (
        assets[1]
    )
    calls = []
    real = S.image
    monkeypatch.setattr(S, "image", lambda *a, **k: (calls.append(1), real(*a, **k))[1])
    G.Dag("job", SEG, g, NOAUDIO, OUT, pool=edited).video("o")
    assert len(calls) == 1  # only the edited child re-rendered


def test_a_shared_composition_is_cached_once_across_extracts(assets, monkeypatch):
    """Two extracts of the SAME window-insensitive composition share one cache entry:
    the second render of the pair comes from the first's frames."""
    pool = _pool_images(assets, 1)
    g = _host([_x("c1"), {"id": "x-c1-b", "compositionId": "c1"}])
    calls = []
    real = S.image
    monkeypatch.setattr(S, "image", lambda *a, **k: (calls.append(1), real(*a, **k))[1])
    whole = G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool).video("o")
    assert red(whole[0]) and red(whole[6])
    assert len(calls) == 1  # extract 2 replayed extract 1's cached frames


def test_an_oversized_set_still_caches_its_leading_extracts(assets, monkeypatch):
    """The set allowance is spent in play order: a montage whose full SET overflows
    the budget caches the extracts that fit and re-renders only the tail. The old
    all-or-nothing gate cached NOTHING for such a montage — a 104-second 38-extract
    verse re-rendered every child on every preview stream."""
    from backend import fluid_cache as FC
    from backend.graph_render import _grid_dims

    pool = _pool_images(assets)
    g = _host([_x("c1"), _x("c2")], lfo_rate=4)  # cuts at 3/6/9: c1 = 3 frames, c2 = 9
    probe = G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool)
    gh, gw = _grid_dims(probe)
    probe.close()
    # Budget worth 5 frames: c1's 3-frame entry fits, c2's 9-frame entry doesn't.
    monkeypatch.setattr(FC, "set_budget", lambda: 5 * gh * gw * 4)
    first = G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool).video("o")
    calls = []
    real = S.image
    monkeypatch.setattr(S, "image", lambda *a, **k: (calls.append(1), real(*a, **k))[1])
    assert np.array_equal(G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool).video("o"), first)
    assert len(calls) == 1  # c1 came off the cache; only the past-budget c2 re-rendered


# --------------------------------------------------------------------------- #
# Child Dag lifecycle — decoders open lazily and close when played out
# --------------------------------------------------------------------------- #
@_needs_ffmpeg
def test_a_played_out_extract_closes_its_child_before_the_segment_ends(video_asset, monkeypatch):
    """Streaming past a cut must close the finished extract's child Dag (its ffmpeg
    decoder included) — a 23-extract montage holding 23 decoders to the end of the
    segment is the 4.9 GB failure this design retired."""
    opened, closed = [], []
    real_close = S.VideoClip.close

    def spy_close(self):
        if self in opened and self not in closed:
            closed.append(self)
        return real_close(self)

    real_init = S.VideoClip.__init__

    def spy_init(self, *a, **k):
        opened.append(self)
        return real_init(self, *a, **k)

    monkeypatch.setattr(S.VideoClip, "__init__", spy_init)
    monkeypatch.setattr(S.VideoClip, "close", spy_close)

    pool = {
        "cv1": _leaf("cv1", {"id": "v1", "type": "video", "data": _video_data(video_asset)}),
        "cv2": _leaf(
            "cv2", {"id": "v2", "type": "video", "data": _video_data(video_asset, start=1.5)}
        ),
    }
    g = _host([_x("cv1"), _x("cv2")])
    dag = G.Dag("job", SEG, g, NOAUDIO, OUT, pool=pool)
    mid_closed = None
    for a, _b, _tot, _f in dag.stream_blocks("o", 3):
        if a >= 9:  # well past the frame-6 cut
            mid_closed = len(closed)
    assert opened, "the spy never saw a decoder"
    assert mid_closed and mid_closed >= 1, "the played-out extract kept its decoder open"
    assert len(closed) >= len([c for c in opened if c in closed])  # and close() drained the rest
