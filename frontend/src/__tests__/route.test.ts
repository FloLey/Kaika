import { describe, it, expect } from "vitest";
import { parseRoute, formatRoute, defaultTab, HOME, PLAYGROUND_JOB } from "../lib/route";
import type { Route } from "../lib/route";

// The route space, round-tripped. Every URL a link can carry has to survive being
// written and read back, and anything unrecognised has to land somewhere usable —
// a hand-edited URL should not produce a blank screen.

const cases: [string, Route][] = [
  ["#/", { name: "projects" }],
  ["#/upload", { name: "upload" }],
  ["#/p/j1/review", { name: "review", job: "j1" }],
  ["#/p/j1/export", { name: "export", job: "j1" }],
  ["#/p/j1/studio", { name: "studio", job: "j1", seg: undefined, tab: "signals" }],
  ["#/p/j1/studio/s3", { name: "studio", job: "j1", seg: "s3", tab: "signals" }],
  ["#/p/j1/studio/s3/graph", { name: "studio", job: "j1", seg: "s3", tab: "graph" }],
  // A URL that names no tab means "this project's default tab", which for the
  // Playground is the cards. The explicit `/signals` form exists so the Playground on
  // signals still has a URL that reads back as signals.
  ["#/p/playground/studio/s3", { name: "studio", job: "playground", seg: "s3", tab: "graph" }],
  [
    "#/p/playground/studio/s3/signals",
    { name: "studio", job: "playground", seg: "s3", tab: "signals" },
  ],
];

describe("parseRoute", () => {
  for (const [url, route] of cases) {
    it(`reads ${url}`, () => expect(parseRoute(url)).toEqual(route));
  }

  it("tolerates a missing leading slash and a bare hash", () => {
    expect(parseRoute("#p/j1/review")).toEqual({ name: "review", job: "j1" });
    expect(parseRoute("#")).toEqual(HOME);
    expect(parseRoute("")).toEqual(HOME);
  });

  it("falls back home on anything it doesn't recognise", () => {
    expect(parseRoute("#/nonsense")).toEqual(HOME);
    expect(parseRoute("#/p")).toEqual(HOME); // a project route with no project
    expect(parseRoute("#/p/j1/nowhere")).toEqual(HOME);
  });

  it("decodes ids that needed escaping", () => {
    expect(parseRoute("#/p/a%2Fb/review")).toEqual({ name: "review", job: "a/b" });
  });
});

describe("formatRoute", () => {
  for (const [url, route] of cases) {
    it(`writes ${url}`, () => expect(formatRoute(route)).toBe(url));
  }

  it("round-trips every case", () => {
    for (const [, route] of cases) expect(parseRoute(formatRoute(route))).toEqual(route);
  });

  it("keeps the default tab implicit, so the common link is the short one", () => {
    expect(formatRoute({ name: "studio", job: "j1", seg: "s3", tab: "signals" })).toBe(
      "#/p/j1/studio/s3"
    );
  });

  it("drops a tab with no segment to hang it on", () => {
    // Not reachable through the UI, but a malformed route must not format into one
    // that parses back differently.
    const r: Route = { name: "studio", job: "j1", tab: "graph" };
    expect(parseRoute(formatRoute(r))).toEqual({
      name: "studio",
      job: "j1",
      seg: undefined,
      tab: "signals",
    });
  });

  it("escapes ids that would otherwise break the path", () => {
    expect(formatRoute({ name: "review", job: "a/b" })).toBe("#/p/a%2Fb/review");
  });
});

// Which tab a project opens on. Worth a test of its own because the rule used to live
// inside Studio, where the routed shell could not reach it: the shell hardcoded
// "signals" at every navigation, so the Playground — whose entire point is the cards —
// opened on an empty signals tab. Nothing failed, because the component that still
// knew the rule was no longer the component being asked.
describe("defaultTab", () => {
  it("opens the Playground on the cards", () => {
    expect(defaultTab(PLAYGROUND_JOB)).toBe("graph");
  });

  it("opens a normal project on signals — extract first, then animate", () => {
    expect(defaultTab("j1")).toBe("signals");
  });

  it("agrees with the backend's job id for the seeded demo", () => {
    // `backend/seed_card_demo.py`'s JOB_ID. A rename there with no rename here would
    // silently drop the Playground back onto the signals tab.
    expect(PLAYGROUND_JOB).toBe("playground");
  });
});
