"""The montage card: trigger-driven sequential switching between wired video inputs,
slot-local re-timing (an input's clock starts at its cut), hold-last semantics, the
whole-clip vs block-streaming lockstep, the 3ch→RGBA compositing equivalence, the
slot-exclusivity validation rule, and the two "don't re-render what didn't change"
guarantees: an unwired slot is invisible to the hash, and each slot's frames are
cached in LOCAL time so appending/retiming reuses the untouched ones."""

import copy
import shutil
import subprocess

import numpy as np
import pytest
from PIL import Image

from backend import graph as G
from backend import paths
from backend import sources as S
from backend.graph_common import composite
from backend.graph_render import _montage_block, _montage_starts, _montage_video, _to_rgba

from helpers import assert_moves

_needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

OUT = {"width": 64, "height": 64, "quality": "draft", "fps": 12}
SEG = {"start": 0.0, "end": 1.0, "signals": []}
NOAUDIO = lambda j, s: None  # noqa: E731


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


def _montage_node(nid, slot_ids, trigger_src=None, spans=None):
    ports = {}
    if trigger_src:
        ports["trigger"] = {"binding": {"kind": "node", "nodeId": trigger_src, "lo": 0, "hi": 1}}
    inputs = [{"id": s} for s in slot_ids]
    for slot, span in zip(inputs, spans or []):
        if span and span > 1:
            slot["span"] = span
    return {
        "id": nid,
        "type": "montage",
        "data": {
            "inputs": inputs,
            "threshold": 0.5,
            "hysteresis": 0.1,
            "ports": ports,
        },
    }


_LFO2 = {
    "id": "lfo",
    "type": "lfo",
    "data": {"shape": "square", "rateMode": "cycles", "rate": 2, "duty": 0.5},
}


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


# --------------------------------------------------------------------------- #
# _montage_starts — the slot-boundary math
# --------------------------------------------------------------------------- #
def test_starts_frame_zero_is_slot_zero_and_rises_cut():
    trig = np.array([0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0], np.float32)
    starts = _montage_starts(trig, [1, 1, 1], {"threshold": 0.5, "hysteresis": 0.0})
    assert starts == [0, 2, 5]  # slot 0 from frame 0, cuts at the two rises


def test_starts_holds_the_last_input_when_rises_exceed_inputs():
    trig = np.array([0.0, 1.0, 0.0, 1.0, 0.0, 1.0], np.float32)  # 3 rises
    starts = _montage_starts(trig, [1, 1], {"threshold": 0.5, "hysteresis": 0.0})
    assert starts == [0, 1]  # rises 2 and 3 are ignored — input 2 holds


def test_starts_trigger_starting_high_counts_no_rise():
    trig = np.ones(5, np.float32)
    starts = _montage_starts(trig, [1, 1, 1], {"threshold": 0.5, "hysteresis": 0.0})
    assert starts == [0]  # never cuts — only slot 0 plays


def test_starts_span_swallows_extra_cuts():
    """A ×2 slot plays through two gate intervals: with rises at 1/3/5, spans [2,1]
    hand slot 2 over at the SECOND rise (frame 3), and the swallowed rise never cuts."""
    trig = np.array([0.0, 1.0, 0.0, 1.0, 0.0, 1.0], np.float32)  # rises at 1, 3, 5
    d = {"threshold": 0.5, "hysteresis": 0.0}
    assert _montage_starts(trig, [2, 1], d) == [0, 3]
    assert _montage_starts(trig, [1, 2, 1], d) == [0, 1, 5]  # slot 2 (×2) eats rises 2+3
    # spans all 1 stay the old behaviour
    assert _montage_starts(trig, [1, 1, 1], d) == [0, 1, 3]


def test_starts_span_beyond_available_rises_holds():
    """A ×3 first slot with only 2 rises never hands over — it holds to the end."""
    trig = np.array([0.0, 1.0, 0.0, 1.0, 0.0], np.float32)  # 2 rises
    assert _montage_starts(trig, [3, 1], {"threshold": 0.5, "hysteresis": 0.0}) == [0]


# --------------------------------------------------------------------------- #
# _to_rgba — dye-on-black layers composite identically after conversion
# --------------------------------------------------------------------------- #
def test_to_rgba_composites_identically():
    rng = np.random.default_rng(0)
    f3 = rng.integers(0, 256, (3, 6, 6, 3), dtype=np.uint8)
    op = [0.7]
    direct = composite([f3], op)
    converted = composite([_to_rgba(f3)], op)
    # uint8 round-trip of the un-premultiply adds at most ±1 per channel.
    assert np.abs(direct.astype(int) - converted.astype(int)).max() <= 1


def test_to_rgba_passes_rgba_through():
    f4 = np.zeros((1, 2, 2, 4), np.uint8)
    assert _to_rgba(f4) is f4


# --------------------------------------------------------------------------- #
# Rendering — cuts, hold, lockstep, re-timing
# --------------------------------------------------------------------------- #
def _montage_graph(assets, n_slots=2):
    slot_ids = [f"s{i + 1}" for i in range(n_slots)]
    nodes = [_LFO2]
    edges = [_edge("lfo", "mt", "trigger")]
    for i, sid in enumerate(slot_ids):
        nid = f"im{i + 1}"
        nodes.append(_image_node(nid, assets[i % len(assets)]))
        edges.append(_edge(nid, "mt", sid))
    nodes += [_montage_node("mt", slot_ids, "lfo"), {"id": "o", "type": "output", "data": {}}]
    edges.append(_edge("mt", "o", "video"))
    return {"version": 27, "nodes": nodes, "edges": edges}


def test_montage_cuts_between_inputs(assets):
    """12 frames, square LFO at 2 cycles (starts high → one rise at frame 6): red plays
    slots 0..5, blue 6..11 — and the streamed render matches the whole clip exactly,
    with a block seam straddling the cut."""
    g = _montage_graph(assets)
    G.validate(g)
    whole = G.Dag("job", SEG, g, NOAUDIO, OUT).video("o")
    assert whole.shape[0] == 12 and whole.shape[-1] == 4
    assert whole[0, 32, 32, 0] > 200 and whole[0, 32, 32, 2] < 50  # red first
    assert whole[6, 32, 32, 2] > 200 and whole[6, 32, 32, 0] < 50  # blue after the cut
    # DELIBERATELY static within a slot: this fixture wires still IMAGES, so a slot
    # holding its picture is correct here. Motion is asserted where a real clip plays
    # (test_montage_retimes_each_slot_to_its_cut).
    assert np.array_equal(whole[5], whole[0]) and np.array_equal(whole[11], whole[6])
    streamed = np.concatenate(
        [f for *_, f in G.Dag("job", SEG, g, NOAUDIO, OUT).stream_blocks("o", 5)]
    )
    assert np.array_equal(whole, streamed)  # the lockstep invariant, cut mid-block


def test_montage_holds_last_input(assets):
    """3 wired slots but the trigger only rises once — the 2nd input holds to the end
    and the 3rd never shows."""
    g = _montage_graph(assets, n_slots=3)  # im3 is red again (assets wrap)
    G.validate(g)
    whole = G.Dag("job", SEG, g, NOAUDIO, OUT).video("o")
    # one rise (frame 6): slot 2 (blue) holds through the last frame — never red again.
    assert whole[-1, 32, 32, 2] > 200 and whole[-1, 32, 32, 0] < 50


def test_montage_span_slot_plays_through_two_intervals(assets):
    """A ×2 slot keeps its video up across the cut it swallows: with rises at frames
    3/6/9, spans [2,1,1] show red through frame 5 (a ×1 slot would have cut at 3),
    blue at 6-8, red again from 9 — and streaming still matches the whole clip."""
    lfo4 = {
        "id": "lfo",
        "type": "lfo",
        "data": {"shape": "square", "rateMode": "cycles", "rate": 4, "duty": 0.5},
    }
    g = {
        "version": 27,
        "nodes": [
            lfo4,
            _image_node("im1", assets[0]),
            _image_node("im2", assets[1]),
            _image_node("im3", assets[0]),
            _montage_node("mt", ["s1", "s2", "s3"], "lfo", spans=[2, 1, 1]),
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [
            _edge("lfo", "mt", "trigger"),
            _edge("im1", "mt", "s1"),
            _edge("im2", "mt", "s2"),
            _edge("im3", "mt", "s3"),
            _edge("mt", "o", "video"),
        ],
    }
    G.validate(g)
    whole = G.Dag("job", SEG, g, NOAUDIO, OUT).video("o")
    red = lambda f: f[32, 32, 0] > 200 and f[32, 32, 2] < 50  # noqa: E731
    blue = lambda f: f[32, 32, 2] > 200 and f[32, 32, 0] < 50  # noqa: E731
    assert red(whole[4])  # past the swallowed cut (frame 3) — the ×2 slot holds
    assert blue(whole[6]) and blue(whole[8])  # slot 2 takes the SECOND rise
    assert red(whole[9])  # slot 3 on the third rise
    streamed = np.concatenate(
        [f for *_, f in G.Dag("job", SEG, g, NOAUDIO, OUT).stream_blocks("o", 5)]
    )
    assert np.array_equal(whole, streamed)


@_needs_ffmpeg
def test_montage_retimes_each_slot_to_its_cut(video_asset):
    """The trim mechanism: a video card (sync=segment, start=S) in slot 2 begins at S
    exactly on the cut — the montage frame at the cut equals that card's own frame 0."""

    def vid_node(nid, start):
        return {
            "id": nid,
            "type": "video",
            "data": {
                "assetUrl": video_asset,
                "box_x": 0,
                "box_y": 0,
                "box_w": 1,
                "box_h": 1,
                "fit": "cover",
                "sync": "segment",
                "start": start,
                "loop": True,
                "ports": {"speed": {"binding": {"kind": "const", "value": 1}}},
            },
        }

    g = {
        "version": 27,
        "nodes": [
            _LFO2,
            vid_node("v1", 0.0),
            vid_node("v2", 1.5),
            _montage_node("mt", ["s1", "s2"], "lfo"),
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [
            _edge("lfo", "mt", "trigger"),
            _edge("v1", "mt", "s1"),
            _edge("v2", "mt", "s2"),
            _edge("mt", "o", "video"),
        ],
    }
    G.validate(g)
    whole = G.Dag("job", SEG, g, NOAUDIO, OUT).video("o")
    # standalone: the same start=1.5 card alone — its frame 0 is the in-point frame.
    solo = {
        "version": 27,
        "nodes": [vid_node("v2", 1.5), {"id": "o", "type": "output", "data": {}}],
        "edges": [_edge("v2", "o", "video")],
    }
    ref = G.Dag("job", SEG, solo, NOAUDIO, OUT).video("o")
    assert np.array_equal(whole[6], ref[0])  # the cut lands exactly on the in-point
    assert not np.array_equal(whole[6], whole[5])  # and it IS a visible cut
    assert_moves(whole, "montage of real clips")  # the clips PLAY, they don't freeze


def test_montage_accepts_a_3ch_producer(assets):
    """A dye-on-black producer (backdrop) in a slot converts to RGBA and still shows."""
    g = {
        "version": 27,
        "nodes": [
            _LFO2,
            {"id": "bd", "type": "backdrop", "data": {"color": "#ff8800", "ports": {}}},
            _image_node("im", assets[1]),
            _montage_node("mt", ["s1", "s2"], "lfo"),
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [
            _edge("lfo", "mt", "trigger"),
            _edge("bd", "mt", "s1"),
            _edge("im", "mt", "s2"),
            _edge("mt", "o", "video"),
        ],
    }
    G.validate(g)
    whole = G.Dag("job", SEG, g, NOAUDIO, OUT).video("o")
    assert whole.shape[-1] == 4
    assert whole[0, 32, 32, 0] > 200  # the backdrop's orange shows in slot 1
    streamed = np.concatenate(
        [f for *_, f in G.Dag("job", SEG, g, NOAUDIO, OUT).stream_blocks("o", 5)]
    )
    assert np.array_equal(whole, streamed)


# --------------------------------------------------------------------------- #
# Validation — the slot-exclusivity rule
# --------------------------------------------------------------------------- #
def test_validate_rejects_a_card_feeding_two_slots(assets):
    g = {
        "version": 27,
        "nodes": [
            _image_node("im", assets[0]),
            _montage_node("mt", ["s1", "s2"]),
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [_edge("im", "mt", "s1"), _edge("im", "mt", "s2"), _edge("mt", "o", "video")],
    }
    with pytest.raises(ValueError, match="exclusive"):
        G.validate(g)


def test_validate_rejects_a_slot_chain_shared_with_another_consumer(assets):
    """The slot's upstream ALSO feeds a combine — conflicting block pulls, rejected."""
    g = {
        "version": 27,
        "nodes": [
            _image_node("im", assets[0]),
            _image_node("im2", assets[1]),
            _montage_node("mt", ["s1"]),
            {
                "id": "cb",
                "type": "combine",
                "data": {
                    "mode": "stack",
                    "inputs": [{"id": "c1", "opacity": 1}, {"id": "c2", "opacity": 1}],
                },
            },
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [
            _edge("im", "mt", "s1"),
            _edge("im", "cb", "c1"),
            _edge("im2", "cb", "c2"),
            _edge("cb", "o", "video"),
        ],
    }
    with pytest.raises(ValueError, match="exclusive"):
        G.validate(g)


def test_validate_accepts_distinct_chains(assets):
    g = _montage_graph(assets)
    G.validate(g)  # no raise — each slot has its own image card


def test_validate_requires_slot_ids():
    g = {
        "version": 27,
        "nodes": [
            {
                "id": "mt",
                "type": "montage",
                "data": {"inputs": [{}], "threshold": 0.5, "hysteresis": 0.1, "ports": {}},
            },
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [_edge("mt", "o", "video")],
    }
    with pytest.raises(ValueError, match="no id"):
        G.validate(g)


# --------------------------------------------------------------------------- #
# Re-render economy 1 — an UNWIRED slot can't change a frame, so it must not
# change the hash (pressing `+ slot` used to re-render a byte-identical clip).
# --------------------------------------------------------------------------- #
def _hash_of(g):
    return G.output_hash("job", SEG, g, "o", OUT)


def test_hash_ignores_unwired_montage_slots(assets):
    base = _montage_graph(assets)  # two wired slots
    h0 = _hash_of(base)

    plus = copy.deepcopy(base)
    mt = next(n for n in plus["nodes"] if n["type"] == "montage")
    mt["data"]["inputs"].append({"id": "s-empty"})
    assert _hash_of(plus) == h0  # `+ slot` alone: no re-render
    mt["data"]["inputs"][-1]["span"] = 3
    assert _hash_of(plus) == h0  # …nor a span set on that empty slot

    wired = copy.deepcopy(plus)
    wired["nodes"].append(_image_node("im3", assets[1]))
    wired["edges"].append(_edge("im3", "mt", "s-empty"))
    assert _hash_of(wired) != h0  # wiring it DOES bust the cache


def test_hash_ignores_an_unwired_combine_slot(assets):
    g = {
        "version": 27,
        "nodes": [
            _image_node("im", assets[0]),
            {
                "id": "cb",
                "type": "combine",
                "data": {"mode": "stack", "inputs": [{"id": "c1", "opacity": 1}]},
            },
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [_edge("im", "cb", "c1"), _edge("cb", "o", "video")],
    }
    h0 = _hash_of(g)
    plus = copy.deepcopy(g)
    next(n for n in plus["nodes"] if n["type"] == "combine")["data"]["inputs"].append(
        {"id": "c2", "opacity": 0.5}
    )
    assert _hash_of(plus) == h0  # an empty layer is skipped by the render too


def test_wired_slot_settings_still_bust_the_hash(assets):
    """The filter drops only UNWIRED slots — a wired slot's span (and slot ORDER)
    must still invalidate, else a real edit would show a stale clip."""
    base = _montage_graph(assets)
    h0 = _hash_of(base)
    spanned = copy.deepcopy(base)
    next(n for n in spanned["nodes"] if n["type"] == "montage")["data"]["inputs"][0]["span"] = 2
    assert _hash_of(spanned) != h0
    swapped = copy.deepcopy(base)
    mt = next(n for n in swapped["nodes"] if n["type"] == "montage")
    mt["data"]["inputs"] = list(reversed(mt["data"]["inputs"]))
    assert _hash_of(swapped) != h0


# --------------------------------------------------------------------------- #
# Re-render economy 2 — per-slot frame cache (keyed in the slot's LOCAL time)
# --------------------------------------------------------------------------- #
def _boom(*_a, **_k):
    raise AssertionError("this slot should have come from the frame cache")


def test_slot_cache_serves_a_second_whole_clip_render(assets, monkeypatch):
    """Re-rendering the same montage decodes nothing: break the image producer and
    the render still succeeds, byte-identical, entirely from the slot cache."""
    g = _montage_graph(assets)
    first = G.Dag("job", SEG, g, NOAUDIO, OUT).video("o")
    monkeypatch.setattr(S, "image", _boom)
    assert np.array_equal(G.Dag("job", SEG, g, NOAUDIO, OUT).video("o"), first)


def test_slot_cache_serves_the_block_path_too(assets, monkeypatch):
    g = _montage_graph(assets)
    dag = G.Dag("job", SEG, g, NOAUDIO, OUT)
    streamed = np.concatenate([f for *_, f in dag.stream_blocks("o", 5)])
    monkeypatch.setattr(S, "image", _boom)
    again = np.concatenate(
        [f for *_, f in G.Dag("job", SEG, g, NOAUDIO, OUT).stream_blocks("o", 5)]
    )
    assert np.array_equal(streamed, again)
    # …and the streaming render agrees with the whole-clip one (lockstep holds
    # across the cache: both paths store/serve the same local frames).
    assert np.array_equal(G.Dag("job", SEG, g, NOAUDIO, OUT).video("o"), streamed)


def test_appending_a_slot_renders_only_the_new_one(assets, monkeypatch):
    """The point of the whole exercise: building a montage clip-by-clip pays for
    the clip you just added, not for the ones already there."""
    lfo4 = {
        "id": "lfo",
        "type": "lfo",
        "data": {"shape": "square", "rateMode": "cycles", "rate": 4, "duty": 0.5},
    }
    two = {
        "version": 27,
        "nodes": [
            lfo4,
            _image_node("im1", assets[0]),
            _image_node("im2", assets[1]),
            _montage_node("mt", ["s1", "s2"], "lfo"),
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [
            _edge("lfo", "mt", "trigger"),
            _edge("im1", "mt", "s1"),
            _edge("im2", "mt", "s2"),
            _edge("mt", "o", "video"),
        ],
    }
    G.Dag("job", SEG, two, NOAUDIO, OUT).video("o")  # cold: both slots rendered

    three = copy.deepcopy(two)
    three["nodes"].append(_image_node("im3", assets[0]))
    next(n for n in three["nodes"] if n["type"] == "montage")["data"]["inputs"].append({"id": "s3"})
    three["edges"].append(_edge("im3", "mt", "s3"))

    calls = []
    real = S.image
    monkeypatch.setattr(S, "image", lambda *a, **k: (calls.append(1), real(*a, **k))[1])
    frames = G.Dag("job", SEG, three, NOAUDIO, OUT).video("o")
    assert len(calls) == 1  # im1/im2 came from the cache; only im3 was produced
    assert frames.shape[0] == 12


def test_retiming_the_trigger_reuses_every_cached_slot(assets, monkeypatch):
    """Slots are cached in LOCAL time, so moving the cuts (a different trigger, a
    span change) re-uses them — only a slot that grew LONGER than its cached run
    has to render again."""
    g = _montage_graph(assets)
    G.Dag("job", SEG, g, NOAUDIO, OUT).video("o")  # cold at rate 2 (one cut)
    retimed = copy.deepcopy(g)
    next(n for n in retimed["nodes"] if n["type"] == "lfo")["data"]["rate"] = 4
    monkeypatch.setattr(S, "image", _boom)
    out = G.Dag("job", SEG, retimed, NOAUDIO, OUT).video("o")  # cuts moved: still cached
    assert out.shape[0] == 12


def test_slot_cache_invalidates_when_the_slot_chain_changes(assets, monkeypatch):
    """The key is the slot's own contributing subgraph — editing the upstream card
    (here: swapping its asset) must re-render THAT slot."""
    g = _montage_graph(assets)
    G.Dag("job", SEG, g, NOAUDIO, OUT).video("o")
    edited = copy.deepcopy(g)
    next(n for n in edited["nodes"] if n["id"] == "im1")["data"]["assetUrl"] = assets[1]
    calls = []
    real = S.image
    monkeypatch.setattr(S, "image", lambda *a, **k: (calls.append(1), real(*a, **k))[1])
    G.Dag("job", SEG, edited, NOAUDIO, OUT).video("o")
    assert len(calls) == 1  # only the edited slot re-rendered


# --------------------------------------------------------------------------- #
# A montage input ignores the song clock — the montage re-times it (v12)
# --------------------------------------------------------------------------- #
def _video_card(nid, url, sync="song", start=0.0):
    return {
        "id": nid,
        "type": "video",
        "data": {
            "assetUrl": url,
            "box_x": 0, "box_y": 0, "box_w": 1, "box_h": 1, "fit": "cover",
            "sync": sync, "start": start, "loop": False,
            "ports": {"speed": {"binding": {"kind": "const", "value": 1}}},
        },
    }  # fmt: skip


@_needs_ffmpeg
def test_montage_input_ignores_the_song_sync_preroll(video_asset):
    """A `sync="song"` card normally pre-rolls by the segment's song offset. Inside a
    montage slot that is always wrong — the montage restarts the clip at the cut — and
    it used to seek past the end of any clip shorter than the offset, freezing its last
    frame for the whole slot. In a slot the clip must start at its in-point."""
    from backend.graph_render import _feeds_a_montage, _video_src0

    seg = {"start": 30.0, "end": 31.0, "signals": []}  # a segment deep into the song
    g = {
        "version": 27,
        "nodes": [
            _LFO2,
            _video_card("v1", video_asset),
            _video_card("v2", video_asset, start=0.5),
            _montage_node("mt", ["s1", "s2"], "lfo"),
            {"id": "o", "type": "output", "data": {}},
        ],
        "edges": [
            _edge("lfo", "mt", "trigger"),
            _edge("v1", "mt", "s1"),
            _edge("v2", "mt", "s2"),
            _edge("mt", "o", "video"),
        ],
    }
    G.validate(g)
    dag = G.Dag("job", seg, g, NOAUDIO, OUT)
    assert _feeds_a_montage(dag, "v1") and _feeds_a_montage(dag, "v2")
    speed = np.ones(12, np.float32)
    # in a slot: straight to the in-point, no 30s pre-roll
    assert _video_src0(dag.nodes["v1"]["data"], speed, 30.0, montage_slot=True) == 0.0
    assert _video_src0(dag.nodes["v2"]["data"], speed, 30.0, montage_slot=True) == 0.5
    # outside one, `sync="song"` keeps its pre-roll (background clips stay phase-continuous)
    assert _video_src0(dag.nodes["v1"]["data"], speed, 30.0) == 30.0

    # …and the rendered slots actually MOVE (this is what was frozen).
    frames = dag.video("o")
    diff = np.abs(np.diff(frames[..., :3].astype(np.int16), axis=0)).mean(axis=(1, 2, 3))
    assert (diff > 0.5).sum() >= len(diff) - 2  # every frame but the cut seams differs


@_needs_ffmpeg
def test_a_card_outside_a_montage_is_untouched(video_asset):
    """The rule is scoped to montage slots: a plain video → output pipeline keeps the
    song clock exactly as before."""
    from backend.graph_render import _feeds_a_montage

    g = {
        "version": 27,
        "nodes": [_video_card("v1", video_asset), {"id": "o", "type": "output", "data": {}}],
        "edges": [_edge("v1", "o", "video")],
    }
    dag = G.Dag("job", {"start": 30.0, "end": 31.0, "signals": []}, g, NOAUDIO, OUT)
    assert not _feeds_a_montage(dag, "v1")


# ── decoders and cache writers are per-slot, not per-segment ─────────────────
#
# A 23-slot 4K montage held 23 ffmpeg processes and ~4.9 GB to the end of the segment:
# every slot's chain was BUILT before frame 0, and nothing released a slot once its cut
# had passed. The eager build had a second victim — each slot opened a cache temp file
# up front, and the >5min reaper deleted the later ones mid-render ("finalize failed").
# Both paths carry the fix, and the whole-song export runs on the whole-clip one.


def _counting_video_node(nid, url, built, opened):
    """An image node whose source construction and close() are observable."""
    return _image_node(nid, url)


def test_a_slot_is_built_only_when_its_cut_arrives(assets, monkeypatch):
    """Lazy construction: rendering the first block must not build the last slot."""
    g = _montage_graph(assets, n_slots=3)
    dag = G.Dag("job", SEG, g, NOAUDIO, OUT)
    built = []
    real = dag._block_producer
    monkeypatch.setattr(dag, "_block_producer", lambda nid: (built.append(nid), real(nid))[1])
    produce = _montage_block(dag, dag.nodes["mt"])
    produce(0, 1)  # only the first slot plays here
    assert built == ["im1"], f"built {built} while rendering the first frame"
    produce(0, 12)  # the rest of the segment
    assert set(built) >= {"im1", "im2"}


def test_a_played_out_slot_releases_its_decoder_before_the_segment_ends(assets, monkeypatch):
    """The release has to happen DURING the render — at the end, Dag.close() would do
    it anyway and the peak would be unchanged."""
    g = _montage_graph(assets, n_slots=2)
    dag = G.Dag("job", SEG, g, NOAUDIO, OUT)
    closed = []
    real = dag._block_producer

    def spy(nid):
        p = real(nid)
        dag._closers.append(lambda nid=nid: closed.append(nid))
        return p

    monkeypatch.setattr(dag, "_block_producer", spy)
    produce = _montage_block(dag, dag.nodes["mt"])
    produce(0, 6)  # slot 1 only
    assert closed == []
    produce(6, 12)  # the cut lands: slot 1 is done for good
    assert "im1" in closed, "a played-out slot kept its decoder to the end of the segment"


def test_the_whole_clip_path_releases_each_slot_as_it_finishes(assets, monkeypatch):
    """The song export renders through `video()`, so the fix must live here too."""
    g = _montage_graph(assets, n_slots=2)
    dag = G.Dag("job", SEG, g, NOAUDIO, OUT)
    closed = []
    real = dag.video

    def spy(nid):
        frames = real(nid)
        if nid != "mt":
            dag._closers.append(lambda nid=nid: closed.append(nid))
        return frames

    monkeypatch.setattr(dag, "video", spy)
    _montage_video(dag, dag.nodes["mt"])
    assert set(closed) == {"im1", "im2"}, f"released {closed}"
    assert not dag._closers, "a released closer must not fire again on Dag.close()"


def test_an_entry_too_big_for_the_budget_is_not_written(monkeypatch, tmp_path):
    """A 4K slot is 2.2 GB against an 8 GB cap: writing it only evicts its siblings."""
    from backend import fluid_cache

    monkeypatch.setattr(fluid_cache, "CACHE_DIR", tmp_path)
    mm, _finalize, _discard = fluid_cache.frame_writer("huge", (72, 3840, 2160, 4))
    assert mm is None  # refused -> the render runs uncached instead of thrashing
    assert list(tmp_path.glob("*.npy")) == []  # and nothing was written
    mm2, _f2, d2 = fluid_cache.frame_writer("small", (8, 64, 64, 4))
    assert mm2 is not None  # ordinary entries are unaffected
    d2()
