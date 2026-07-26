// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useProject, buildSavePayload } from "../lib/useProject";
import { hydrateSegments, serializeSegments } from "../lib/segments";
import { OUTPUT_DEFAULTS } from "../lib/output";
import { EXPORT_DEFAULTS } from "../lib/export";

// The project state lifted out of App.tsx. The behaviour worth pinning is the one
// that was never covered and is the easiest to break: `lastSaved` must serialise to
// EXACTLY what the autosave would produce. Too different and the app re-PUTs the
// moment a project opens; too similar-but-unequal and a real edit reads as saved.

const getProject = vi.fn();
const saveProject = vi.fn();

vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  getProject: (id: string) => getProject(id),
  saveProject: (jobId: string, payload: unknown) => saveProject(jobId, payload),
}));

const STEMS = { drums: { sr: 44100 } };

// A stored segment carrying EXACTLY the signals hydration would seed for these
// stems, i.e. what the app itself last wrote. Hand-writing one signal instead would
// silently take the other branch: `withDefaults` would add the missing per-stem
// defaults, the merged count would exceed the loaded count, and the open would
// (correctly) save.
const storedSegments = (stems: Record<string, { sr?: number }> = STEMS) =>
  serializeSegments(hydrateSegments([{ id: "s1", start: 0, end: 30, label: "VERSE" }], stems));

const project = (over: Record<string, unknown> = {}) => ({
  job_id: "j1",
  title: "Song",
  duration: 120,
  step: "studio",
  stems: STEMS,
  segments: storedSegments(),
  compositions: {},
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  getProject.mockReset();
  saveProject.mockReset();
  saveProject.mockResolvedValue({ ok: true });
});
afterEach(() => vi.useRealTimers());

// Let the 800ms autosave debounce fire, then drain the save chain's promises —
// `waitFor` can't do this itself because the timers are fake.
async function settleAutosave() {
  await act(async () => {
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe("useProject", () => {
  it("loads a project into every field and resumes at its saved step", async () => {
    getProject.mockResolvedValue(project());
    const { result } = renderHook(() => useProject());
    expect(result.current.step).toBe("projects");

    await act(async () => {
      await result.current.openProject("j1");
    });

    expect(result.current.step).toBe("studio");
    expect(result.current.job).toBe("j1");
    expect(result.current.title).toBe("Song");
    expect(result.current.duration).toBe(120);
    expect(result.current.segments).toHaveLength(1);
    expect(result.current.activeSegId).toBe(result.current.segments[0].id);
    expect(result.current.output).toEqual(OUTPUT_DEFAULTS);
    expect(result.current.exportSettings).toEqual(EXPORT_DEFAULTS);
  });

  it("does NOT re-PUT a project that opened unchanged", async () => {
    getProject.mockResolvedValue(project());
    const { result } = renderHook(() => useProject());
    await act(async () => {
      await result.current.openProject("j1");
    });
    await settleAutosave();
    expect(saveProject).not.toHaveBeenCalled();
  });

  it("DOES save when hydration added default signals the file didn't have", async () => {
    // Two stems but signals for one: hydration adds the missing default, so the
    // in-memory project is genuinely ahead of the file and must be written.
    getProject.mockResolvedValue(project({ stems: { drums: { sr: 44100 }, bass: { sr: 44100 } } }));
    const { result } = renderHook(() => useProject());
    await act(async () => {
      await result.current.openProject("j1");
    });
    await settleAutosave();
    expect(saveProject).toHaveBeenCalledTimes(1);
  });

  it("saves an edit once, and not again when nothing changed", async () => {
    getProject.mockResolvedValue(project());
    const { result } = renderHook(() => useProject());
    await act(async () => {
      await result.current.openProject("j1");
    });
    await settleAutosave();

    act(() => {
      result.current.setSegments((prev) => prev.map((s) => ({ ...s, label: "CHORUS" })));
    });
    await settleAutosave();
    expect(saveProject).toHaveBeenCalledTimes(1);

    // A re-render with identical state must not produce a second write.
    await settleAutosave();
    expect(saveProject).toHaveBeenCalledTimes(1);
  });

  it("flags saveError when the PUT fails, and clears it on the next success", async () => {
    getProject.mockResolvedValue(project());
    const { result } = renderHook(() => useProject());
    await act(async () => {
      await result.current.openProject("j1");
    });

    saveProject.mockRejectedValueOnce(new Error("offline"));
    act(() => {
      result.current.setSegments((prev) => prev.map((s) => ({ ...s, label: "CHORUS" })));
    });
    await settleAutosave();
    expect(result.current.saveError).toBe(true);

    // lastSaved stayed stale, so the very next edit retries the whole payload.
    act(() => {
      result.current.setSegments((prev) => prev.map((s) => ({ ...s, label: "BRIDGE" })));
    });
    await settleAutosave();
    expect(result.current.saveError).toBe(false);
  });

  it("does not autosave outside review/studio/export", async () => {
    getProject.mockResolvedValue(project({ step: "projects" }));
    const { result } = renderHook(() => useProject());
    await act(async () => {
      await result.current.openProject("j1");
    });
    act(() => result.current.setStep("projects"));
    act(() => {
      result.current.setSegments((prev) => prev.map((s) => ({ ...s, label: "CHORUS" })));
    });
    await settleAutosave();
    expect(saveProject).not.toHaveBeenCalled();
  });

  it("surfaces a load failure on the error step instead of throwing", async () => {
    getProject.mockRejectedValue(new Error("no such project"));
    const { result } = renderHook(() => useProject());
    await act(async () => {
      await result.current.openProject("nope");
    });
    expect(result.current.step).toBe("error");
    expect(result.current.error).toBe("no such project");
  });

  it("leaving a project clears it so the next one can't inherit state", async () => {
    getProject.mockResolvedValue(project());
    const { result } = renderHook(() => useProject());
    await act(async () => {
      await result.current.openProject("j1");
    });
    act(() => result.current.toProjects());
    expect(result.current.step).toBe("projects");
    expect(result.current.job).toBeNull();
    expect(result.current.segments).toEqual([]);
    expect(result.current.compositions).toEqual({});
    expect(result.current.activeSegId).toBeNull();
  });
});

// The shell's URL-reconciling effects depend on the whole project object, so its
// identity IS the "did the project change" signal. Two ways that breaks: a literal
// return (new identity every render, effects fire constantly) or a dep list missing a
// field (identity goes stale, effects never fire). Both are invisible in review — the
// app still works, because the effects' own ref guards paper over the first case and
// the second only shows on a field nobody happened to test. Hence these.
describe("useProject — the project object's identity", () => {
  it("hands back the SAME object when nothing changed", async () => {
    getProject.mockResolvedValue(project());
    const { result, rerender } = renderHook(() => useProject());
    await act(async () => {
      await result.current.openProject("j1");
    });

    const before = result.current;
    rerender();
    expect(result.current).toBe(before);
  });

  // One case per setter the screens drive directly. A dep list that forgets one of
  // these fields passes every other test in this file and still hands the shell a
  // stale object forever.
  const edits: [string, (p: ReturnType<typeof useProject>) => void][] = [
    ["setStep", (p) => p.setStep("export")],
    ["setSegments", (p) => p.setSegments((prev) => prev.map((s) => ({ ...s, label: "X" })))],
    [
      "setCompositions",
      (p) =>
        p.setCompositions({
          c9: { id: "c9", name: "n", graph: { version: 1, nodes: [], edges: [] } },
        }),
    ],
    ["setActiveSegId", (p) => p.setActiveSegId("other")],
    ["setOutput", (p) => p.setOutput({ ...OUTPUT_DEFAULTS, width: 123 })],
    ["setExportSettings", (p) => p.setExportSettings({ ...EXPORT_DEFAULTS, fps: 47 })],
  ];

  it.each(edits)("changes identity when %s runs", async (_name, edit) => {
    getProject.mockResolvedValue(project());
    const { result } = renderHook(() => useProject());
    await act(async () => {
      await result.current.openProject("j1");
    });

    const before = result.current;
    act(() => edit(result.current));
    expect(result.current).not.toBe(before);
  });

  it("changes identity when a project opens", async () => {
    getProject.mockResolvedValue(project());
    const { result } = renderHook(() => useProject());
    const before = result.current;
    await act(async () => {
      await result.current.openProject("j1");
    });
    expect(result.current).not.toBe(before);
  });
});

describe("buildSavePayload", () => {
  it("prunes compositions no segment reaches — from the PAYLOAD, not the state", () => {
    const segs = [{ id: "s1", label: "V", start: 0, end: 1, signals: [], rootCompositionId: "c1" }];
    const pool = {
      c1: { id: "c1", name: "root", graph: { version: 1, nodes: [], edges: [] } },
      c2: { id: "c2", name: "orphan", graph: { version: 1, nodes: [], edges: [] } },
    };
    const payload = buildSavePayload("studio", segs, pool, OUTPUT_DEFAULTS, EXPORT_DEFAULTS);
    expect(Object.keys(payload.compositions)).toEqual(["c1"]);
    expect(Object.keys(pool)).toEqual(["c1", "c2"]); // the in-memory pool is untouched
  });
});
