import { describe, it, expect } from "vitest";
import { LABELS, LABEL_COLOR, hydrateSegments, serializeSegments } from "../lib/segments";
import { copyLayout, hydrateCompositions } from "../lib/compositions";
import type { RawSegment } from "../lib/segments";
import type { Composition, CompositionPool, Graph, Segment, Signal } from "../lib/types";

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
  const seg = (id: string, signals: Signal[], rootCompositionId?: string): Segment => ({
    id,
    label: id,
    start: 0,
    end: 8,
    signals,
    rootCompositionId,
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
  const comp = (id: string, graph: Graph, outputId?: string): Composition => ({
    id,
    name: id,
    graph,
    ...(outputId ? { outputId } : {}),
  });
  const targetGraph = (res: { target: Segment; pool: CompositionPool }) =>
    res.pool[res.target.rootCompositionId!].graph;
  const sigId = (g: Graph) =>
    (g.nodes.find((n) => n.type === "signal")!.data as { signalId: string }).signalId;

  it("rewires the copied signal card onto the target's matching band (no duplicate)", () => {
    const pool = { c1: comp("c1", graphWith("s-src")) };
    const res = copyLayout(seg("A", [sig("s-src")], "c1"), seg("B", [sig("s-tgt")]), pool);
    expect(res.target.signals).toHaveLength(1); // matched the existing band, added nothing
    expect(sigId(targetGraph(res))).toBe("s-tgt"); // points at THIS segment's signal
    expect(targetGraph(res).nodes.some((n) => n.type === "fluid")).toBe(true); // layout carried
    expect(res.target.rootCompositionId).not.toBe("c1"); // the copy is its OWN composition
    expect(res.pool.c1.graph).toBe(pool.c1.graph); // the source is untouched
  });

  it("clones a band the target is missing and points the card at the clone", () => {
    const pool = { c1: comp("c1", graphWith("s-src")) };
    const source = seg("A", [sig("s-src", { minHz: 1000, maxHz: 4000 })], "c1");
    const res = copyLayout(source, seg("B", [sig("s-tgt")]), pool);
    expect(res.target.signals).toHaveLength(2); // target band + the cloned source band
    const cloned = res.target.signals.find((s) => s.minHz === 1000)!;
    expect(cloned.id).not.toBe("s-src"); // fresh id on the target
    expect(sigId(targetGraph(res))).toBe(cloned.id);
  });

  it("leaves the target untouched when the source has no composition", () => {
    const target = seg("B", [sig("s-tgt")]);
    const res = copyLayout(seg("A", []), target, {});
    expect(res.target).toBe(target);
  });

  it("carries over the source's final-output marker (node id survives the copy)", () => {
    const g = {
      version: 8,
      nodes: [
        { id: "n-sig", type: "signal", x: 0, y: 0, data: { signalId: "s-src" } },
        { id: "n-out", type: "output", x: 0, y: 0, data: { title: "preview" } },
      ],
      edges: [],
    } as unknown as Graph;
    const pool = { c1: comp("c1", g, "n-out") };
    const res = copyLayout(seg("A", [sig("s-src")], "c1"), seg("B", [sig("s-tgt")]), pool);
    const copied = res.pool[res.target.rootCompositionId!];
    expect(copied.outputId).toBe("n-out");
    expect(copied.graph.nodes.some((n) => n.id === "n-out")).toBe(true); // marker resolves
  });

  it("replaces the target's old composition reference wholesale", () => {
    const pool = {
      c1: comp("c1", graphWith("s-src")),
      cOld: comp("cOld", graphWith("s-tgt"), "stale-out"),
    };
    const source = seg("A", [sig("s-src")], "c1"); // no final marker on c1
    const target = seg("B", [sig("s-tgt")], "cOld");
    const res = copyLayout(source, target, pool);
    expect(res.target.rootCompositionId).not.toBe("cOld");
    expect(res.pool[res.target.rootCompositionId!].outputId).toBeUndefined();
  });
});

describe("hydrateCompositions", () => {
  const graph: Graph = { version: 8, nodes: [], edges: [] } as unknown as Graph;

  it("preserves stored ids (references depend on them)", () => {
    const pool = hydrateCompositions({ "comp-a1": { id: "comp-a1", name: "verse", graph } });
    expect(Object.keys(pool)).toEqual(["comp-a1"]);
    expect(pool["comp-a1"].name).toBe("verse");
  });

  it("drops entries without a graph and fills a missing name", () => {
    const pool = hydrateCompositions({
      "comp-a1": { id: "comp-a1", graph },
      "comp-broken": { id: "comp-broken", name: "x" }, // no graph
    });
    expect(Object.keys(pool)).toEqual(["comp-a1"]);
    expect(pool["comp-a1"].name).toBe("composition");
  });

  it("keeps outputId only when it is a non-empty string", () => {
    const pool = hydrateCompositions({
      a: { id: "a", name: "n", graph, outputId: "n-out" },
      b: { id: "b", name: "n", graph, outputId: "" },
    });
    expect(pool.a.outputId).toBe("n-out");
    expect("outputId" in pool.b).toBe(false);
  });
});
