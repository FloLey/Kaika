"""The in-memory log ring buffer and the `/logs` feed.

The frontend has `logbus.test.ts`; the backend half had nothing. Most importantly the
"`/logs` must never log" rule — called a hard invariant in CLAUDE.md and in the route's
own docstring — existed only as prose. A single `log.info` in that handler makes every
poll create an entry the next poll fetches: a feed that grows because it is being read.
"""

from __future__ import annotations

import logging

import pytest

from backend import logbus


@pytest.fixture(autouse=True)
def clean_buffer():
    with logbus._LOCK:
        logbus._BUF.clear()
    yield
    with logbus._LOCK:
        logbus._BUF.clear()


def test_append_then_since_returns_only_newer_entries():
    _, head0 = logbus.since(0)
    logbus.append("info", "first")
    logbus.append("warn", "second")

    entries, head = logbus.since(head0)
    assert [e["msg"] for e in entries] == ["first", "second"]
    assert head == head0 + 2

    # A cursor at the head sees nothing new — this is what makes polling cheap.
    assert logbus.since(head) == ([], head)


def test_seq_keeps_climbing_past_eviction(monkeypatch):
    """The deque evicts, but the cursor must stay valid: `_SEQ` is monotonic and
    independent of the buffer's length, so a client that fell behind gets whatever
    survived rather than a rewound sequence."""
    from collections import deque

    monkeypatch.setattr(logbus, "_BUF", deque(maxlen=3))
    _, head0 = logbus.since(0)
    for i in range(6):
        logbus.append("info", f"m{i}")

    entries, head = logbus.since(head0)
    assert head == head0 + 6
    assert [e["msg"] for e in entries] == ["m3", "m4", "m5"]  # only the last 3 survive
    assert [e["seq"] for e in entries] == [head0 + 4, head0 + 5, head0 + 6]


@pytest.mark.parametrize(
    "levelno,expected",
    [
        (logging.DEBUG, "info"),
        (logging.INFO, "info"),
        (logging.WARNING, "warn"),
        (logging.ERROR, "error"),
        (logging.CRITICAL, "error"),
    ],
)
def test_python_levels_map_to_the_three_ui_levels(levelno, expected):
    assert logbus._level_name(levelno) == expected


def test_handler_mirrors_a_logged_record_including_its_traceback():
    handler = logbus.RingBufferHandler()
    _, head0 = logbus.since(0)
    try:
        raise ValueError("boom")
    except ValueError:
        logging.getLogger("kaika.test").error("it broke", exc_info=True)
        record = logging.LogRecord(
            "kaika.test", logging.ERROR, __file__, 0, "it broke", None, __import__("sys").exc_info()
        )
        handler.emit(record)

    entries, _ = logbus.since(head0)
    mirrored = [e for e in entries if e["msg"] == "it broke"]
    assert mirrored, "the handler did not mirror the record"
    assert mirrored[-1]["level"] == "error"
    assert "ValueError: boom" in (mirrored[-1]["trace"] or "")


def test_handler_never_raises_on_a_bad_record(monkeypatch):
    """`logging must never raise` — a failure inside emit goes to handleError, so a
    broken log call can't take a request down with it."""
    handler = logbus.RingBufferHandler()
    handled = []
    monkeypatch.setattr(handler, "handleError", lambda r: handled.append(r))

    class Exploding(logging.LogRecord):
        def getMessage(self):
            raise RuntimeError("bad format args")

    handler.emit(Exploding("x", logging.INFO, __file__, 0, "%d", ("not-an-int",), None))
    assert handled, "emit swallowed the failure without reporting it to handleError"


def test_logs_route_does_not_log_itself(client):
    """The runaway guard. Poll `/logs` repeatedly and assert the head sequence does not
    advance: if the handler logged anything, reading the feed would extend it."""
    client.get("/logs?since=0")  # warm any lazy import that might legitimately log
    before = client.get("/logs?since=0").get_json()["seq"]
    for _ in range(5):
        client.get(f"/logs?since={before}")
    after = client.get(f"/logs?since={before}").get_json()["seq"]

    assert after == before, (
        "polling /logs advanced the log sequence — the endpoint logged something, so each "
        "poll now creates an entry the next poll fetches"
    )


def test_logs_route_tolerates_a_junk_since_cursor(client):
    """`since=abc` must fall back to 0, not 400 — the panel would otherwise wedge."""
    r = client.get("/logs?since=abc")
    assert r.status_code == 200
    assert "entries" in r.get_json()


def test_logs_route_is_never_cached(client):
    """A cached log feed shows a frozen tail."""
    assert client.get("/logs?since=0").headers["Cache-Control"] == "no-store"
