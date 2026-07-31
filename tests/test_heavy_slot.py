"""The shared GPU slot (`backend/heavy.py`) and the two routes that take it.

The rule it enforces is not "one at a time for tidiness". Two diffusion loops on one MPS
device do not queue — `imagegen._infer_lock` interleaves them frame by frame, so BOTH
take twice as long. Measured on the machine this came from: a Dream pass alone ran
~80 s/frame; with an HD export's Dream pass beside it, both sat at ~83 s/frame each.

So each test names a way the slot could fail open, and every one of them ends with two
heavy jobs on one device:

- a second claim admitted while the first holds it,
- a release by a job that no longer holds it, freeing the slot out from under its
  successor,
- a route that claims but never releases on the error path, wedging it the other way for
  the life of the process.
"""

from __future__ import annotations

import pytest

from backend import heavy


@pytest.fixture(autouse=True)
def _free():
    """The slot is module-global; a test that left it held would 409 every later one."""
    _drain()
    yield
    _drain()


def _drain():
    held = heavy.holder()
    if held is not None:
        heavy.release(held[1])


@pytest.fixture
def app_ctx():
    """`heavy.refusal` is turned into a response with `jsonify`, which needs an app
    context — the tests that call the admission helpers directly push one."""
    pytest.importorskip("torch")
    from backend.app import app

    with app.app_context():
        yield app


def test_a_second_claim_is_refused_and_names_the_holder():
    assert heavy.claim(heavy.HD_RENDER, "r1") is None
    assert heavy.claim(heavy.GENERATE, "g1") == (heavy.HD_RENDER, "r1")
    assert heavy.holder() == (heavy.HD_RENDER, "r1"), "the refused claim took the slot anyway"


def test_the_refusal_carries_what_the_ui_needs_to_act():
    """A 409 that only said "busy" would leave the user with nothing to do but retry. The
    id is what lets the UI point at (or cancel) the job actually holding the device."""
    heavy.claim(heavy.GENERATE, "g1")
    body, status = heavy.refusal(heavy.holder())
    assert status == 409
    assert body["running"] == {"kind": heavy.GENERATE, "id": "g1"}
    assert heavy.GENERATE in body["error"]


def test_releasing_by_the_wrong_id_does_nothing():
    """THE dangerous one. A job whose `finally` runs late — after it was cancelled and a
    new job claimed — must not free a slot it no longer holds. A blind release would put
    the next two heavy jobs on the device together, through the very path meant to keep
    them apart."""
    heavy.claim(heavy.HD_RENDER, "r1")
    heavy.release("some-older-job")
    assert heavy.holder() == (heavy.HD_RENDER, "r1")


def test_a_release_frees_it_for_the_other_kind():
    heavy.claim(heavy.HD_RENDER, "r1")
    heavy.release("r1")
    assert heavy.holder() is None
    assert heavy.claim(heavy.GENERATE, "g1") is None


def test_adopt_rekeys_without_ever_letting_go():
    """An HD render must hold the slot before `render_jobs.start` runs — two requests
    would otherwise both start a job — but the render_id it publishes comes OUT of that
    call. `adopt` swaps the id with the slot still held."""
    heavy.claim(heavy.HD_RENDER, "starting")
    heavy.adopt("starting", "r-real")
    assert heavy.holder() == (heavy.HD_RENDER, "r-real")
    assert heavy.claim(heavy.GENERATE, "g1") is not None, "the slot opened during the swap"
    heavy.release("r-real")
    assert heavy.holder() is None, "release no longer matches the adopted id"


def test_adopt_ignores_a_stale_key():
    """Only the live claim can be re-keyed; a late `adopt` from a finished job must not
    rename somebody else's hold."""
    heavy.claim(heavy.GENERATE, "g1")
    heavy.adopt("starting", "r-real")
    assert heavy.holder() == (heavy.GENERATE, "g1")


# --------------------------------------------------------------------------- #
# The two routes that take it
# --------------------------------------------------------------------------- #


def test_a_sparkle_is_refused_while_an_hd_render_holds_the_gpu(client):
    """The whole point, from the studio's side: ✨ during an HD render used to be
    admitted and then crawl."""
    heavy.claim(heavy.HD_RENDER, "r1")
    r = client.post(
        "/dream/abc12345",
        json={
            "graph": {
                "nodes": [{"id": "d1", "type": "dream", "data": {"prompts": [{"text": "a"}]}}]
            },
            "segment": {"id": "s1", "start": 0, "end": 1},
            "node_id": "d1",
        },
    )
    assert r.status_code == 409
    assert r.json["running"]["kind"] == heavy.HD_RENDER


def test_an_hd_render_is_refused_while_a_sparkle_holds_the_gpu(app_ctx):
    """And the converse — the direction that did NOT exist before, because the old slot
    only knew about other HD renders.

    Driven through `_start_hd_render` rather than a route: it is the single admission
    both HD entry points funnel through, and reaching either route's call to it first
    needs a project in the DB, which would make this a test about fixtures."""
    from backend.routes import export as ex

    heavy.claim(heavy.GENERATE, "g1")
    refused, render_id = ex._start_hd_render(lambda *a: None)
    assert render_id is None
    body, status = refused
    assert status == 409
    assert body.json["running"] == {"kind": heavy.GENERATE, "id": "g1"}
    assert heavy.holder() == (heavy.GENERATE, "g1"), "the refused HD render stole the slot"


def test_the_hd_refusal_keeps_its_legacy_render_id_field(app_ctx):
    """The HD buttons have polled `render_id` since before this slot was shared. Dropping
    it when the holder IS an HD render would leave the UI unable to name the job it is
    already showing progress for."""
    from backend.routes import export as ex

    heavy.claim(heavy.HD_RENDER, "r1")
    refused, _ = ex._start_hd_render(lambda *a: None)
    assert refused[0].json["render_id"] == "r1"


def test_a_refused_sparkle_leaves_the_slot_with_its_owner(client):
    """A refusal must not touch the holder — the classic claim-then-refuse bug frees the
    device for whoever asked second."""
    heavy.claim(heavy.HD_RENDER, "r1")
    client.post(
        "/dream/abc12345",
        json={
            "graph": {
                "nodes": [{"id": "d1", "type": "dream", "data": {"prompts": [{"text": "a"}]}}]
            },
            "segment": {"id": "s1", "start": 0, "end": 1},
            "node_id": "d1",
        },
    )
    assert heavy.holder() == (heavy.HD_RENDER, "r1")


def test_a_rejected_sparkle_never_claimed_in_the_first_place(client):
    """Validation runs BEFORE admission: a malformed request must not wedge the device.
    This one has no prompts, so the route 400s — and the slot has to stay free, or one bad
    click locks out every generation and every export until a restart."""
    r = client.post(
        "/dream/abc12345",
        json={
            "graph": {"nodes": [{"id": "d1", "type": "dream", "data": {"prompts": []}}]},
            "segment": {"id": "s1", "start": 0, "end": 1},
            "node_id": "d1",
        },
    )
    assert r.status_code == 400
    assert heavy.holder() is None
