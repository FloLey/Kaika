"""Bundled lyric fonts.

Drop a `.ttf`/`.otf` into `backend/assets/fonts/` and it becomes a choice in the lyrics
card's font picker — the key is the filename stem (lowercased), the label is the
prettified stem. An optional `fonts.json` in that dir can override label/order:
`[{"key": "inter", "label": "Inter", "order": 0}, ...]`.

The scan is cached, so adding a font is picked up on the next server start.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

FONTS_DIR = Path(__file__).resolve().parent / "assets" / "fonts"
DEFAULT_KEY = "inter"


def _label(stem: str) -> str:
    """ "ArchivoBlack" / "archivo_black" -> "Archivo Black"; "BebasNeue" -> "Bebas Neue"."""
    s = re.sub(r"[_-]+", " ", stem)
    s = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", s)  # split camelCase
    return " ".join(w[:1].upper() + w[1:] for w in s.split())


@lru_cache(maxsize=1)
def _scan() -> tuple[dict, ...]:
    """[{key, label, path, order}] for every bundled font, ordered."""
    if not FONTS_DIR.is_dir():
        return ()
    overrides: dict[str, dict] = {}
    manifest = FONTS_DIR / "fonts.json"
    if manifest.exists():
        try:
            overrides = {o["key"]: o for o in json.loads(manifest.read_text())}
        except (ValueError, KeyError, TypeError):
            overrides = {}
    fonts = []
    for p in sorted(FONTS_DIR.glob("*.ttf")) + sorted(FONTS_DIR.glob("*.otf")):
        key = p.stem.lower()
        ov = overrides.get(key, {})
        fonts.append(
            {
                "key": key,
                "label": ov.get("label", _label(p.stem)),
                "path": str(p),
                "order": int(ov.get("order", 999)),
            }
        )
    fonts.sort(key=lambda f: (f["order"], f["label"]))
    return tuple(fonts)


def list_fonts() -> list[dict]:
    """Public list `[{key, label}]` for the picker (no filesystem paths leaked)."""
    return [{"key": f["key"], "label": f["label"]} for f in _scan()]


def font_path(key: str | None) -> str | None:
    """Absolute path of the font with this key, or None if unknown."""
    if not key:
        return None
    for f in _scan():
        if f["key"] == key:
            return f["path"]
    return None


def default_key() -> str:
    """The default font key (`inter` when present, else the first bundled font)."""
    fonts = _scan()
    if any(f["key"] == DEFAULT_KEY for f in fonts):
        return DEFAULT_KEY
    return fonts[0]["key"] if fonts else ""
