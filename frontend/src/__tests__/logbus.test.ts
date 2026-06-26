import { describe, it, expect, beforeEach } from "vitest";
import * as logbus from "../lib/logbus";

// The log bus is a module singleton; reset it between tests.
beforeEach(() => logbus.clear());

describe("logbus", () => {
  it("pushes frontend entries with the right level + source", () => {
    logbus.info("hi");
    logbus.warn("careful");
    logbus.error("boom");
    const e = logbus.getEntries();
    expect(e).toHaveLength(3);
    expect(e.map((x) => x.level)).toEqual(["info", "warn", "error"]);
    expect(e.every((x) => x.source === "frontend")).toBe(true);
  });

  it("counts only errors for the badge", () => {
    logbus.info("a");
    logbus.error("b");
    logbus.error("c");
    expect(logbus.errorCount()).toBe(2);
  });

  it("notifies subscribers and supports unsubscribe", () => {
    let calls = 0;
    const unsub = logbus.subscribe(() => {
      calls += 1;
    });
    expect(calls).toBe(1); // immediate call on subscribe
    logbus.info("x");
    expect(calls).toBe(2);
    unsub();
    logbus.info("y");
    expect(calls).toBe(2); // no longer notified
  });

  it("ingests backend entries: advances cursor, converts ts, marks source", () => {
    expect(logbus.backendCursor()).toBe(0);
    logbus.ingestBackend({
      seq: 4,
      entries: [
        { seq: 3, ts: 100, level: "warn", logger: "kaika", msg: "w", trace: null },
        { seq: 4, ts: 101.5, level: "error", logger: "kaika.jobs", msg: "e", trace: "tb" },
      ],
    });
    expect(logbus.backendCursor()).toBe(4);
    const e = logbus.getEntries();
    expect(e).toHaveLength(2);
    expect(e[0]).toMatchObject({ id: "b3", source: "backend", ts: 100000, level: "warn" });
    expect(e[1]).toMatchObject({ id: "b4", ts: 101500, trace: "tb" });
    expect(logbus.errorCount()).toBe(1);
  });

  it("dedupes backend rows by seq-derived id across overlapping payloads", () => {
    logbus.ingestBackend({
      seq: 2,
      entries: [
        { seq: 1, ts: 1, level: "info", logger: "k", msg: "one" },
        { seq: 2, ts: 2, level: "info", logger: "k", msg: "two" },
      ],
    });
    // A retry re-delivers seq 2 alongside a new seq 3.
    logbus.ingestBackend({
      seq: 3,
      entries: [
        { seq: 2, ts: 2, level: "info", logger: "k", msg: "two" },
        { seq: 3, ts: 3, level: "info", logger: "k", msg: "three" },
      ],
    });
    const ids = logbus.getEntries().map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length); // no dup ids
    expect(ids).toContain("b3");
  });

  it("caps the buffer at 500 entries", () => {
    for (let i = 0; i < 600; i++) logbus.info("m" + i);
    const e = logbus.getEntries();
    expect(e.length).toBe(500);
    expect(e[e.length - 1].msg).toBe("m599"); // newest kept
  });
});
