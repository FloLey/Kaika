"""Graph executor — the thin public facade over the graph package.

A per-segment graph (`01`) -> a rendered, cached, looping mp4. The implementation
is split by responsibility; import from here (routes and tests do) unless you're
working inside the package:

  graph_common      shared constants + edge/node lookups + `composite`
  graph_validate    `validate` (ValueError -> HTTP 400)
  graph_hash        `output_hash` — the per-output render-cache key (01 §3.6)
  graph_modulators  value curves (signal/LFO/noise/shaper/math), colour cards,
                    points pipelines, `resolve_node_curve` (Scope)
  graph_render      `build_params`, the `Dag` resolver + handler registries,
                    `render` / `render_stream`

Directory paths (ANIM_DIR / STREAM_DIR / ASSETS_DIR) live in `paths` and are read
late-bound by the render code — patch `backend.paths` in tests.

Design notes (locked by the spec):
- Signal definitions ride in the request as `segment.signals` (Issue 1A). The
  executor indexes them by id and never touches the DB.
- Node resolution is memoized and type-dispatched (`resolve_source`) so a future
  `combine` node slots in as just another `nodeId` — no reshaping of the executor.
- The render cache hash folds in the defining fields of every *referenced* signal
  (01 §3.6) so editing a referenced signal busts the cache.
"""

from __future__ import annotations

# This list IS the public surface. It carried 22 further private names nobody imported
# (`LEGACY_GRID`, `_MERGE_MEDIUM_DEFAULTS`, `_sim_video`, `_encoder_error`, …) — a facade
# re-exporting names no caller uses documents nothing and invites new code to depend on
# internals. Import from the implementation module when working inside the package; add a
# name here only when something outside it needs the name.
#
# Re-exported module attributes (tests reach e.g. `graph.fluid`, `graph.signals`).
from . import fluid, signals  # noqa: F401
from .paths import ANIM_DIR, STREAM_DIR  # noqa: F401
from .graph_common import (  # noqa: F401
    FLUID_FPS,
    _POINT_CAP,
    _video_source,
    composite,
)
from .graph_validate import validate  # noqa: F401
from .graph_hash import _contributing_ids, output_hash  # noqa: F401
from .graph_modulators import (  # noqa: F401
    _animate_point_specs,
    _lfo_curve,
    _math_combine,
    _noise_curve,
    _pattern_points,
    _shaper_curve,
    _static_point_spec,
    resolve_node_curve,
)
from .graph_render import (  # noqa: F401
    _BLOCK_HANDLERS,
    _EMITTER_HANDLERS,
    _VIDEO_HANDLERS,
    Dag,
    build_params,
    render,
    render_stream,
    resolve_node_points,
    stylize_source,
)
