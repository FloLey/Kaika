// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, screen } from "@testing-library/react";
import AppShell from "../components/next/AppShell";
import Stepper, { blockedReason } from "../components/next/Stepper";
import { hydrateSegments, serializeSegments } from "../lib/segments";
import { outputNode } from "../lib/graphModel";
import type { CompositionPool, Segment } from "../lib/types";

// The routed shell. What it has to do that the current one can't: land on a URL,
// survive Back, and say why a stage is out of reach.

const getProject = vi.fn();
const listProjects = vi.fn(async () => []);

vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  getProject: (id: string) => getProject(id),
  listProjects: () => listProjects(),
  saveProject: vi.fn(async () => ({ ok: true })),
  getLogs: vi.fn(async () => ({ entries: [] })),
}));

const STEMS = { drums: { sr: 44100 } };
const storedSegments = () =>
  serializeSegments(
    hydrateSegments(
      [
        { id: "s1", start: 0, end: 30, label: "INTRO" },
        { id: "s2", start: 30, end: 60, label: "VERSE" },
      ],
      STEMS
    )
  );

const project = (over: Record<string, unknown> = {}) => ({
  job_id: "j1",
  title: "Wedding song",
  duration: 120,
  step: "studio",
  stems: STEMS,
  segments: storedSegments(),
  compositions: {},
  ...over,
});

// No `?ui=next` prefix any more: the routed shell IS the app.
const setHash = (h: string) => window.history.replaceState(null, "", h || "#/");

beforeEach(() => {
  getProject.mockReset();
  getProject.mockResolvedValue(project());
  setHash("#/");
});
afterEach(() => window.history.replaceState(null, "", "/"));

async function mount() {
  const utils = render(<AppShell />);
  // Let the URL→project effect run its async load.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return utils;
}

describe("AppShell routing", () => {
  it("opens the project named in the URL, with no click at all", async () => {
    setHash("#/p/j1/studio");
    await mount();
    expect(getProject).toHaveBeenCalledWith("j1");
    expect(screen.getByText("Wedding song")).toBeTruthy();
  });

  it("reconciles the URL to the step the project resumed at", async () => {
    // The DB says this project was last on `export`; the URL said `studio`.
    getProject.mockResolvedValue(project({ step: "export" }));
    setHash("#/p/j1/studio");
    await mount();
    expect(window.location.hash).toBe("#/p/j1/export");
  });

  it("a segment selection lands in the URL, so Back returns to the previous one", async () => {
    setHash("#/p/j1/studio/s1");
    await mount();
    expect(window.location.hash).toBe("#/p/j1/studio/s1");

    // Navigating to the other segment pushes — the point of the whole exercise.
    await act(async () => {
      fireEvent.click(screen.getByText(/VERSE/));
    });
    expect(window.location.hash).toBe("#/p/j1/studio/s2");
  });

  it("carries the studio tab, so a link can open the graph directly", async () => {
    setHash("#/p/j1/studio/s1/graph");
    const { container } = await mount();
    // The animation tab is the active one in the mode bar.
    const on = container.querySelector(".mode-tab.on");
    expect(on?.textContent).toContain("create animation");
  });

  it("opens the Playground on the cards, not on an empty signals tab", async () => {
    // The Playground carries one card per type and no signals at all, so landing on
    // signals shows a blank screen with nothing to explain it. Studio knew this; the
    // shell, which now chooses the tab, did not — it hardcoded "signals" at every
    // navigation. Asserted at the shell because the rule being right (route.test.ts)
    // and the shell asking for it are two different failures.
    getProject.mockResolvedValue(project({ job_id: "playground", step: "studio" }));
    setHash("#/p/playground/studio");
    const { container } = await mount();
    expect(container.querySelector(".mode-tab.on")?.textContent).toContain("create animation");
    // And the short URL stays short: `graph` is this project's default, so naming it
    // would be noise. What must NOT happen is a rewrite to an explicit signals form.
    expect(window.location.hash).toBe("#/p/playground/studio");
  });

  it("still opens a normal project on signals", async () => {
    // The other half of the same rule — without this, `defaultTab` returning "graph"
    // unconditionally would pass the test above.
    setHash("#/p/j1/studio");
    const { container } = await mount();
    expect(container.querySelector(".mode-tab.on")?.textContent).toContain(
      "extract signals by track"
    );
  });

  it("an unknown URL lands on the projects list rather than a blank screen", async () => {
    setHash("#/total/nonsense");
    await mount();
    expect(screen.getByText("PROJECTS")).toBeTruthy();
  });

  it("the stepper moves stages, and the move is a real navigation", async () => {
    setHash("#/p/j1/studio/s1");
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTitle("go to review"));
    });
    expect(window.location.hash).toBe("#/p/j1/review");
  });
});

describe("Stepper reachability", () => {
  const seg = (id: string, root?: string): Segment => ({
    id,
    label: "V",
    start: 0,
    end: 1,
    signals: [],
    rootCompositionId: root,
  });
  const poolWithFinal = (id: string): CompositionPool => {
    const out = outputNode(0, 0);
    return {
      [id]: { id, name: "root", graph: { version: 1, nodes: [out], edges: [] }, outputId: out.id },
    };
  };

  it("refuses export while a segment has no final output, and says how many", () => {
    const reason = blockedReason("export", {
      hasProject: true,
      segments: [seg("s1", "c1"), seg("s2")],
      compositions: poolWithFinal("c1"),
    });
    expect(reason).toBe("1 segment still needs a final output");
  });

  it("allows export once every segment is marked", () => {
    expect(
      blockedReason("export", {
        hasProject: true,
        segments: [seg("s1", "c1")],
        compositions: poolWithFinal("c1"),
      })
    ).toBeNull();
  });

  it("needs a project at all before review or studio", () => {
    const none = { hasProject: false, segments: [], compositions: {} };
    expect(blockedReason("review", none)).toBe("open a project first");
    expect(blockedReason("studio", none)).toBe("open a project first");
    expect(blockedReason("upload", none)).toBeNull(); // upload is how you get one
  });

  it("refuses a second upload into a project that already has audio", () => {
    expect(blockedReason("upload", { hasProject: true, segments: [], compositions: {} })).toBe(
      "this project already has its audio"
    );
  });

  it("marks earlier stages done and disables the one you're on", () => {
    const { container } = render(
      <Stepper
        current="studio"
        hasProject
        segments={[seg("s1", "c1")]}
        compositions={poolWithFinal("c1")}
        onGo={() => {}}
      />
    );
    const steps = [...container.querySelectorAll(".stepper-step")];
    expect(steps.map((s) => s.className.includes("done"))).toEqual([true, true, false, false]);
    expect(steps[2].className).toContain("on");
    expect((steps[2] as HTMLButtonElement).disabled).toBe(true);
  });

  it("a blocked step keeps its place and carries the reason", () => {
    const { container } = render(
      <Stepper
        current="studio"
        hasProject
        segments={[seg("s1")]} // no final output anywhere
        compositions={{}}
        onGo={() => {}}
      />
    );
    const exportStep = container.querySelectorAll(".stepper-step")[3] as HTMLButtonElement;
    expect(exportStep.disabled).toBe(true);
    expect(exportStep.title).toContain("still needs a final output");
    expect(exportStep.className).toContain("blocked");
  });
});
