"""Persist a generated asset's URL onto its node in the DB, server-side.

Shared by the AI Stylize and Dream routes. It exists because an HD run takes tens of
minutes: the card's own poll writes `assetUrl` too, but a reload or a closed tab mid-job
used to orphan the finished asset with the browser as the only writer. This is the durable
copy; the client write is idempotent on top of it.
"""

from __future__ import annotations

import logging

from .. import db

log = logging.getLogger("kaika")


def persist_asset_url(
    job_id: str, node_id: str, node_type: str, url: str, composition_id: str | None = None
) -> None:
    """Write `url` onto the `node_type` node `node_id` of project `job_id`.

    Reads the CURRENT graph (not the job's snapshot) so edits made during the run survive;
    a project or node deleted mid-job just logs. Best-effort by design — the job result
    still carries the asset either way.

    `composition_id` scopes the write to ONE composition. Copying a card into another
    segment keeps its node id, so a pool of nine compositions can hold nine independent
    copies of the same id — and writing to all of them puts one segment's clip on every
    segment. Callers that know which composition they generated for should say so; the
    unscoped form is kept for callers that genuinely mean "wherever this node lives".
    """
    try:
        row = db.get_project(job_id)
        if row is None:
            return
        segments = row["data"]["segments"]
        pool = row["data"].get("compositions") or {}
        scope = pool if composition_id is None else {composition_id: pool.get(composition_id)}
        hit = False
        for comp in scope.values():
            for n in ((comp or {}).get("graph") or {}).get("nodes", []):
                if n.get("id") == node_id and n.get("type") == node_type:
                    n.setdefault("data", {})["assetUrl"] = url
                    hit = True
        if hit:
            db.save_segments(job_id, segments, compositions=pool)
            log.info("%s: persisted %s onto node %s", node_type, url, node_id)
    except Exception:  # noqa: BLE001 — never fail the job at the finish line
        log.warning(
            "%s: could not persist assetUrl onto node %s", node_type, node_id, exc_info=True
        )
