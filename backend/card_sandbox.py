"""Safe compile + smoke-test for a generated card's `curve()` source.

A "card builder" card carries an LLM-authored Python function

    def curve(data, nframes, fps, inputs):
        ...
        return arr  # float32 (nframes,) in 0..1

which the value resolver runs to produce a node's 0..1 modulation curve. That
source is generated, not written by a human, so before it ever runs in the render
pipeline we (1) statically reject anything that could reach outside pure numeric
work — imports, `eval`/`exec`/`open`, underscore/dunder attribute escapes — (2)
exec it in a namespace whose `__builtins__` expose only safe scalars plus `np` /
`math`, and (3) smoke-test it on synthetic inputs under a wall-clock guard so an
infinite loop or a wrong-shaped return is caught at *generation* time, not mid
render.

Threat model: a *local, single-user* tool whose only untrusted author is its own
local model — we're guarding against "the model wrote something dumb or runaway,"
not a determined adversary. The AST allowlist + restricted builtins + timed smoke
test are proportionate to that; they are not a hardened jail.
"""

from __future__ import annotations

import ast
import math
import threading

import numpy as np


class SandboxError(Exception):
    """The generated source failed a safety check or the smoke test."""


# Builtins the curve body may call. Everything numeric/iterative it plausibly
# needs, and nothing that can reach the filesystem, import, or introspect objects.
_SAFE_BUILTINS = {
    "abs": abs, "min": min, "max": max, "round": round, "range": range,
    "len": len, "float": float, "int": int, "bool": bool, "sum": sum,
    "pow": pow, "sorted": sorted, "enumerate": enumerate, "zip": zip,
    "map": map, "filter": filter, "list": list, "tuple": tuple, "dict": dict,
    "set": set, "reversed": reversed, "all": all, "any": any, "divmod": divmod,
}

# Names that must never appear (dynamic exec, IO, or introspection escapes). The
# restricted `__builtins__` already omits most of these; the static check makes a
# generated card that *tries* one fail loudly at build time with a clear reason.
_FORBIDDEN_NAMES = frozenset({
    "eval", "exec", "compile", "open", "__import__", "input", "breakpoint",
    "globals", "locals", "vars", "getattr", "setattr", "delattr", "hasattr",
    "exit", "quit", "help", "memoryview", "super", "object", "type",
    "classmethod", "staticmethod", "property",
})

# nframes used for the build-time smoke test.
_SMOKE_NFRAMES = 30
_SMOKE_TIMEOUT_S = 2.0


def _reject(msg: str) -> None:
    raise SandboxError(msg)


def _check_ast(tree: ast.AST) -> None:
    """Walk the parsed source and reject anything outside pure numeric work."""
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            _reject("imports are not allowed in a card's curve")
        if isinstance(node, (ast.Global, ast.Nonlocal)):
            _reject("global/nonlocal are not allowed in a card's curve")
        # `x.__class__`, `x._foo` — underscore attributes are the classic escape
        # hatch out of a restricted namespace, so ban them wholesale.
        if isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            _reject(f"attribute access to '{node.attr}' is not allowed")
        if isinstance(node, ast.Name) and node.id in _FORBIDDEN_NAMES:
            _reject(f"use of '{node.id}' is not allowed")
        # Bare underscore-name reads (e.g. `__builtins__`) are escapes too.
        if isinstance(node, ast.Name) and node.id.startswith("__"):
            _reject(f"use of '{node.id}' is not allowed")


def compile_curve(curve_src: str):
    """Validate, compile, and exec `curve_src` in a restricted namespace, returning
    the `curve` callable. Raises SandboxError on any safety violation or if the
    source doesn't define a top-level `curve` function."""
    if not isinstance(curve_src, str) or not curve_src.strip():
        _reject("curve source is empty")
    try:
        tree = ast.parse(curve_src, mode="exec")
    except SyntaxError as e:  # noqa: BLE001 - report the message to the caller
        _reject(f"curve source has a syntax error: {e}")
    _check_ast(tree)

    defines_curve = any(
        isinstance(n, ast.FunctionDef) and n.name == "curve" for n in tree.body
    )
    if not defines_curve:
        _reject("curve source must define a top-level function named 'curve'")

    namespace: dict = {"__builtins__": _SAFE_BUILTINS, "np": np, "math": math}
    try:
        exec(compile(tree, "<card-curve>", "exec"), namespace)  # noqa: S102 - sandboxed
    except Exception as e:  # noqa: BLE001 - surface as a build failure
        _reject(f"curve source failed to load: {e}")
    fn = namespace.get("curve")
    if not callable(fn):
        _reject("'curve' is not callable")
    return fn


def _run_with_timeout(fn, args, timeout: float):
    """Run `fn(*args)` in a daemon thread, raising SandboxError if it overruns.
    The thread leaks on timeout (Python can't kill it), which is acceptable for a
    local dev tool — the point is to fail generation, not to render the runaway."""
    box: dict = {}

    def target():
        try:
            box["result"] = fn(*args)
        except Exception as e:  # noqa: BLE001 - reported below as a build failure
            box["error"] = e

    t = threading.Thread(target=target, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        _reject(f"curve did not finish within {timeout:.0f}s (possible infinite loop)")
    if "error" in box:
        _reject(f"curve raised at runtime: {box['error']}")
    return box.get("result")


def smoke_test(fn, *, n_inputs: int = 0, controls: list | None = None) -> None:
    """Run `fn` once on synthetic inputs and assert it returns a finite float array
    of shape (nframes,). Builds a `data` dict from the controls' defaults so the
    body sees the keys it expects. Raises SandboxError on any failure."""
    data = {c["key"]: c.get("default", 0) for c in (controls or []) if "key" in c}
    inputs = [np.zeros(_SMOKE_NFRAMES, np.float32) for _ in range(n_inputs)]
    result = _run_with_timeout(fn, (data, _SMOKE_NFRAMES, 30, inputs), _SMOKE_TIMEOUT_S)
    arr = np.asarray(result, dtype=np.float32)
    if arr.shape != (_SMOKE_NFRAMES,):
        _reject(
            f"curve must return a 1-D array of length nframes; got shape {arr.shape}"
        )
    if not np.all(np.isfinite(arr)):
        _reject("curve returned non-finite values (nan/inf)")


def build_curve(curve_src: str, *, n_inputs: int = 0, controls: list | None = None):
    """Compile + smoke-test in one step. Returns the validated `curve` callable."""
    fn = compile_curve(curve_src)
    smoke_test(fn, n_inputs=n_inputs, controls=controls)
    return fn
