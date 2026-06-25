import { describe, it, expect } from "vitest";
import {
  LABELS, LABEL_COLOR, hydrateSegments, serializeSegments,
} from "../lib/segments.js";

// A minimal stems map (only `sr` is read by the hydration path).
const STEMS = {
  original: { sr: 44100 }, vocals: { sr: 44100 }, drums: { sr: 44100 },
  bass: { sr: 44100 }, other: { sr: 44100 },
};

// Drop the always-fresh ids so two hydrations are comparable.
const stripIds = (segs) =>
  segs.map((s) => ({ ...s, id: undefined, signals: s.signals.map((g) => ({ ...g, id: undefined })) }));

describe("segments persistence contract", () => {
  it("preserves a saved signal's fields through hydrate -> serialize", () => {
    const raw = [{
      start: 0, end: 10, label: "verse",
      signals: [{
        name: "vox band", stemKey: "vocals", feature: "energy",
        minHz: 100, maxHz: 500, attack: 10, release: 300,
        gamma: 1.5, gain: 1.2, offset: 0.1, threshold: 0.2, invert: true,
      }],
    }];
    const out = serializeSegments(hydrateSegments(raw, STEMS));
    expect(out[0].start).toBe(0);
    expect(out[0].end).toBe(10);
    expect(out[0].label).toBe("verse");
    const sig = out[0].signals.find((s) => s.minHz === 100 && s.maxHz === 500);
    expect(sig).toMatchObject({
      stemKey: "vocals", feature: "energy", attack: 10, release: 300,
      gamma: 1.5, gain: 1.2, offset: 0.1, threshold: 0.2, invert: true,
    });
  });

  it("is idempotent once defaults are present (re-hydrate adds nothing)", () => {
    const first = serializeSegments(hydrateSegments(
      [{ start: 0, end: 10, label: "verse", signals: [] }], STEMS));
    const second = serializeSegments(hydrateSegments(first, STEMS));
    expect(stripIds(second)).toEqual(stripIds(first));
  });
});

describe("label palette", () => {
  it("has a colour for every label", () => {
    for (const label of LABELS) {
      expect(LABEL_COLOR[label], `missing colour for ${label}`).toBeTruthy();
    }
  });
});
