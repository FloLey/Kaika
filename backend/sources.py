"""Non-fluid video SOURCE cards (spec 04) — the thin public facade over the package.

These synthesise a video stream from scratch (no fluid sim) so they can be layered with
fluids via a stack combine or sent straight to an output. `SOURCE_PARAMS` mirrors the
modulatable ranges in lib/nodeParams.ts; the box/outline/font are static `data` fields.

The implementation is split by WHERE THE PIXELS COME FROM — the three groups shared a
namespace but never each other's code (cleanup step 27):

  sources_common   `SOURCE_PARAMS` + `_at` (per-frame parameter sampling)
  sources_text     `lyrics` and its font / wrap / auto-fit machinery
  sources_gen      `backdrop` + the simulation-backed cards (waves, lightning,
                   aurora, rain, clouds) — physics in `procgen`, compositing there
  sources_media    the file-backed cards: image, video, slideshow, and the
                   fractional-box placement helpers only they use

Import from here (routes, tests and `graph_render` do) unless you're working inside the
package.
"""

from __future__ import annotations

# This list IS the public surface, in the sense graph.py's is: a name earns a place by
# having a caller outside the package, not by being exported before the split. `_fit` is
# private and here on purpose — test_graph_lyrics drives the auto-fit through it
# directly.
from .sources_common import SOURCE_PARAMS  # noqa: F401
from .sources_text import _fit, lyrics  # noqa: F401
from .sources_gen import (  # noqa: F401
    aurora,
    backdrop,
    clouds,
    lightning,
    rain,
    waves,
)
from .sources_media import (  # noqa: F401
    SlideshowClip,
    VideoClip,
    apply_video_opacity,
    image,
    video_src_times,
)
