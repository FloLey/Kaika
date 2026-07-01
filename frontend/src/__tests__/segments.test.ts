import { describe, it, expect } from "vitest";
import { LABELS, LABEL_COLOR, hydrateSegments, serializeSegments, copyLayout } from "../lib/segments";
import type { RawSegment } from "../lib/segments";
import type { Graph, Segment, Signal } from "../lib/types";

// A minimal stems map (only `sr` is read by the hydration path).
const STEMS = {
  original: { sr: 44100 },
  vocals: { sr: 44100 },
  drums: { sr: 44100 },
  bass: { sr: 44100 },
  other: { sr: 44100 },
};

// Drop the always-fresh ids so two hydrations are comparable.
const stripIds = (segs: RawSegment[]) =>
  segs.map((s) => ({
    ...s,
    id: undefined,
    signals: (s.signals ?? []).map((g) => ({ ...g, id: undefined })),
  }));

describe("segments persistence contract", () => {
  it("preserves a saved signal's fields through hydrate -> serialize", () => {
    const raw = [
      {
        start: 0,
        end: 10,
        label: "verse",
        signals: [
          {
            name: "vox band",
            stemKey: "vocals",
            feature: "energy",
            minHz: 100,
            maxHz: 500,
            attack: 10,
            release: 300,
            gamma: 1.5,
            gain: 1.2,
            offset: 0.1,
            threshold: 0.2,
            invert: true,
          },
        ],
      },
    ];
    const out = serializeSegments(hydrateSegments(raw, STEMS));
    expect(out[0].start).toBe(0);
    expect(out[0].end).toBe(10);
    expect(out[0].label).toBe("verse");
    const sig = out[0].signals!.find((s) => s.minHz === 100 && s.maxHz === 500);
    expect(sig).toMatchObject({
      stemKey: "vocals",
      feature: "energy",
      attack: 10,
      release: 300,
      gamma: 1.5,
      gain: 1.2,
      offset: 0.1,
      threshold: 0.2,
      invert: true,
    });
  });

  it("is idempotent once defaults are present (re-hydrate adds nothing)", () => {
    const first = serializeSegments(
      hydrateSegments([{ start: 0, end: 10, label: "verse", signals: [] }], STEMS)
    );
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

describe("copyLayout (copy cards to the next segment)", () => {
  const sig = (id: string, over: Partial<Signal> = {}): Signal => ({
    id,
    stemKey: "drums",
    minHz: 40,
    maxHz: 200,
    feature: "energy",
    attack: 5,
    release: 250,
    invert: false,
    gamma: 1,
    gain: 1,
    offset: 0,
    threshold: 0,
    ...over,
  });
  const seg = (id: string, signals: Signal[], graph: Graph | null): Segment => ({
    id,
    label: id,
    start: 0,
    end: 8,
    signals,
    graph,
  });
  const graphWith = (signalId: string): Graph =>
    ({
      version: 8,
      nodes: [
        { id: "n-sig", type: "signal", x: 0, y: 0, data: { signalId } },
        { id: "n-fluid", type: "fluid", x: 0, y: 0, data: { static: {}, ports: {} } },
      ],
      edges: [],
    }) as unknown as Graph;
  const sigId = (g: Graph) =>
    (g.nodes.find((n) => n.type === "signal")!.data as { signalId: string }).signalId;

  it("rewires the copied signal card onto the target's matching band (no duplicate)", () => {
    const out = copyLayout(seg("A", [sig("s-src")], graphWith("s-src")), seg("B", [sig("s-tgt")], null));
    expect(out.signals).toHaveLength(1); // matched the existing band, added nothing
    expect(sigId(out.graph!)).toBe("s-tgt"); // points at THIS segment's signal, not the source's
    expect(out.graph!.nodes.some((n) => n.type === "fluid")).toBe(true); // layout carried over
  });

  it("clones a band the target is missing and points the card at the clone", () => {
    const source = seg("A", [sig("s-src", { minHz: 1000, maxHz: 4000 })], graphWith("s-src"));
    const out = copyLayout(source, seg("B", [sig("s-tgt")], null));
    expect(out.signals).toHaveLength(2); // target band + the cloned source band
    const cloned = out.signals.find((s) => s.minHz === 1000)!;
    expect(cloned.id).not.toBe("s-src"); // fresh id on the target
    expect(sigId(out.graph!)).toBe(cloned.id);
  });

  it("leaves the target untouched when the source has no graph", () => {
    const target = seg("B", [sig("s-tgt")], null);
    expect(copyLayout(seg("A", [], null), target)).toBe(target);
  });
});
