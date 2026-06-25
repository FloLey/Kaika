"""Postgres persistence for resumable projects.

Heavy artifacts (audio, stems, spectrograms, analysis cache) stay on the
filesystem keyed by ``job_id``; this module stores only the *editable* project
tree — segments, their labels/boundaries, and per-segment isolation edits — as a
JSONB document, plus a few scalar columns for the project list.

Connections are short-lived (opened per call): simplest correct choice for the
threaded Flask dev server and a local single-user tool.
"""
from __future__ import annotations

import os
import time
from typing import Any, Optional

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

DSN = os.environ.get(
    "DATABASE_URL", "postgresql://demucs:demucs@localhost:5432/demucs"
)

# Transient "database is unreachable" error (restart / failover / not-up-yet).
# Callers that want to degrade gracefully (e.g. schema init at import) catch this
# specifically, so an unexpected DB error (bad SQL, constraint) still surfaces.
DBUnavailable = psycopg.OperationalError

# Brief connect retry so a momentary outage doesn't hard-fail a save.
_CONNECT_RETRIES = 3
_CONNECT_BACKOFF = 0.4  # seconds, multiplied by the attempt number

# Version of the project JSONB document shape ({schema_version, stems, segments,
# output}). Bump + add a step to `migrate_project_data` when the shape changes, so
# old saves upgrade on load instead of silently mis-parsing.
SCHEMA_VERSION = 1


def migrate_project_data(data: dict | None) -> dict:
    """Upgrade a loaded project blob to SCHEMA_VERSION. Currently only stamps the
    version on pre-versioning saves; future shape changes add a step here."""
    data = dict(data or {})
    if data.get("schema_version") == SCHEMA_VERSION:
        return data
    # (no breaking transitions yet — a v0/unversioned blob is shape-compatible.)
    data["schema_version"] = SCHEMA_VERSION
    return data

_SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
  job_id     TEXT PRIMARY KEY,
  title      TEXT,
  source     TEXT,
  duration   DOUBLE PRECISION,
  fmin       INTEGER,
  has_lyrics BOOLEAN,
  step       TEXT DEFAULT 'review',
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
"""


def _connect():
    """Open a short-lived connection, retrying briefly on a transient outage so a
    momentary blip (DB restart / failover) doesn't hard-fail the request."""
    last: DBUnavailable | None = None
    for attempt in range(_CONNECT_RETRIES):
        try:
            return psycopg.connect(DSN, row_factory=dict_row)
        except DBUnavailable as e:
            last = e
            if attempt < _CONNECT_RETRIES - 1:
                time.sleep(_CONNECT_BACKOFF * (attempt + 1))
    raise last


def init_schema() -> None:
    with _connect() as conn:
        conn.execute(_SCHEMA)


def create_project(job_id: str, *, title: str, source: str, duration: float,
                   fmin: int, has_lyrics: bool, stems: dict) -> None:
    """Insert (or replace) a project at the 'review' step with its stem map and
    an empty segment list — called right after demucs separation."""
    data = {"schema_version": SCHEMA_VERSION, "stems": stems, "segments": []}
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO projects
              (job_id, title, source, duration, fmin, has_lyrics, step, data)
            VALUES (%s, %s, %s, %s, %s, %s, 'review', %s)
            ON CONFLICT (job_id) DO UPDATE SET
              title=EXCLUDED.title, source=EXCLUDED.source,
              duration=EXCLUDED.duration, fmin=EXCLUDED.fmin,
              has_lyrics=EXCLUDED.has_lyrics, data=EXCLUDED.data,
              updated_at=now()
            """,
            (job_id, title, source, duration, fmin, has_lyrics, Jsonb(data)),
        )


def save_segments(job_id: str, segments: list, *, step: Optional[str] = None,
                  title: Optional[str] = None, output: Optional[dict] = None) -> bool:
    """Update the editable tree (segments + per-segment tracks), and optionally
    the step/title and the project-wide `output` render settings. Used by /segment
    to seed the proposal and by the frontend autosave. `output=None` preserves the
    stored value. Returns False if the project doesn't exist."""
    with _connect() as conn:
        cur = conn.execute(
            """
            UPDATE projects SET
              data = jsonb_set(
                       jsonb_set(
                         jsonb_set(data, '{segments}', %(segments)s, true),
                         '{output}',
                         COALESCE(%(output)s::jsonb, data->'output', '{}'::jsonb),
                         true),
                       '{schema_version}', %(schema_version)s, true),
              step = COALESCE(%(step)s, step),
              title = COALESCE(%(title)s, title),
              updated_at = now()
            WHERE job_id = %(job_id)s
            """,
            {"segments": Jsonb(segments), "step": step, "title": title,
             "output": Jsonb(output) if output is not None else None,
             "schema_version": Jsonb(SCHEMA_VERSION), "job_id": job_id},
        )
        return cur.rowcount > 0


def list_projects() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT job_id, title, source, duration, has_lyrics, step,
                   to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SSZ') AS updated_at
            FROM projects ORDER BY updated_at DESC
            """
        ).fetchall()
    return rows


def get_project(job_id: str) -> Optional[dict[str, Any]]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM projects WHERE job_id = %s", (job_id,)
        ).fetchone()
    if row is not None:
        row["data"] = migrate_project_data(row.get("data"))
    return row


def delete_project(job_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM projects WHERE job_id = %s", (job_id,))
        return cur.rowcount > 0
