"""The HD export JOB BODIES — `_export_job`, `_segment_hd_job`, `_regenerate_hd_images`.

Cleanup step 22 left these uncovered on purpose, with a reason that still stands: they
need a diffusion model or a full render to reach, and "a mock deep enough to execute them
would be testing the mock". This file takes step 22's own way out — the one its procgen
half used successfully: assert PROPERTIES, not lines.

So nothing here mocks a renderer and then checks the mock was called. Each test names a
behaviour with a real failure mode:

- the HD-asset content key is what makes an unchanged re-export cheap. Break it and every
  export silently re-runs a model that costs minutes per image.
- `_export_job` hydrates segments with the pool's graphs BY REFERENCE. Copy them instead
  and the in-place HD assetUrl swaps land on a throwaway dict — the export renders the
  DRAFT images, looks fine, and is wrong in exactly the way nobody notices until they
  compare the master to the preview.
- both job bodies release `_HD_SLOT` from a `finally`. Miss it once on the failure path
  and every later export 409s for the life of the process, pointing at a render_id that
  finished long ago.

These take `routes/export.py` from 56% to 80%. What is left is left ON PURPOSE, and the
list is the point of writing it down:

- `_regenerate_hd_stylize`'s body past its early return — it runs a diffusion pipeline
  over rendered sim frames. There is no honest way to execute that here, and faking one
  deep enough would be the coverage theatre step 22 warned about. Its no-stylize-nodes
  early return IS covered, because that branch is real logic.
- the `imagegen.generate` + `img.save` + `db.add_asset` arm of `_regenerate_hd_images` —
  needs the ~33 GB Z-Image model. Every branch AROUND it is covered, including the one
  that decides not to enter it.
- `_segment_hd_job`'s mux arm — needs real stem audio and a real ffmpeg mux over a real
  rendered clip. `test_export_trim.py` already exercises ffmpeg muxing for its own path.

Every test here was mutation-checked rather than assumed: the deep-copy bug, a dropped
seed offset, and a key that ignores its prompt were each injected into `routes/export.py`
and confirmed to turn a test red. One test did NOT survive that check on the first pass —
it compared this file's key helper against itself, so a formula change made every case
miss the cache and pass for the wrong reason. That is why
`test_a_different_input_does_not_reuse_the_cached_image` asserts the baseline HIT first.
"""

from __future__ import annotations

import hashlib
import json

import pytest

from backend.routes import export as ex


@pytest.fixture
def free_slot():
    """A released slot before and after — the semaphore is module-global, so a test that
    leaves it held would 409 every later test."""
    _drain()
    yield
    _drain()


def _drain():
    while True:
        try:
            ex._HD_SLOT.release()
        except ValueError:  # BoundedSemaphore: already fully released
            break
    ex._HD_RUNNING = None


def _held() -> bool:
    """True if the HD slot is currently taken."""
    if ex._HD_SLOT.acquire(blocking=False):
        ex._HD_SLOT.release()
        return False
    return True


@pytest.fixture
def assets_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(ex, "ASSETS_DIR", tmp_path)
    return tmp_path


EXPORT = {"width": 1080, "height": 1920, "imageSize": 1024}


def _hd_name(prompt: str, seed: int, export=EXPORT) -> str:
    """Recompute the content key the way `_regenerate_hd_images` does, so a test can put
    a file exactly where the reuse branch will look for it."""
    from backend import imagegen

    aspect = (int(export["width"]), int(export["height"]))
    max_edge = imagegen.MODELS[imagegen.HD_MODEL]["max_edge"]
    w, h = imagegen._target_size(int(export["imageSize"]), aspect, max_edge)
    key = hashlib.sha256(f"{imagegen.HD_MODEL}|{seed}|{w}x{h}|{prompt}".encode()).hexdigest()[:16]
    return f"hd-{key}.png"


def _imagegen_seg(prompts, seed=7):
    return {
        "id": "s1",
        "graph": {
            "nodes": [{"id": "g1", "type": "imagegen", "data": {"prompts": prompts, "seed": seed}}]
        },
    }


def _no_model(monkeypatch):
    """Make `imagegen.generate` a hard failure. Any test that trips it was reaching for a
    model, which is exactly what these paths are supposed to avoid."""
    from backend import imagegen

    def boom(*a, **k):
        raise AssertionError("imagegen.generate was called — the HD asset should have been reused")

    monkeypatch.setattr(imagegen, "generate", boom)


# --------------------------------------------------------------------------- #
# _regenerate_hd_images — the content key IS the cost control
# --------------------------------------------------------------------------- #


def test_no_imagegen_nodes_is_a_no_op(assets_dir, monkeypatch):
    """The overwhelmingly common case: a project with no image-gen cards must not touch
    the model, the asset dir, or the DB."""
    _no_model(monkeypatch)
    segs = [{"id": "s1", "graph": {"nodes": [{"id": "f1", "type": "fluid", "data": {}}]}}]
    ex._regenerate_hd_images("j1", segs, EXPORT, None)
    assert not (assets_dir / "j1").exists()  # no per-job asset dir was ever created


def test_an_existing_hd_asset_is_reused_instead_of_regenerated(assets_dir, monkeypatch):
    """THE property this whole path exists for. HD assets are content-keyed on
    (model, seed, size, prompt), so re-exporting an unchanged project must reuse them —
    Z-Image is minutes per image, so a broken key turns a cache hit into a coffee break.

    `imagegen.generate` raises if called, so reuse is proven by the test not blowing up
    rather than by counting calls on a mock."""
    _no_model(monkeypatch)
    seg = _imagegen_seg(["a cat"], seed=7)
    name = _hd_name("a cat", 7)
    (assets_dir / "j1").mkdir(parents=True)
    (assets_dir / "j1" / name).write_bytes(b"png")

    ex._regenerate_hd_images("j1", [seg], EXPORT, None)

    assert seg["graph"]["nodes"][0]["data"]["assetUrls"] == [f"/assets/j1/{name}"]


@pytest.mark.parametrize(
    "label,prompt,seed,export",
    [
        ("prompt", "a dog", 7, EXPORT),
        ("seed", "a cat", 8, EXPORT),
        ("image size", "a cat", 7, {**EXPORT, "imageSize": 512}),
        ("aspect", "a cat", 7, {**EXPORT, "width": 1920, "height": 1080}),
    ],
)
def test_a_different_input_does_not_reuse_the_cached_image(
    label, prompt, seed, export, assets_dir, monkeypatch
):
    """The CONVERSE of the reuse test, and the one that actually has teeth. A routine that
    ignored its inputs would sail through the reuse test by always returning the same
    name — so each of prompt, seed, image size and aspect must MISS the cache.

    Driven through `_regenerate_hd_images` itself, never by comparing the test's key helper
    against itself. Each case asserts BOTH halves against the one cached file:

      1. the baseline ("a cat", 7, 1080x1920) DOES reuse it, and
      2. the varied input does NOT.

    Half 1 is what makes this honest. Without it, a key formula that dropped an input
    entirely would make every case miss the cache and the test would pass for exactly the
    wrong reason — verified by mutation, which is how this assertion came to be here."""
    from backend import imagegen

    calls = []
    monkeypatch.setattr(imagegen, "generate", lambda *a, **k: calls.append(1) or 1 / 0)

    (assets_dir / "j1").mkdir(parents=True)
    (assets_dir / "j1" / _hd_name("a cat", 7)).write_bytes(b"png")

    # 1. the baseline hits the cache — anchors the test's key helper to production's
    ex._regenerate_hd_images("j1", [_imagegen_seg(["a cat"], seed=7)], EXPORT, None)
    assert not calls, "the baseline missed its own cached image — the key helper has drifted"

    # 2. the varied input misses it
    with pytest.raises(ZeroDivisionError):  # the model was reached for
        ex._regenerate_hd_images("j1", [_imagegen_seg([prompt], seed=seed)], export, None)
    assert calls, f"a changed {label} still reused the cached image"


def test_the_second_prompt_gets_the_next_seed(assets_dir, monkeypatch):
    """Prompts within one card are seeded `seed + i`. Reusing one seed for all of them
    would make a multi-prompt card produce the same image N times."""
    _no_model(monkeypatch)
    seg = _imagegen_seg(["one", "two"], seed=7)
    (assets_dir / "j1").mkdir(parents=True)
    for prompt, s in (("one", 7), ("two", 8)):
        (assets_dir / "j1" / _hd_name(prompt, s)).write_bytes(b"png")

    ex._regenerate_hd_images("j1", [seg], EXPORT, None)

    urls = seg["graph"]["nodes"][0]["data"]["assetUrls"]
    assert urls == [f"/assets/j1/{_hd_name('one', 7)}", f"/assets/j1/{_hd_name('two', 8)}"]


def test_blank_prompts_are_skipped(assets_dir, monkeypatch):
    """Empty rows in the card's prompt list are UI slack, not work to do."""
    _no_model(monkeypatch)
    seg = _imagegen_seg(["real", "", "   "], seed=7)
    (assets_dir / "j1").mkdir(parents=True)
    (assets_dir / "j1" / _hd_name("real", 7)).write_bytes(b"png")

    ex._regenerate_hd_images("j1", [seg], EXPORT, None)

    assert seg["graph"]["nodes"][0]["data"]["assetUrls"] == [f"/assets/j1/{_hd_name('real', 7)}"]


def test_cancelling_leaves_the_draft_urls_alone(assets_dir, monkeypatch):
    """Regeneration is minutes long, so it polls `should_cancel`. On cancel it must return
    BEFORE swapping — a half-swapped node would export some HD and some draft images."""
    _no_model(monkeypatch)
    seg = _imagegen_seg(["a cat"], seed=7)
    seg["graph"]["nodes"][0]["data"]["assetUrls"] = ["/assets/j1/draft.png"]

    ex._regenerate_hd_images("j1", [seg], EXPORT, lambda: True)

    assert seg["graph"]["nodes"][0]["data"]["assetUrls"] == ["/assets/j1/draft.png"]


def test_the_swap_mutates_the_node_that_was_passed_in(assets_dir, monkeypatch):
    """The swap must land on the caller's node dict, not a copy. `_export_job` relies on
    this: it hands over the pool's own graphs so the render sees the HD urls."""
    _no_model(monkeypatch)
    seg = _imagegen_seg(["a cat"], seed=7)
    node = seg["graph"]["nodes"][0]
    (assets_dir / "j1").mkdir(parents=True)
    (assets_dir / "j1" / _hd_name("a cat", 7)).write_bytes(b"png")

    ex._regenerate_hd_images("j1", [seg], EXPORT, None)

    assert "assetUrls" in node["data"]  # the SAME object, not a rebuilt segment


def test_a_stylize_free_project_skips_the_diffusion_path(monkeypatch):
    """`_regenerate_hd_stylize`'s early return. Everything past it needs a real pipeline;
    this is the branch that keeps every stylize-free export off it."""
    segs = [{"id": "s1", "graph": {"nodes": [{"id": "f1", "type": "fluid", "data": {}}]}}]
    ex._regenerate_hd_stylize("j1", segs, {"width": 64, "height": 64}, None)


# --------------------------------------------------------------------------- #
# _export_job — hydration by reference, and the slot's `finally`
# --------------------------------------------------------------------------- #


@pytest.fixture
def pool():
    """A one-composition pool whose graph carries an imagegen node."""
    return {
        "c1": {
            "id": "c1",
            "graph": {
                "nodes": [
                    {"id": "g1", "type": "imagegen", "data": {"prompts": ["a cat"], "seed": 7}}
                ],
                "edges": [],
            },
        }
    }


def _segments():
    # `rootCompositionId` is the key `compositions.root_composition` resolves through —
    # a segment referencing the pool by any other name hydrates to a graph of None.
    return [{"id": "s1", "label": "INTRO", "start": 0.0, "end": 1.0, "rootCompositionId": "c1"}]


def test_export_job_hands_the_renderer_the_pools_own_graph(
    free_slot, pool, monkeypatch, assets_dir
):
    """The invariant the hydration comment is about, and the one with the nastiest failure
    mode. `_export_job` attaches each root composition's graph BY REFERENCE so the in-place
    HD assetUrl swap lands on the node dicts `render_song` will read. Deep-copy there and
    the export silently renders the DRAFT images — no error, right duration, wrong pixels.

    Asserted at the seam: after the job runs, the POOL's node carries the HD url."""
    _no_model(monkeypatch)
    (assets_dir / "j1").mkdir(parents=True)
    (assets_dir / "j1" / _hd_name("a cat", 7)).write_bytes(b"png")

    monkeypatch.setattr(ex, "_record_export", lambda *a, **k: None)
    monkeypatch.setattr(ex.song_render, "render_song", lambda *a, **k: "/fluid/song_x.mp4")

    ex._start_hd_render(lambda *a: None)  # take the slot the job's `finally` releases
    ex._export_job("j1", _segments(), pool, [], EXPORT, lambda **k: None, None)

    node = pool["c1"]["graph"]["nodes"][0]
    assert node["data"]["assetUrls"] == [f"/assets/j1/{_hd_name('a cat', 7)}"]


def test_the_slot_comes_back_when_the_render_raises(free_slot, pool, monkeypatch, assets_dir):
    """The `finally`. A leaked slot is invisible in dev — the next export just 409s
    forever against a render_id that finished long ago."""
    _no_model(monkeypatch)
    (assets_dir / "j1").mkdir(parents=True)
    (assets_dir / "j1" / _hd_name("a cat", 7)).write_bytes(b"png")

    def explode(*a, **k):
        raise RuntimeError("encoder died")

    monkeypatch.setattr(ex.song_render, "render_song", explode)

    ex._start_hd_render(lambda *a: None)
    assert _held()
    with pytest.raises(RuntimeError):
        ex._export_job("j1", _segments(), pool, [], EXPORT, lambda **k: None, None)
    assert not _held(), "the HD slot leaked on the failure path"


def test_a_cancelled_export_records_nothing(free_slot, pool, monkeypatch, assets_dir):
    """Cancelling between the asset pass and the render must return None and leave the
    bookkeeping untouched — recording a stem for an export that never finished would pin
    a nonexistent file against the GC sweep."""
    _no_model(monkeypatch)
    (assets_dir / "j1").mkdir(parents=True)
    (assets_dir / "j1" / _hd_name("a cat", 7)).write_bytes(b"png")

    recorded = []
    monkeypatch.setattr(ex, "_record_export", lambda *a, **k: recorded.append(a))
    monkeypatch.setattr(
        ex.song_render, "render_song", lambda *a, **k: pytest.fail("render ran after cancel")
    )

    ex._start_hd_render(lambda *a: None)
    out = ex._export_job("j1", _segments(), pool, [], EXPORT, lambda **k: None, lambda: True)

    assert out is None
    assert recorded == []
    assert not _held()


def test_a_finished_export_is_recorded_and_the_slot_released(
    free_slot, pool, monkeypatch, assets_dir, tmp_path
):
    """The happy path end to end at the seam: the returned url is recorded (so `cache_gc`
    treats the master as reachable) and the slot is handed back for the next export."""
    _no_model(monkeypatch)
    (assets_dir / "j1").mkdir(parents=True)
    (assets_dir / "j1" / _hd_name("a cat", 7)).write_bytes(b"png")
    monkeypatch.setattr(ex, "ANALYSIS_DIR", tmp_path)
    monkeypatch.setattr(ex.song_render, "render_song", lambda *a, **k: "/fluid/song_abc.mp4")

    ex._start_hd_render(lambda *a: None)
    out = ex._export_job("j1", _segments(), pool, [], EXPORT, lambda **k: None, None)

    assert out == "/fluid/song_abc.mp4"
    assert json.loads((tmp_path / "j1.json").read_text())["song_exports"] == ["song_abc"]
    assert not _held()


# --------------------------------------------------------------------------- #
# _segment_hd_job — the same `finally`, and the no-audio result
# --------------------------------------------------------------------------- #


def _seg_job_args(monkeypatch, render_result):
    """`_segment_hd_job`'s arguments with the RENDER stubbed and nothing else. Stubbing
    `render_stream` is not mocking the thing under test: this job's own logic is what
    happens either side of the render — the phases, the audio decision, the `finally` —
    and a real HD render here would be minutes of GPU for none of it."""
    monkeypatch.setattr(ex.graphmod, "render_stream", lambda *a, **k: render_result)
    seg = {"id": "s1", "label": "INTRO", "start": 0.0, "end": 1.0, "graph": {"nodes": []}}
    graph = {"nodes": [], "edges": []}
    return ("j1", seg, graph, "o1", {**EXPORT, "gridCells": 32}, None, False)


def test_a_segment_with_no_audio_returns_the_silent_clip(free_slot, monkeypatch):
    """A project whose stems never got built still exports — the silent render IS the
    result. Returning None there would read to the UI as a failed render."""
    monkeypatch.setattr(ex, "_record_export", lambda *a, **k: None)
    monkeypatch.setattr(ex.song_render, "export_audio_path", lambda *a, **k: None)
    args = _seg_job_args(monkeypatch, "/fluid/abc.mp4")

    ex._start_hd_render(lambda *a: None)
    out = ex._segment_hd_job(*args, lambda **k: None, None)

    assert out == "/fluid/abc.mp4"
    assert not _held()


def test_a_cancelled_segment_render_returns_none_and_frees_the_slot(free_slot, monkeypatch):
    """`render_stream` returns a falsey url when it was cancelled mid-render. The job must
    pass that through rather than muxing audio onto a clip that was never finished."""
    monkeypatch.setattr(ex.song_render, "export_audio_path", lambda *a, **k: None)
    args = _seg_job_args(monkeypatch, None)

    ex._start_hd_render(lambda *a: None)
    assert ex._segment_hd_job(*args, lambda **k: None, None) is None
    assert not _held()


def test_the_segment_job_frees_the_slot_when_the_render_raises(free_slot, monkeypatch):
    """Same `finally` as the whole-song job, written separately in the source — so it is
    worth pinning separately too."""

    def explode(*a, **k):
        raise RuntimeError("decoder died")

    monkeypatch.setattr(ex.graphmod, "render_stream", explode)
    seg = {"id": "s1", "label": "INTRO", "start": 0.0, "end": 1.0, "graph": {"nodes": []}}

    ex._start_hd_render(lambda *a: None)
    assert _held()
    with pytest.raises(RuntimeError):
        ex._segment_hd_job(
            "j1", seg, {"nodes": [], "edges": []}, "o1", EXPORT, None, False, lambda **k: None, None
        )
    assert not _held(), "the HD slot leaked on the segment path"


def test_the_export_job_publishes_an_assets_phase_before_rendering(
    free_slot, pool, monkeypatch, assets_dir
):
    """The UI sits at 0% through minutes of HD regeneration. The phase labels are the only
    thing that makes that wait legible, so they are part of the contract, not decoration."""
    _no_model(monkeypatch)
    (assets_dir / "j1").mkdir(parents=True)
    (assets_dir / "j1" / _hd_name("a cat", 7)).write_bytes(b"png")

    phases = []
    monkeypatch.setattr(ex, "_record_export", lambda *a, **k: None)
    monkeypatch.setattr(ex.song_render, "render_song", lambda *a, **k: "/fluid/song_x.mp4")

    def on_progress(*a, **k):
        if k.get("phase"):
            phases.append(k["phase"])

    ex._start_hd_render(lambda *a: None)
    ex._export_job("j1", _segments(), pool, [], EXPORT, on_progress, None)

    assert phases[0] == "assets"


# --------------------------------------------------------------------------- #
# _dream_short — the clamp that keeps a distilled model inside its native range
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "label,w,h,model_key,want",
    [
        # `_work_dims` scales the SHORT side to the grid aspect and clips nothing, so the
        # ceiling has to be applied here or a 9:16 master asks a 768-max model for 1360px.
        ("portrait, draft", 1080, 1920, "draft", 432),  # 432 * 16/9 = 768 = max_edge
        ("portrait, hd", 1080, 1920, "hd", 576),  # 576 * 16/9 = 1024 = max_edge
        ("landscape is the same ratio", 1920, 1080, "hd", 576),
        # Square has no long side to overflow, so the request stands as asked.
        ("square, hd", 1024, 1024, "hd", 768),
    ],
)
def test_the_dream_size_stays_inside_the_model_ceiling(label, w, h, model_key, want):
    """A Dream clip is diffused at `stylizeSize` (768) unless the aspect would push the
    LONG side past the model's native resolution — where a distilled few-step model tiles
    and repeats rather than merely softening.

    Asserted as exact pixel counts, not `<= max_edge`: an implementation that clamped to
    something needlessly small would satisfy an inequality and quietly cost the master
    resolution nobody would think to check."""
    from backend import imagegen

    model = imagegen.HD_MODEL if model_key == "hd" else imagegen.DRAFT_MODEL
    got = ex._dream_short({**EXPORT, "width": w, "height": h}, model)

    assert got == want, label
    long_edge = got * max(w, h) / min(w, h)
    assert long_edge <= imagegen.MODELS[model]["max_edge"] + 1, "clamped past the model's ceiling"


# --------------------------------------------------------------------------- #
# _regenerate_hd_dream — it generates from the GRAPH, not from what the card stored
# --------------------------------------------------------------------------- #


def _dream_seg(text="a forest", seg_id="s1", node_id="d1", model="draft", data=None):
    node = {
        "id": node_id,
        "type": "dream",
        "data": {"prompts": [{"id": "p1", "text": text}], "model": model, **(data or {})},
    }
    return {"id": seg_id, "graph": {"nodes": [node], "edges": []}}


@pytest.fixture
def dream_stubs(monkeypatch, assets_dir):
    """Stub the four module boundaries a Dream regeneration crosses — render, diffusion,
    encode, DB — and count the diffusions.

    Nothing here mocks the logic under test. The key, the cache check and the in-memory
    url swap all run for real; what is faked is a sim render, a ~2 GB model, ffmpeg and
    Postgres. `plan` is DERIVED from the node's prompts, which is what lets a prompt edit
    move the key the way it does in production."""
    import numpy as np

    from backend import fluid, imagegen
    from backend import graph as graphmod

    calls: list = []

    def plan_for(graph, node_id):
        node = next(n for n in graph["nodes"] if n["id"] == node_id)
        text = ((node.get("data") or {}).get("prompts") or [{}])[0].get("text", "")
        seed = int((node.get("data") or {}).get("seed") or 1)
        return [
            {"prompt_a": text, "prompt_b": None, "w": 0.0, "seed": seed, "scale": 0.7, "keep": 0.1}
            for _ in range(3)
        ]

    monkeypatch.setattr(
        graphmod,
        "dream_describe",
        lambda job, seg, graph, nid, *a, **k: ("c1", None, plan_for(graph, nid), 24),
    )
    monkeypatch.setattr(
        graphmod,
        "dream_source",
        lambda job, seg, graph, nid, *a, **k: (
            np.zeros((3, 8, 8, 3), np.uint8),
            None,
            plan_for(graph, nid),
            24,
        ),
    )
    monkeypatch.setattr(ex.graph_hash, "output_hash", lambda *a, **k: "UPSTREAM")

    def fake_frames(control, plan, **k):
        calls.append({"n": len(plan), "short": k.get("short"), "model": k.get("model")})
        for i, _ in enumerate(plan):  # the progress contract the export's bar rides on
            if k.get("on_progress"):
                k["on_progress"](i, len(plan))
        return np.zeros((len(plan), 8, 8, 3), np.uint8)

    monkeypatch.setattr(imagegen, "dream_frames", fake_frames)
    monkeypatch.setattr(
        fluid, "render_mp4", lambda frames, fps, path, **k: path.write_bytes(b"mp4")
    )
    monkeypatch.setattr(ex.db, "add_asset", lambda *a, **k: None)
    return calls


def test_no_dream_nodes_is_a_no_op(assets_dir, monkeypatch):
    """The common case. A project without a Dream card must not create an asset dir, and
    above all must not reach for a diffusion model."""
    from backend import imagegen

    monkeypatch.setattr(
        imagegen, "dream_frames", lambda *a, **k: pytest.fail("reached for the model")
    )
    segs = [{"id": "s1", "graph": {"nodes": [{"id": "f1", "type": "fluid", "data": {}}]}}]
    ex._regenerate_hd_dream("j1", segs, EXPORT, None)
    assert not (assets_dir / "j1").exists()


def test_a_dream_card_the_user_never_generated_is_generated_by_the_export(dream_stubs, assets_dir):
    """THE bug this path exists for. A `dream` node with no `assetUrl` renders as a
    PASSTHROUGH of its control input, so before this the export silently shipped raw canny
    edges — and per COMPOSITION, so a pool of nine copies needed nine separate ✨ clicks.

    Keying on the graph rather than on the card's stored url is what makes an ungenerated
    card impossible to ship by accident."""
    seg = _dream_seg()
    seg["graph"]["nodes"][0]["data"]["assetUrl"] = ""  # never generated in the editor

    ex._regenerate_hd_dream("j1", [seg], EXPORT, None)

    assert len(dream_stubs) == 1, "an ungenerated Dream card was left passing its control through"
    url = seg["graph"]["nodes"][0]["data"]["assetUrl"]
    assert url.startswith("/assets/j1/hd-dream-")
    assert (assets_dir / "j1" / url.rsplit("/", 1)[-1]).exists()


def test_an_unchanged_re_export_reuses_the_clip_and_a_prompt_edit_does_not(dream_stubs, assets_dir):
    """Both halves of the content key, driven through the real function so the test never
    compares a key helper against itself.

    Half 1 (reuse) alone would pass for a routine that ignored its inputs entirely; half 2
    (a prompt edit misses) alone would pass for one that never cached. At one diffusion
    call per frame over a whole song, getting either wrong is hours."""
    ex._regenerate_hd_dream("j1", [_dream_seg("a forest")], EXPORT, None)
    assert len(dream_stubs) == 1

    ex._regenerate_hd_dream("j1", [_dream_seg("a forest")], EXPORT, None)
    assert len(dream_stubs) == 1, "an unchanged re-export re-diffused the whole clip"

    ex._regenerate_hd_dream("j1", [_dream_seg("a burning forest")], EXPORT, None)
    assert len(dream_stubs) == 2, "a prompt edit reused a clip generated for another prompt"


def test_the_card_keeps_its_own_model_and_gains_the_export_size(dream_stubs, assets_dir):
    """Deliberately unlike `_regenerate_hd_stylize`, which forces `HD_MODEL`.

    `fadeShape` is tuned against the model the user previewed with — specs/dream/01
    measured SD-Turbo morphing evenly while Z-Image packs its change into a narrow band —
    so swapping the model at export time would re-read every fade they set as a soft cut.
    The export changes the SIZE, and the model select stays the user's call."""
    from backend import imagegen

    ex._regenerate_hd_dream("j1", [_dream_seg(model="draft")], EXPORT, None)
    ex._regenerate_hd_dream("j1", [_dream_seg("b", node_id="d2", model="hd")], EXPORT, None)

    assert dream_stubs[0]["model"] == imagegen.DRAFT_MODEL
    assert dream_stubs[1]["model"] == imagegen.HD_MODEL
    # ...and each at its own ceiling for this 9:16 master, not at the editor's preview size
    assert (dream_stubs[0]["short"], dream_stubs[1]["short"]) == (432, 576)


def test_a_dream_card_with_no_prompts_is_left_alone(dream_stubs, assets_dir):
    """There is nothing to generate from, and `dream_plan` would raise. Skipping keeps the
    card passing its control through — degraded, but an export that finishes."""
    seg = _dream_seg()
    seg["graph"]["nodes"][0]["data"]["prompts"] = []

    ex._regenerate_hd_dream("j1", [seg], EXPORT, None)

    assert not dream_stubs
    assert "assetUrl" not in seg["graph"]["nodes"][0]["data"]


def test_progress_counts_every_dream_card_as_one_run(dream_stubs, assets_dir):
    """Two cards, one bar. Per-card counters would rewind to 0 partway through the phase,
    which on the one part of an export that can run for hours is the difference between
    "slow" and "hung"."""
    segs = [_dream_seg("a", node_id="d1"), _dream_seg("b", node_id="d2")]
    seen: list = []

    ex._regenerate_hd_dream(
        "j1", segs, EXPORT, None, on_progress=lambda d, t, **k: seen.append((d, t, k.get("phase")))
    )

    assert {p for _, _, p in seen} == {"dream"}
    assert {t for _, t, _ in seen} == {6}, "the total was per-card, not per-phase"
    assert [d for d, _, _ in seen] == sorted(d for d, _, _ in seen), "the bar went backwards"


def test_a_cancel_between_cards_stops_before_the_next_diffusion(dream_stubs, assets_dir):
    """Cancellation is checked per card, not only per export. A user who cancels must not
    wait out another card's worth of diffusion."""
    segs = [_dream_seg("a", node_id="d1"), _dream_seg("b", node_id="d2")]

    ex._regenerate_hd_dream("j1", segs, EXPORT, lambda: len(dream_stubs) >= 1)

    assert len(dream_stubs) == 1
