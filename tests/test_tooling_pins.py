"""The lint/test tool versions are declared in three places; they must agree.

`requirements-dev.txt` is the source of truth. CI installs with `-c requirements-dev.txt`
so it cannot disagree by construction, but `.pre-commit-config.yaml` pins its own `rev:`
per hook and nothing connects it to anything — so a `pip install -r requirements-dev.txt`
after a bump leaves the hook running the old ruff, which is exactly how "passes locally,
fails in CI" (or worse, the reverse) starts.

This is a text-comparison test on config files, which is unusual for this suite. It earns
its place because the failure it catches is invisible: every tool still runs, all of them
still pass, and they disagree about what passing means.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[1]
_DEV = _ROOT / "requirements-dev.txt"
_PRECOMMIT = _ROOT / ".pre-commit-config.yaml"
_CI = _ROOT / ".github" / "workflows" / "ci.yml"


def _dev_pins() -> dict[str, str]:
    """{tool: version} from requirements-dev.txt, ignoring unpinned entries."""
    out = {}
    for line in _DEV.read_text().splitlines():
        m = re.match(r"^([A-Za-z0-9_.-]+)==([0-9][^\s#]*)", line.strip())
        if m:
            out[m.group(1).lower()] = m.group(2)
    return out


def test_requirements_dev_pins_the_tools_we_gate_on():
    pins = _dev_pins()
    for tool in ("ruff", "black", "pytest", "pytest-cov"):
        assert tool in pins, f"{tool} lost its pin in requirements-dev.txt"


@pytest.mark.parametrize("tool", ["ruff", "black"])
def test_pre_commit_rev_matches_requirements_dev(tool):
    """A pre-commit hook pinned to a different version than the one `make lint` runs will
    reformat code the other rejects, one file at a time, forever."""
    pins = _dev_pins()
    text = _PRECOMMIT.read_text()
    # the repo line names the tool; the `rev:` under it carries the version (a leading v
    # is pre-commit's convention, e.g. `rev: v0.15.19`)
    m = re.search(rf"repo:.*{tool}[^\n]*\n\s*rev:\s*v?([0-9][^\s#]*)", text, re.IGNORECASE)
    assert m, f"no pinned {tool} hook found in .pre-commit-config.yaml"
    assert m.group(1) == pins[tool], (
        f".pre-commit-config.yaml pins {tool} {m.group(1)} but requirements-dev.txt says "
        f"{pins[tool]} — bump both, or the hook and `make lint` disagree"
    )


def test_ci_installs_tools_under_a_constraint_file_rather_than_its_own_pins():
    """CI must not restate versions. It used to pin ruff/black/pytest/pytest-cov inline,
    which is a fourth copy that drifts silently; `-c requirements-dev.txt` makes the
    agreement structural instead of aspirational."""
    ci = _CI.read_text()
    assert "-c requirements-dev.txt" in ci, "CI stopped constraining its tool install"
    assert "-c requirements.txt" in ci, "CI stopped constraining its runtime install"
    for tool in ("ruff==", "black==", "pytest=="):
        assert tool not in ci, f"CI re-pinned {tool} inline instead of using the constraint file"


def test_ci_runtime_install_is_covered_by_requirements():
    """Every package CI installs for the test run must be pinned in requirements.txt --
    `-c` only constrains what the file mentions, so an unlisted package silently stays
    unpinned and the constraint gives false comfort."""
    ci = _CI.read_text()
    m = re.search(r"pip install -c requirements\.txt ([^\n]+)", ci)
    assert m, "the constrained runtime install line moved"
    names = [n.strip().strip('"').split("[")[0] for n in m.group(1).split()]
    reqs = _ROOT.joinpath("requirements.txt").read_text().lower()
    for name in names:
        assert re.search(rf"^{re.escape(name.lower())}\b", reqs, re.M), (
            f"CI installs {name!r} but requirements.txt does not pin it — `-c` will leave "
            "it floating"
        )
