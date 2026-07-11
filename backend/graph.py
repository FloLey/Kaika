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

# Re-exported module attributes (tests reach e.g. `graph.fluid`, `graph.signals`).
from . import fluid, fluid_cache, render_cache, signals, sources  # noqa: F401
from .paths import ANIM_DIR, ASSETS_DIR, STREAM_DIR  # noqa: F401
from .graph_common import (  # noqa: F401
    _PORT_SPECS,
    FLUID_FPS,
    LEGACY_GRID,
    _POINT_CAP,
    _field_nodes,
    _fluid_for_output,
    _is_emitter_source,
    _nodes_of,
    _output_params,
    _video_source,
    composite,
)
from .graph_validate import _has_cycle, _validate_binding, validate  # noqa: F401
from .graph_hash import (  # noqa: F401
    RENDER_VERSION,
    _SIGNAL_HASH_FIELDS,
    _contributing_ids,
    _node_for_hash,
    _referenced_signal_defs,
    output_hash,
)
from .graph_modulators import (  # noqa: F401
    _animate_point_specs,
    _lfo_curve,
    _make_value_resolver,
    _math_combine,
    _noise_curve,
    _pattern_points,
    _resolve_node_color,
    _sample_gradient,
    _shaper_curve,
    _signal_curve,
    _source_statics,
    _static_point_spec,
    resolve_node_curve,
)
from .graph_render import (  # noqa: F401
    _BLOCK_HANDLERS,
    _EMITTER_HANDLERS,
    _MERGE_MEDIUM_DEFAULTS,
    _VIDEO_HANDLERS,
    _VIDEO_PRODUCERS,
    RENDER_BLOCK_SECONDS,
    Dag,
    _Dag,
    _fluid_cache_key,
    _sim_blocks,
    _sim_video,
    build_params,
    render,
    render_stream,
    resolve_node_points,
    stylize_source,
)

# Back-compat alias — the encoder lifecycle helpers live in fluid.py now.
_encoder_error = fluid.encoder_error
