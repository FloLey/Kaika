"""Import guards for optional heavy dependencies.

The app runs without the image/vision stack — the cards that need it just report that
it's unavailable. That only works if every call site fails the SAME way, with a message
naming the feature and the fix.

Before this, opencv was imported four different ways: `look_fx._cv2()` (guarded, "the
Color Grade card needs opencv"), an inline copy of the same guard in `graph_render` with
a different message, and two bare `import cv2` calls in `imagegen` that surface a raw
ImportError. This module is deliberately dependency-free so anything can import it —
putting the helper in `media.py` would have pulled torch and librosa onto the render path.
"""

from __future__ import annotations

from types import ModuleType


def require_cv2(feature: str) -> ModuleType:
    """The `cv2` module, or a RuntimeError naming which feature needs it.

    `feature` is the user-facing name, so the message points at the card they clicked:
    `require_cv2("the Color Grade card")`.
    """
    try:
        import cv2
    except ImportError as e:  # pragma: no cover — exercised only without opencv installed
        raise RuntimeError(f"{feature} needs opencv — `pip install -r requirements.txt`") from e
    return cv2
