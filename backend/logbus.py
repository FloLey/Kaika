"""In-memory log ring buffer, mirrored from Python ``logging``.

A tiny singleton (same shape as ``jobs.py``: module globals + a ``threading.Lock``)
that keeps the last ``LOG_BUFFER`` log records so the frontend can poll them via
``GET /logs?since=<seq>`` and show a unified frontend+backend log stream.

A ``RingBufferHandler`` is attached to the root logger (alongside the usual
stdout ``StreamHandler``, which is left untouched), so anything logged anywhere in
the backend lands here automatically. A monotonic ``_SEQ`` counter keeps climbing
independently of the deque's eviction, so a client cursor stays valid even after
old entries fall off the end.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import deque

_LOCK = threading.Lock()
_SEQ = 0  # monotonic; never resets while the process lives
_BUF: deque[dict] = deque(maxlen=int(os.environ.get("LOG_BUFFER", "1000")))

# entry shape: {seq, ts (epoch seconds), level, source:"backend", logger, msg, trace}


def _level_name(levelno: int) -> str:
    """Map a Python logging level to the three UI levels."""
    if levelno >= logging.ERROR:
        return "error"
    if levelno >= logging.WARNING:
        return "warn"
    return "info"


def append(level: str, msg: str, *, logger: str = "app", trace: str | None = None) -> None:
    """Record one entry. Safe to call from any thread."""
    global _SEQ
    with _LOCK:
        _SEQ += 1
        _BUF.append(
            {
                "seq": _SEQ,
                "ts": time.time(),
                "level": level,
                "source": "backend",
                "logger": logger,
                "msg": msg,
                "trace": trace,
            }
        )


def since(seq: int) -> tuple[list[dict], int]:
    """Return ``(entries with seq > `seq`, current head seq)``."""
    with _LOCK:
        head = _SEQ
        if seq >= head:
            return [], head
        return [e for e in _BUF if e["seq"] > seq], head


def head_seq() -> int:
    with _LOCK:
        return _SEQ


class RingBufferHandler(logging.Handler):
    """Mirror every emitted record into the ring buffer.

    Added *alongside* the stdout handler, never replacing it — logging never gets
    a chance to crash the app (any failure is swallowed via ``handleError``).
    """

    def emit(self, record: logging.LogRecord) -> None:
        try:
            trace = (
                logging.Formatter().formatException(record.exc_info) if record.exc_info else None
            )
            append(
                _level_name(record.levelno), record.getMessage(), logger=record.name, trace=trace
            )
        except Exception:  # noqa: BLE001 — logging must never raise
            self.handleError(record)


def configure(level: int = logging.INFO) -> None:
    """Idempotent root-logger setup.

    Keeps the existing stdout output (adds a ``StreamHandler`` if the root has
    none) and attaches the ring-buffer handler exactly once — safe under Flask's
    debug reloader, which re-imports modules.
    """
    root = logging.getLogger()
    if getattr(root, "_kaika_log_configured", False):
        return
    root.setLevel(level)
    if not any(isinstance(h, logging.StreamHandler) for h in root.handlers):
        stream = logging.StreamHandler()
        stream.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        root.addHandler(stream)
    root.addHandler(RingBufferHandler())
    root._kaika_log_configured = True  # type: ignore[attr-defined]
