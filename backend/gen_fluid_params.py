"""Generate `frontend/src/lib/fluidParams.js` from the backend param specs
(`animation_params.FLUID_PARAM_SPEC`, `COLOR_PARAM_SPEC`, `SOURCE_PARAM_SPEC`).

The frontend param tables are a pure projection of the backend specs, so there
is no hand-maintained mirror to drift. Run after editing a spec:

    python -m backend.gen_fluid_params          # rewrite the committed file
    python -m backend.gen_fluid_params --check   # exit 1 if the file is stale

`make gen-params` wraps the rewrite; CI / a pytest run the check (no-diff guard).
"""

from __future__ import annotations

import sys
from pathlib import Path

from .animation_params import COLOR_PARAM_SPEC, FLUID_PARAM_SPEC, SOURCE_PARAM_SPEC

_OUT = Path(__file__).resolve().parent.parent / "frontend" / "src" / "lib" / "fluidParams.js"

# fmt token -> the JS formatter expression placed on each row.
_FMT = {"dp1": "fmtFixed(1)", "dp2": "fmtFixed(2)", "dp3": "fmtFixed(3)", "deg": "fmtDeg"}


def _num(x: float) -> str:
    """A clean JS number literal: drop the trailing .0 on integral floats."""
    f = float(x)
    return str(int(f)) if f == int(f) else repr(f)


def _row(p: dict, group: str | None = None, indent: str = "  ") -> str:
    fields = [
        f'key: "{p["key"]}"',
        f'label: "{p["label"]}"',
        f'min: {_num(p["min"])}',
        f'max: {_num(p["max"])}',
        f'step: {_num(p["step"])}',
        f'def: {_num(p["default"])}',
        f'group: "{group or p["ui_group"]}"',
    ]
    if p["fmt"] is not None:
        fields.append(f'fmt: {_FMT[p["fmt"]]}')
    return indent + "{ " + ", ".join(fields) + " },"


def render() -> str:
    """The full fluidParams.js source string (deterministic)."""
    rows = "\n".join(_row(p) for p in FLUID_PARAM_SPEC)
    color_rows = "\n".join(_row(p, group="color") for p in COLOR_PARAM_SPEC)
    source_blocks = "\n".join(
        f'  "{card}": [\n' + "\n".join(_row(p, group="src", indent="    ") for p in spec) + "\n  ],"
        for card, spec in SOURCE_PARAM_SPEC.items()
    )
    return f"""\
// AUTO-GENERATED from backend/animation_params.py (FLUID_PARAM_SPEC,
// COLOR_PARAM_SPEC, SOURCE_PARAM_SPEC). Do NOT edit by hand — run `python -m
// backend.gen_fluid_params` (or `make gen-params`) and commit the result. A pytest
// asserts this file matches the specs.
//
// Native-unit ranges/defaults + UI metadata (label/step/group/fmt) for every
// modulatable port: the fluid card (01 §3.5), the color (dye) card, and the
// source layer cards (lyrics / image / video / backdrop).

const fmtFixed = (n) => (v) => v.toFixed(n);
const fmtDeg = (v) => `${{v | 0}}°`;

export const FLUID_PARAMS = [
{rows}
];

export const FLUID_PARAM_KEYS = FLUID_PARAMS.map((p) => p.key);

export const fluidParam = (k) => FLUID_PARAMS.find((p) => p.key === k);

// The color (dye) card's modulatable ports.
export const COLOR_PARAMS = [
{color_rows}
];

// Per source-card modulatable ports (lyrics / image / video / backdrop).
export const SOURCE_PARAMS = {{
{source_blocks}
}};
"""


def main(argv: list[str]) -> int:
    text = render()
    if "--check" in argv:
        current = _OUT.read_text() if _OUT.exists() else ""
        if current != text:
            print("fluidParams.js is stale — run `make gen-params` and commit.", file=sys.stderr)
            return 1
        print("fluidParams.js is up to date.")
        return 0
    _OUT.write_text(text)
    print(f"wrote {_OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
