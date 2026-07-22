import { describe, it, expect } from "vitest";

import { VIDEO_PRODUCERS, VIDEO_SOURCES, VIDEO_FX } from "../lib/graph/core";
import { SIGNAL_HASH_FIELDS, SLOT_CARDS } from "../lib/graph/generated";

// VIDEO_PRODUCERS / SIGNAL_HASH_FIELDS / SLOT_CARDS are now generated from the backend
// (`make gen-params`), so cross-language drift is a build failure rather than a silent
// disagreement. What is NOT generated is how the frontend GROUPS the producers:
// VIDEO_SOURCES and VIDEO_FX encode a rendering rule the backend has no notion of (an FX
// card is renderable only with its `video` input wired, and is never an emitter source).
//
// That leaves one seam a generator can't close: a new card added to the generated set but
// to neither grouping would be "a producer" yet fall through every branch that switches on
// the groupings. This pins the relationship between them.
describe("graph constants", () => {
  it("the hand-written groupings add up to the generated producer set", () => {
    const grouped = new Set<string>([
      ...VIDEO_SOURCES,
      ...VIDEO_FX,
      // Not in either grouping, deliberately: these take N slot inputs (combine, montage)
      // or are the terminal (output), and `fluid` is the simulation itself.
      "fluid",
      "combine",
      "montage",
      "output",
    ]);
    const missing = [...VIDEO_PRODUCERS].filter((t) => !grouped.has(t));
    const extra = [...grouped].filter((t) => !VIDEO_PRODUCERS.has(t));

    expect(missing, "producers in the generated set that no grouping claims").toEqual([]);
    expect(extra, "grouped types the backend does not consider producers").toEqual([]);
  });

  it("a card is in at most one of VIDEO_SOURCES and VIDEO_FX", () => {
    const both = [...VIDEO_SOURCES].filter((t) => VIDEO_FX.has(t));
    expect(both, "a card cannot be both a source and a pass-through effect").toEqual([]);
  });

  it("the generated tables are non-empty and correctly shaped", () => {
    // Cheap smoke: a generator bug that emitted empty tables would otherwise make every
    // graph "invalid" in ways that look like a graph bug, not a build bug.
    expect(VIDEO_PRODUCERS.size).toBeGreaterThan(10);
    // Only combine takes wired slots now — the montage's extracts are data references
    // into the composition pool, all render-visible, so it left SLOT_CARDS with them.
    expect(SLOT_CARDS.has("combine")).toBe(true);
    expect(SLOT_CARDS.has("montage")).toBe(false);
    // Order is significant — the backend hashes these positionally.
    expect(SIGNAL_HASH_FIELDS[0]).toBe("stemKey");
    expect(new Set(SIGNAL_HASH_FIELDS).size).toBe(SIGNAL_HASH_FIELDS.length);
  });
});
