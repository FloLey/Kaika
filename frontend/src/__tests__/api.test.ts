import { describe, it, expect, vi, afterEach } from "vitest";
import { extractSignal, getProject, getLogs } from "../lib/api";

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
