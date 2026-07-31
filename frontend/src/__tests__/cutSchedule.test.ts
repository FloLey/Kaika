import { describe, it, expect } from "vitest";
import fixture from "../../../tests/fixtures/cut_schedule_cases.json";
import {
  dreamPlan,
  clampedFades,
  blendWeight,
  cutMarks,
  effectiveCuts,
  fadeShaped,
  lyricCuts,
  partStarts,
} from "../lib/cutSchedule";
import type { DreamPrompt } from "../lib/types";

// The SHARED oracle — the same file `tests/test_cut_schedule.py` reads (imported the way
// playgroundFixture.test.ts imports its fixture). The timeline draws from this module and
// the render generates from `backend/cut_schedule.py`; if they drift, the editor lies
// about what the render will do and nothing fails loudly. Neither side can be "fixed"
// alone while both read this.
const FIXTURE = fixture as unknown as {
  cases: {
    name: string;
    cuts: number[];
    prompts: DreamPrompt[];
    fps: number;
    nframes: number;
    seed?: number;
    seedMode?: string;
    reseedFrames?: number[];
    shape?: number;
    expect: [string, string | null, number, number][];
  }[];
};

describe("cutSchedule.dreamPlan — the shared fixture", () => {
  for (const c of FIXTURE.cases) {
    it(c.name, () => {
      const plan = dreamPlan(c.cuts, c.prompts, c.fps, c.nframes, {
        seed: c.seed ?? 1,
        seedMode: c.seedMode ?? "gate",
        reseedFrames: c.reseedFrames ?? null,
        shape: c.shape ?? 1,
      });
      const got = plan.map((s) => [s.prompt_a, s.prompt_b, Number(s.w.toFixed(6)), s.seed]);
      const want = c.expect.map(([a, b, w, sd]) => [a, b, Number(w.toFixed(6)), sd]);
      expect(got).toEqual(want);
    });
  }
});

describe("cutSchedule.clampedFades", () => {
  it("scales both fades proportionally and flags the clamp", () => {
    const [f] = clampedFades([{ id: "p", text: "a", fadeIn: 3, fadeOut: 1 }], [0], 4, 4);
    expect(f.fadeIn + f.fadeOut).toBeCloseTo(1);
    expect(f.fadeIn / f.fadeOut).toBeCloseTo(3); // the RATIO survives
    expect(f.clamped).toBe(true);
  });

  it("leaves fitting fades alone and does not flag them", () => {
    const [f] = clampedFades([{ id: "p", text: "a", fadeIn: 0.2, fadeOut: 0.3 }], [0], 40, 4);
    expect(f).toEqual({ fadeIn: 0.2, fadeOut: 0.3, clamped: false });
  });

  it("flags the clamp so the timeline can draw what the render will DO, not what was typed", () => {
    const prompts: DreamPrompt[] = [
      { id: "a", text: "a" },
      { id: "b", text: "b", fadeIn: 9 },
    ];
    const fades = clampedFades(prompts, [0, 4], 8, 4);
    expect(fades[1].clamped).toBe(true);
    expect(fades[1].fadeIn).toBeLessThan(9);
  });
});

describe("cutSchedule.blendWeight", () => {
  it("hard-cuts when both fades are zero", () => {
    expect(blendWeight(0.9, 1, 0, 0)).toBe(0);
    expect(blendWeight(1.0, 1, 0, 0)).toBe(1);
  });

  it("sits at o/(o+i) on the cut frame", () => {
    expect(blendWeight(1, 1, 0.3, 0.1)).toBeCloseTo(0.75);
    expect(blendWeight(1, 1, 0.1, 0.3)).toBeCloseTo(0.25);
  });

  it("clamps outside the span", () => {
    expect(blendWeight(0, 1, 0.2, 0.2)).toBe(0);
    expect(blendWeight(5, 1, 0.2, 0.2)).toBe(1);
  });
});

describe("cutSchedule.fadeShaped — the answer to Z-Image's steep interpolation", () => {
  it("is the identity at shape 1 (the default, and what SD-Turbo wants)", () => {
    for (const u of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(fadeShaped(u, 1)).toBeCloseTo(u);
    }
  });

  it("pins the endpoints and the midpoint at every shape", () => {
    for (const shape of [0.5, 1, 2, 3, 5]) {
      expect(fadeShaped(0, shape)).toBeCloseTo(0);
      expect(fadeShaped(1, shape)).toBeCloseTo(1);
      expect(fadeShaped(0.5, shape)).toBeCloseTo(0.5);
    }
  });

  it("flattens around the midpoint above 1, landing mid-ramp inside HD's active band", () => {
    expect(fadeShaped(0.25, 3)).toBeCloseTo(0.4375); // linear would be 0.25
    expect(fadeShaped(0.75, 3)).toBeCloseTo(0.5625); // linear would be 0.75
  });

  it("steepens around the midpoint below 1", () => {
    expect(fadeShaped(0.25, 0.5)).toBeLessThan(0.25);
    expect(fadeShaped(0.75, 0.5)).toBeGreaterThan(0.75);
  });

  it("stays monotonic — a fade must never run backwards", () => {
    for (const shape of [0.5, 2, 3]) {
      let prev = -1;
      for (let k = 0; k <= 20; k++) {
        const w = fadeShaped(k / 20, shape);
        expect(w).toBeGreaterThanOrEqual(prev);
        prev = w;
      }
    }
  });

  it("reaches blendWeight", () => {
    // a symmetric 1s dissolve: t=0.75 is a quarter through, t=1.25 three quarters
    expect(blendWeight(0.75, 1, 0.5, 0.5, 1)).toBeCloseTo(0.25);
    expect(blendWeight(0.75, 1, 0.5, 0.5, 3)).toBeCloseTo(0.4375);
    expect(blendWeight(1.25, 1, 0.5, 0.5, 1)).toBeCloseTo(0.75);
    expect(blendWeight(1.25, 1, 0.5, 0.5, 3)).toBeCloseTo(0.5625);
  });
});

describe("cutSchedule.partStarts (shared with the montage)", () => {
  it("keeps the span-consumption and hold-last rules", () => {
    expect(partStarts([6], [1, 1])).toEqual([0, 6]);
    expect(partStarts([3, 6, 9], [1, 1])).toEqual([0, 3]);
    expect(partStarts([3, 6, 9], [2, 1, 1])).toEqual([0, 6, 9]);
    expect(partStarts([3], [2, 1])).toEqual([0]);
  });
});

describe("cutSchedule.dreamPlan edge cases", () => {
  it("returns nothing without prompts", () => {
    expect(dreamPlan([], [], 4, 4)).toEqual([]);
  });

  it("survives a zero-length part (two cuts on one frame)", () => {
    const prompts: DreamPrompt[] = [
      { id: "a", text: "a" },
      { id: "b", text: "b", fadeIn: 1 },
      { id: "c", text: "c" },
    ];
    expect(dreamPlan([4, 4], prompts, 4, 8, { seedMode: "fixed" })).toHaveLength(8);
  });
});

// ---- lyric-derived cuts (Dream's "follow the lyrics") ------------------------------
// Same shared fixture the Python suite reads, so the timeline and the render agree about
// where a sung line puts a cut.
const LYRIC = (
  fixture as unknown as {
    lyricCases: {
      name: string;
      lines: { t0: number; t1: number; text?: string; aligned?: boolean }[];
      segStart: number;
      fps: number;
      nframes: number;
      instrumental?: boolean;
      skipUnaligned?: boolean;
      expect: [number, boolean][];
    }[];
  }
).lyricCases;

describe("cutSchedule.lyricCuts — the shared fixture", () => {
  for (const c of LYRIC) {
    it(c.name, () => {
      const lines = c.lines.map((l) => ({ text: "", ...l }));
      const got = lyricCuts(lines, c.segStart, c.fps, c.nframes, {
        instrumental: c.instrumental,
        skipUnaligned: c.skipUnaligned,
      });
      expect(got.map((x) => [x.frame, x.gap])).toEqual(c.expect.map(([f, g]) => [f, !!g]));
    });
  }
});

describe("lyric cuts in the union", () => {
  const noGate: number[] = [];
  const data = { manualBreakpoints: [], disabledCuts: [] };

  it("joins effectiveCuts like a manual breakpoint", () => {
    expect(effectiveCuts(noGate, data, 4, 24, [8, 16])).toEqual([8, 16]);
  });

  it("is silenced by disabledCuts, with the machinery that already exists", () => {
    const off = { manualBreakpoints: [], disabledCuts: [2] }; // 2s @ 4fps = frame 8
    expect(effectiveCuts(noGate, off, 4, 24, [8, 16])).toEqual([16]);
  });

  it("carries its provenance into the timeline", () => {
    const marks = cutMarks(noGate, data, 4, 24, [8]);
    expect(marks.map((m) => m.source)).toEqual(["lyric"]);
  });

  it("yields the pixel to a gate cut on the same frame", () => {
    const marks = cutMarks([8], data, 4, 24, [8]);
    expect(marks).toHaveLength(1);
    expect(marks[0].source).toBe("gate");
  });
});
