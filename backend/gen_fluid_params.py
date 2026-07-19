"""Generate the frontend files that are pure projections of backend tables.

    frontend/src/lib/fluidParams.js     <- animation_params.{FLUID,COLOR,SOURCE}_PARAM_SPEC
    frontend/src/lib/graph/generated.ts <- graph_common.VIDEO_PRODUCERS,
                                           graph_hash.{_SIGNAL_HASH_FIELDS,_SLOT_CARDS}

Neither has a hand-maintained mirror left to drift. The graph constants were copied by
hand until cleanup step 08, and drift there was silent BY CONSTRUCTION: the two sides
hash independently and the digests differ on purpose, so nothing ever failed loudly.

Run after editing any source table:

    python -m backend.gen_fluid_params           # rewrite the committed files
    python -m backend.gen_fluid_params --check   # exit 1 if either is stale

`make gen-params` wraps the rewrite; CI / a pytest run the check (no-diff guard).
"""

from __future__ import annotations

import sys
from pathlib import Path

from .animation_params import COLOR_PARAM_SPEC, FLUID_PARAM_SPEC, SOURCE_PARAM_SPEC
from .graph_common import VIDEO_PRODUCERS
from .graph_hash import _SIGNAL_HASH_FIELDS, _SLOT_CARDS

_LIB = Path(__file__).resolve().parent.parent / "frontend" / "src" / "lib"
_OUT = _LIB / "fluidParams.js"
_GRAPH_OUT = _LIB / "graph" / "generated.ts"

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


def _ts_list(values, indent: str = "  ") -> str:
    return "\n".join(f'{indent}"{v}",' for v in values)


def render_graph_constants() -> str:
    """`frontend/src/lib/graph/generated.ts` — the constants BOTH sides must agree on.

    These were hand-copied, and drift was silent by construction: the two sides hash
    independently and the digests differ on purpose, so nothing failed loudly. A card
    missing from the frontend producer set makes the editor refuse to render it; a field
    missing from either signal-hash list makes the preview and the export compute
    different cache keys and quietly disagree about what a graph IS — which presents as
    "the export doesn't match what I previewed" and reads like a render bug.
    """
    return f"""\
// AUTO-GENERATED from backend/graph_common.py (VIDEO_PRODUCERS) and
// backend/graph_hash.py (_SIGNAL_HASH_FIELDS, _SLOT_CARDS). Do NOT edit by hand — run
// `python -m backend.gen_fluid_params` (or `make gen-params`) and commit the result.
// CI runs the same command with --check as a no-diff guard.
//
// These three tables must match the backend exactly. They used to be hand-copied.

// Every node type that produces video. The editor refuses to render a card that is not
// in this set, so a card added to the backend only would silently fail to draw.
export const VIDEO_PRODUCERS: ReadonlySet<string> = new Set([
{_ts_list(sorted(VIDEO_PRODUCERS))}
]);

// Signal defining-fields folded into the render-cache hash. ORDER IS SIGNIFICANT — the
// hashed tuple is positional, so reordering changes every cache key.
export const SIGNAL_HASH_FIELDS: readonly string[] = [
{_ts_list(_SIGNAL_HASH_FIELDS)}
];

// Cards whose `data.inputs` is a list of wired SLOTS ({{id, …}}); an unwired slot is
// invisible to the render, so it must be invisible to the hash too.
export const SLOT_CARDS: ReadonlySet<string> = new Set([
{_ts_list(sorted(_SLOT_CARDS))}
]);
"""


_TARGETS = [
    (_OUT, render, "fluidParams.js"),
    (_GRAPH_OUT, render_graph_constants, "graph/generated.ts"),
]


def main(argv: list[str]) -> int:
    stale = []
    for path, build, name in _TARGETS:
        text = build()
        if "--check" in argv:
            if (path.read_text() if path.exists() else "") != text:
                stale.append(name)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        print(f"wrote {path}")
    if "--check" in argv:
        if stale:
            print(
                f"stale generated file(s): {', '.join(stale)} — run `make gen-params` and commit.",
                file=sys.stderr,
            )
            return 1
        print("generated files are up to date.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
