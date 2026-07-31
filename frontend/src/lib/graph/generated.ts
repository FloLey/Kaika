// AUTO-GENERATED from backend/graph_common.py (VIDEO_PRODUCERS) and
// backend/graph_hash.py (_SIGNAL_HASH_FIELDS, _SLOT_CARDS). Do NOT edit by hand — run
// `python -m backend.gen_fluid_params` (or `make gen-params`) and commit the result.
// CI runs the same command with --check as a no-diff guard.
//
// These three tables must match the backend exactly. They used to be hand-copied.

// Every node type that produces video. The editor refuses to render a card that is not
// in this set, so a card added to the backend only would silently fail to draw.
export const VIDEO_PRODUCERS: ReadonlySet<string> = new Set([
  "aurora",
  "backdrop",
  "clouds",
  "colorgrade",
  "combine",
  "dream",
  "echo",
  "extract",
  "fire",
  "fluid",
  "image",
  "lightning",
  "lyrics",
  "montage",
  "output",
  "rain",
  "slideshow",
  "stylize",
  "text",
  "transform",
  "video",
  "waves",
]);

// Signal defining-fields folded into the render-cache hash. ORDER IS SIGNIFICANT — the
// hashed tuple is positional, so reordering changes every cache key.
export const SIGNAL_HASH_FIELDS: readonly string[] = [
  "stemKey",
  "minHz",
  "maxHz",
  "feature",
  "attack",
  "release",
  "invert",
  "gamma",
  "gain",
  "offset",
  "threshold",
];

// Cards whose `data.inputs` is a list of wired SLOTS ({id, …}); an unwired slot is
// invisible to the render, so it must be invisible to the hash too.
export const SLOT_CARDS: ReadonlySet<string> = new Set([
  "combine",
]);
