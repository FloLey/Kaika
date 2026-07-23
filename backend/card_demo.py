"""The Playground pipelines — one valid graph per card.

Loaded from the committed fixture `playground_pipelines.json`, which is exported from
the live Playground (`python -m backend.seed_card_demo export`). So the defaults are
whatever you've designed in the UI: rework the Playground, re-export, and the seed
recreates exactly that.

`DEMOS` is the ordered list of `{key, label, signals, graph}` the seed turns into the
project's segments. `CARD_LABELS` / `ALL_CARDS` are the single source of truth for which
cards must be present — driving the coverage test and the import-time warning below.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

# The committed fixture of reworked playground pipelines (one per card).
PIPELINES_PATH = Path(__file__).resolve().parent / "playground_pipelines.json"

# EVERY droppable card the Playground must include, with its canonical display name
# (matches the frontend registry palette label = the segment label / rail entry). Keep
# in sync with the registry: adding a card means adding a row here AND a pipeline (via
# the UI + re-export). Single source of truth for the warning, the coverage test, and
# the export's label→key mapping.
CARD_LABELS = {
    "signal": "Signal",
    "lfo": "LFO",
    "noise": "Noise",
    "math": "Math",
    "shaper": "Shaper",
    "gate": "Gate",
    "change": "Change",
    "scope": "Scope",
    "points": "Points",
    "pattern": "Pattern",
    "animate-points": "Animate points",
    "merge-points": "Merge points",
    "fluid": "Fluid",
    "lyrics": "Lyrics",
    "text": "Text",
    "image": "Image",
    "slideshow": "Slideshow",
    "imagegen": "Image gen",
    "video": "Video",
    "color": "Color",
    "backdrop": "Backdrop",
    "waves": "Waves",
    "lightning": "Lightning",
    "fire": "Fire",
    "aurora": "Aurora",
    "rain": "Rain",
    "clouds": "Clouds",
    "combine": "Combine",
    "montage": "Montage",
    "transform": "Transform",
    "extract": "Extract",
    "stylize": "AI Stylize",
    "echo": "Echo",
    "colorgrade": "Color Grade",
    "output": "Output",
}
ALL_CARDS = set(CARD_LABELS)


def _load() -> list[dict]:
    """The fixture pipelines: `[{key, label, signals, graph}, …]`, in segment order."""
    if not PIPELINES_PATH.exists():
        logging.getLogger("kaika").error(
            "playground fixture missing: %s — run `python -m backend.seed_card_demo export`",
            PIPELINES_PATH,
        )
        return []
    return json.loads(PIPELINES_PATH.read_text())


DEMOS = _load()


def missing_cards() -> set[str]:
    """Cards with no Playground pipeline (should always be empty)."""
    return ALL_CARDS - {d["key"] for d in DEMOS}


# Loud warning at import if the Playground would be incomplete (the coverage test fails
# too). After adding a card to the registry, add a pipeline in the UI and re-export.
if missing_cards():
    logging.getLogger("kaika").warning(
        "Playground is MISSING a pipeline for cards: %s — add one in the UI then "
        "`python -m backend.seed_card_demo export`",
        sorted(missing_cards()),
    )
