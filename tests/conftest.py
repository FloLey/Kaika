"""Shared fixtures for the backend test suite."""

from __future__ import annotations

import shutil
import sys

import pytest

# Every data directory a test could write to. `backend.paths` is the single definition
# point, but ~10 modules bind these at import time (`from .paths import ASSETS_DIR`), so
# patching `paths` alone leaves those bindings pointing at the developer's real `data/`.
# The fixture below patches both, which also unifies the two conventions the suite had
# grown (some tests patched `paths.X`, others patched the importing module's copy).
_PATH_NAMES = (
    "DATA_DIR",
    "UPLOAD_DIR",
    "SEPARATED_DIR",
    "SPECTRO_DIR",
    "ANALYSIS_DIR",
    "FLUID_DIR",
    "ANIM_DIR",
    "STREAM_DIR",
    "ASSETS_DIR",
    "SETTINGS_FILE",
    "JOBS_STATE_FILE",
)


@pytest.fixture(autouse=True)
def isolated_paths(tmp_path, monkeypatch):
    """Point every data directory at this test's tmp dir, in `backend.paths` AND in every
    module that imported one of them by value — then fail if anything still landed in the
    repo's real `data/`.

    Without the leak check this is invisible: `data/` is gitignored, so a test writing a
    stray clip or asset there shows up in neither `git status` nor a red run.
    """
    from backend import fluid_cache, paths

    real_data = paths.DATA_DIR
    before = {p.name for p in real_data.iterdir()} if real_data.exists() else set()

    root = tmp_path / "data"
    replacements = {}
    for name in _PATH_NAMES:
        original = getattr(paths, name, None)
        if original is None:
            continue
        # Keep each entry's position under DATA_DIR (uploads/, fluid/stream/, …).
        try:
            rel = original.relative_to(paths.DATA_DIR)
            new = root / rel
        except ValueError:
            new = root / original.name
        replacements[name] = (original, new)
        monkeypatch.setattr(paths, name, new)
    for name in (
        "UPLOAD_DIR",
        "SEPARATED_DIR",
        "SPECTRO_DIR",
        "ANALYSIS_DIR",
        "FLUID_DIR",
        "ANIM_DIR",
        "STREAM_DIR",
        "ASSETS_DIR",
    ):
        if name in replacements:
            replacements[name][1].mkdir(parents=True, exist_ok=True)  # fmt: skip

    # The Playground demos reference BUNDLED assets (sample.png / sample.mp4 / clip*.mp4,
    # written by seed_card_demo). test_card_impact renders those 34 demos, so it needs
    # them readable — link the real dir in rather than copying megabytes per test. Read
    # only: nothing writes through the link, and the leak check below still guards the
    # rest of data/.
    real_playground = real_data / "assets" / "playground"
    if real_playground.exists() and "ASSETS_DIR" in replacements:
        link = replacements["ASSETS_DIR"][1] / "playground"
        if not link.exists():
            link.symlink_to(real_playground, target_is_directory=True)

    # Re-point the by-value importers — UNCONDITIONALLY, not "only if it still equals the
    # original". A module imported lazily DURING a test (`backend.routes.serving` arrives
    # with the `client` fixture) binds whatever `paths` held at that moment, i.e. the
    # previous test's tmp dir; monkeypatch never touched it, so it has nothing to undo and
    # the stale value survives into the next test. That is a served-clip 404 that only
    # appears when tests run in a particular order — the worst kind to debug.
    # These names are ours by construction, so there is no risk of hitting a foreign
    # attribute that happens to share one.
    for module in list(sys.modules.values()):
        if not getattr(module, "__name__", "").startswith("backend"):
            continue
        for name, (_original, new) in replacements.items():
            if hasattr(module, name):
                monkeypatch.setattr(module, name, new, raising=False)

    # The raw-frame cache lives outside DATA_DIR's tree in the same spirit.
    monkeypatch.setattr(fluid_cache, "CACHE_DIR", root / "fluid_cache")

    yield

    if real_data.exists():
        leaked = {p.name for p in real_data.iterdir()} - before
        assert not leaked, (
            f"test wrote into the REAL data dir: {sorted(leaked)}. Use the tmp paths "
            f"this fixture installs (they are gitignored, so a leak is otherwise silent)."
        )


@pytest.fixture
def client():
    """A Flask test client on the full app. Importing the app pulls in the ML stack,
    so skip (not fail) where torch isn't installed (e.g. the minimal CI image)."""
    pytest.importorskip("torch")
    from backend.app import app

    app.config["TESTING"] = True
    return app.test_client()


@pytest.fixture
def live_db():
    """Guard for tests that need a reachable Postgres: init the schema or skip."""
    from backend import db

    try:
        db.init_schema()
    except db.DBUnavailable:
        pytest.skip("no database reachable")


# ---- dependency honesty -----------------------------------------------------
# ffmpeg / torch / Postgres missing => tests skip SILENTLY, so "487 passed" hides an
# unknown number of tests that never ran. Always report the count; `--strict-deps` makes
# it a failure, for a machine that is supposed to have everything.


def pytest_addoption(parser):
    parser.addoption(
        "--strict-deps",
        action="store_true",
        default=False,
        help="fail the run if any test was skipped for a missing dependency",
    )


def pytest_terminal_summary(terminalreporter, exitstatus, config):  # noqa: ARG001
    skipped = terminalreporter.stats.get("skipped", [])
    if not skipped:
        return
    buckets: dict[str, int] = {}
    for report in skipped:
        reason = str(report.longrepr[2] if isinstance(report.longrepr, tuple) else report.longrepr)
        low = reason.lower()
        key = (
            "ffmpeg"
            if "ffmpeg" in low
            else (
                "database"
                if "database" in low or "postgres" in low
                else (
                    "torch"
                    if "torch" in low or "importorskip" in low
                    else reason.replace("Skipped: ", "")[:40]
                )
            )
        )
        buckets[key] = buckets.get(key, 0) + 1
    terminalreporter.write_sep("-", "skipped for missing dependencies")
    for key, n in sorted(buckets.items(), key=lambda kv: -kv[1]):
        terminalreporter.write_line(f"  {n:4d}  {key}")
    if config.getoption("--strict-deps"):
        terminalreporter.write_line("  --strict-deps: these count as failures")
        raise pytest.UsageError(f"{len(skipped)} test(s) skipped for missing dependencies")


def pytest_report_header(config):  # noqa: ARG001
    have = [
        name
        for name, ok in (
            ("ffmpeg", shutil.which("ffmpeg") is not None),
            ("torch", _importable("torch")),
            ("postgres", _db_reachable()),
        )
        if ok
    ]
    missing = [n for n in ("ffmpeg", "torch", "postgres") if n not in have]
    return f"deps: have {', '.join(have) or 'none'}" + (
        f" — MISSING {', '.join(missing)} (those tests will skip)" if missing else ""
    )


def _importable(name: str) -> bool:
    try:
        __import__(name)
        return True
    except Exception:  # noqa: BLE001 — a broken install is "not available" too
        return False


def _db_reachable() -> bool:
    try:
        from backend import db

        db.init_schema()
        return True
    except Exception:  # noqa: BLE001
        return False
