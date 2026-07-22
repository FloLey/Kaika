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
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

DSN = os.environ.get("DATABASE_URL", "postgresql://demucs:demucs@localhost:5432/demucs")

# Transient "database is unreachable" error (restart / failover / not-up-yet).
# Callers that want to degrade gracefully (e.g. schema init at import) catch this
# specifically, so an unexpected DB error (bad SQL, constraint) still surfaces.
DBUnavailable = psycopg.OperationalError

# Brief connect retry so a momentary outage doesn't hard-fail a save.
_CONNECT_RETRIES = 3
_CONNECT_BACKOFF = 0.4  # seconds, multiplied by the attempt number

# Version of the project JSONB document shape ({schema_version, stems, segments,
# compositions, output}). Bump + add a step to `migrate_project_data` when the shape
# changes, so old saves upgrade on load instead of silently mis-parsing.
SCHEMA_VERSION = 2
DEFAULT_STEP = "review"  # a fresh project opens on the review screen


def migrate_project_data(data: dict | None) -> dict:
    """Upgrade a loaded project blob to SCHEMA_VERSION.

    v2 (compositions wave): graphs moved from `segments[i].graph` into the
    project-level pool `data.compositions`, and `finalOutputId` onto the
    composition (`outputId`). The v1→v2 step is DESTRUCTIVE by decision (specs/
    compositions/README.md §2): pre-pool animations are dropped rather than
    lifted, so an old project opens cleanly with empty animations instead of
    half-loading a shape the editor no longer speaks."""
    data = dict(data or {})
    if data.get("schema_version") == SCHEMA_VERSION:
        return data
    if (data.get("schema_version") or 0) < 2:
        data["segments"] = [
            {k: v for k, v in seg.items() if k not in ("graph", "finalOutputId")}
            for seg in data.get("segments") or []
            if isinstance(seg, dict)
        ]
        data["compositions"] = {}
    data["schema_version"] = SCHEMA_VERSION
    return data


_SCHEMA = f"""
CREATE TABLE IF NOT EXISTS projects (
  job_id     TEXT PRIMARY KEY,
  title      TEXT,
  source     TEXT,
  duration   DOUBLE PRECISION,
  fmin       INTEGER,
  has_lyrics BOOLEAN,
  step       TEXT DEFAULT '{DEFAULT_STEP}',
  data       JSONB NOT NULL DEFAULT '{{}}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_updated_at_idx ON projects (updated_at DESC);
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


def create_project(
    job_id: str,
    *,
    title: str,
    source: str,
    duration: float,
    fmin: int,
    has_lyrics: bool,
    stems: dict,
) -> None:
    """Insert (or replace) a project at the 'review' step with its stem map and
    an empty segment list — called right after demucs separation."""
    data = {"schema_version": SCHEMA_VERSION, "stems": stems, "segments": [], "compositions": {}}
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO projects
              (job_id, title, source, duration, fmin, has_lyrics, step, data)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (job_id) DO UPDATE SET
              title=EXCLUDED.title, source=EXCLUDED.source,
              duration=EXCLUDED.duration, fmin=EXCLUDED.fmin,
              has_lyrics=EXCLUDED.has_lyrics, data=EXCLUDED.data,
              updated_at=now()
            """,
            (job_id, title, source, duration, fmin, has_lyrics, DEFAULT_STEP, Jsonb(data)),
        )


def set_duration(job_id: str, duration: float) -> bool:
    """Update a project's duration (seconds). Used by the Playground's additive demo
    sync, which appends new card demos after the existing timeline and must extend the
    song to cover them. Returns False if the project doesn't exist."""
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE projects SET duration=%s, updated_at=now() WHERE job_id=%s",
            (duration, job_id),
        )
        return cur.rowcount > 0


def save_segments(
    job_id: str,
    segments: list,
    *,
    compositions: dict | None = None,
    step: str | None = None,
    title: str | None = None,
    output: dict | None = None,
    export: dict | None = None,
) -> bool:
    """Update the editable tree (segments + the composition pool they reference), and
    optionally the step/title, the project-wide `output` render settings, and the
    `export` (HD final render) settings. Used by /segment to seed the proposal and by
    the frontend autosave. A None `compositions`/`output`/`export` preserves the stored
    value (the proposal seeding carries no pool). The pool saves IN this payload — not
    out-of-band like assets — because it is client-owned editable state exactly like
    the graphs it now holds. Returns False if the project doesn't exist."""
    with _connect() as conn:
        cur = conn.execute(
            """
            UPDATE projects SET
              data = jsonb_set(
                       jsonb_set(
                         jsonb_set(
                           jsonb_set(
                             jsonb_set(data, '{segments}', %(segments)s, true),
                             '{compositions}',
                             COALESCE(%(compositions)s::jsonb, data->'compositions',
                                      '{}'::jsonb),
                             true),
                           '{output}',
                           COALESCE(%(output)s::jsonb, data->'output', '{}'::jsonb),
                           true),
                         '{export}',
                         COALESCE(%(export)s::jsonb, data->'export', '{}'::jsonb),
                         true),
                       '{schema_version}', %(schema_version)s, true),
              step = COALESCE(%(step)s, step),
              title = COALESCE(%(title)s, title),
              updated_at = now()
            WHERE job_id = %(job_id)s
            """,
            {
                "segments": Jsonb(segments),
                "compositions": Jsonb(compositions) if compositions is not None else None,
                "step": step,
                "title": title,
                "output": Jsonb(output) if output is not None else None,
                "export": Jsonb(export) if export is not None else None,
                "schema_version": Jsonb(SCHEMA_VERSION),
                "job_id": job_id,
            },
        )
        return cur.rowcount > 0


def list_projects() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute("""
            SELECT job_id, title, source, duration, has_lyrics, step,
                   to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SSZ') AS updated_at
            FROM projects
            WHERE job_id <> 'playground'  -- the app-managed Playground is not a user project
            ORDER BY updated_at DESC
            """).fetchall()
    return rows


def get_projects_full() -> list[dict[str, Any]]:
    """Every project row's (job_id, data) — Playground included — in ONE query/
    connection, each blob migrated. For whole-corpus scans (cache GC reachability)
    that would otherwise pay a connection per project."""
    with _connect() as conn:
        rows = conn.execute("SELECT job_id, data FROM projects").fetchall()
    for row in rows:
        row["data"] = migrate_project_data(row.get("data"))
    return rows


def get_project(job_id: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM projects WHERE job_id = %s", (job_id,)).fetchone()
    if row is not None:
        row["data"] = migrate_project_data(row.get("data"))
    return row


def delete_project(job_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM projects WHERE job_id = %s", (job_id,))
        return cur.rowcount > 0


# --------------------------------------------------------------------------- #
# Per-project asset library (data.assets) — server-managed (upload/YouTube routes
# append; a card/library pick just references the url). Kept OUT of the frontend
# autosave payload so an upload can't be clobbered by a concurrent segment save.
# --------------------------------------------------------------------------- #
def list_assets(job_id: str) -> list[dict[str, Any]]:
    """The project's asset library (`data.assets`), or [] if none / no project."""
    row = get_project(job_id)
    return (row.get("data") or {}).get("assets") or [] if row else []


def add_asset(job_id: str, asset: dict) -> bool:
    """Append an asset `{id, url, kind, name, addedAt}` to `data.assets` (dedup by id).
    Targeted jsonb update so it never touches segments/output. False if no project."""
    with _connect() as conn:
        cur = conn.execute(
            """
            UPDATE projects SET
              data = jsonb_set(
                       data, '{assets}',
                       (SELECT COALESCE(jsonb_agg(a), '[]'::jsonb)
                          FROM jsonb_array_elements(COALESCE(data->'assets', '[]'::jsonb)) a
                         WHERE a->>'id' <> %(id)s) || %(asset)s::jsonb,
                       true),
              updated_at = now()
            WHERE job_id = %(job_id)s
            """,
            {"job_id": job_id, "id": str(asset.get("id")), "asset": Jsonb([asset])},
        )
        return cur.rowcount > 0


def remove_asset(job_id: str, asset_id: str) -> bool:
    """Drop the asset with `asset_id` from `data.assets`. False if no project."""
    with _connect() as conn:
        cur = conn.execute(
            """
            UPDATE projects SET
              data = jsonb_set(
                       data, '{assets}',
                       (SELECT COALESCE(jsonb_agg(a), '[]'::jsonb)
                          FROM jsonb_array_elements(COALESCE(data->'assets', '[]'::jsonb)) a
                         WHERE a->>'id' <> %(id)s),
                       true),
              updated_at = now()
            WHERE job_id = %(job_id)s
            """,
            {"job_id": job_id, "id": str(asset_id)},
        )
        return cur.rowcount > 0
