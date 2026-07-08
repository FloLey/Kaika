import { describe, it, expect, vi, afterEach } from "vitest";
import {
  extractSignal,
  getProject,
  getLogs,
  pollJob,
  startStreamRender,
  getStreamStatus,
  cancelStreamRender,
} from "../lib/api";

// First coverage of the api.ts error boundary (jsonOrThrow): how non-JSON and
// non-ok responses are surfaced, and that /logs fails closed without logging.
afterEach(() => vi.unstubAllGlobals());

function mockFetchOnce(res: Response) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("jsonOrThrow", () => {
  it("surfaces a non-JSON response (e.g. an HTML fallback) with its body", async () => {
    mockFetchOnce(
      new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } })
    );
    await expect(getProject("x")).rejects.toThrow(/expected JSON/);
  });

  it("throws the JSON error field on a non-ok response", async () => {
    mockFetchOnce(json({ error: "unknown job/stem" }, 404));
    await expect(extractSignal({})).rejects.toThrow("unknown job/stem");
  });

  it("prefers `detail` over `error` when present", async () => {
    mockFetchOnce(json({ detail: "detailed", error: "generic" }, 400));
    await expect(extractSignal({})).rejects.toThrow("detailed");
  });

  it("resolves the parsed payload on a 2xx JSON response", async () => {
    mockFetchOnce(json({ curve: [0, 1], times: [0, 0.5] }));
    await expect(extractSignal({})).resolves.toEqual({ curve: [0, 1], times: [0, 0.5] });
  });
});

describe("getLogs", () => {
  it("rejects on a non-ok status without going through jsonOrThrow", async () => {
    mockFetchOnce(new Response("", { status: 500 }));
    await expect(getLogs(0)).rejects.toThrow(/\/logs 500/);
  });
});

describe("pollJob", () => {
  it("resolves with the finished job's result", async () => {
    mockFetchOnce(json({ state: "done", result: { job_id: "j1" } }));
    await expect(pollJob("j1")).resolves.toEqual({ job_id: "j1" });
  });

  it("stops the loop and throws AbortError once its signal aborts", async () => {
    // A still-running job: without the signal this loop would poll (and setState) forever.
    const fetchMock = vi.fn().mockResolvedValue(json({ state: "running", step: "separating" }));
    vi.stubGlobal("fetch", fetchMock);
    const ac = new AbortController();
    const p = pollJob("j1", undefined, 1, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow(/aborted/);
    const callsAtAbort = fetchMock.mock.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(callsAtAbort); // no further polling
  });

  it("never starts fetching when the signal is already aborted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ state: "running" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(pollJob("j1", undefined, 1, AbortSignal.abort())).rejects.toThrow(/aborted/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("streaming render", () => {
  it("starts a stream and returns the render_id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ render_id: "abc123" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      startStreamRender({ job_id: "j", segment: {}, graph: {}, output_id: "o1" })
    ).resolves.toEqual({ render_id: "abc123" });
    expect(fetchMock).toHaveBeenCalledWith("/animate/stream", expect.objectContaining({ method: "POST" }));
  });

  it("polls a render's status", async () => {
    mockFetchOnce(
      json({ state: "running", frames_done: 24, total: 72, preview_url: "/fluid/stream/x/preview_0000.mp4", url: null, error: null })
    );
    await expect(getStreamStatus("abc123")).resolves.toMatchObject({ state: "running", frames_done: 24 });
  });

  it("cancels without throwing even when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("gone")));
    await expect(cancelStreamRender("abc123")).resolves.toBeUndefined();
  });
});
