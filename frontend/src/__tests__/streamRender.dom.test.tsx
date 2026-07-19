// @vitest-environment jsdom
import { useRef } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useStreamRender } from "../components/animation/nodes/useStreamRender";
import type { NodeCtx } from "../components/animation/nodes/nodeProps";
import type { Graph } from "../lib/types";

vi.mock("../lib/api", () => ({
  startStreamRender: vi.fn(),
  getStreamStatus: vi.fn(),
  cancelStreamRender: vi.fn(),
}));
import * as api from "../lib/api";

const GRAPH = {
  version: 26,
  nodes: [{ id: "o", type: "output", data: {} }],
  edges: [],
} as unknown as Graph;

// A ctx whose clock reports paused/playing — the gate on adopting a growing preview.
function makeCtx(playing: boolean): NodeCtx {
  const audio = document.createElement("audio");
  Object.defineProperty(audio, "paused", { value: !playing, configurable: true });
  return {
    graph: GRAPH,
    job: "deadbeef",
    segment: { id: "s", start: 0, end: 2, signals: [] },
    output: { width: 96, height: 128, quality: "draft", fps: 24 },
    groupClock: { current: audio },
  } as unknown as NodeCtx;
}

function Probe({ ctx, renderKey }: { ctx: NodeCtx; renderKey: string }) {
  const seen = useRef<string[]>([]);
  const { videoUrl } = useStreamRender(ctx, "o", renderKey, true);
  if (videoUrl && seen.current[seen.current.length - 1] !== videoUrl) seen.current.push(videoUrl);
  return <span data-testid="urls">{seen.current.join("|")}</span>;
}

// Drive the debounce + poll loop to completion.
async function settle(times = 12) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.startStreamRender).mockReset();
  vi.mocked(api.getStreamStatus).mockReset();
  vi.mocked(api.cancelStreamRender).mockReset();
  vi.mocked(api.startStreamRender).mockResolvedValue({ render_id: "r1" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const running = (n: number) => ({
  state: "running" as const,
  frames_done: n,
  total: 48,
  preview_url: `/fluid/stream/r1/preview.mp4?n=${n}`,
  url: null,
  error: null,
});
const done = (url: string) => ({
  state: "done" as const,
  frames_done: 48,
  total: 48,
  preview_url: null,
  url,
  error: null,
});

describe("useStreamRender", () => {
  it("adopts the growing preview while the transport is stopped", async () => {
    vi.mocked(api.getStreamStatus)
      .mockResolvedValueOnce(running(12))
      .mockResolvedValueOnce(running(24))
      .mockResolvedValue(done("/fluid/aaa.mp4"));
    const { getByTestId } = render(<Probe ctx={makeCtx(false)} renderKey="k-idle" />);
    await settle();
    const urls = getByTestId("urls").textContent!.split("|");
    expect(urls).toContain("/fluid/stream/r1/preview.mp4?n=12");
    expect(urls[urls.length - 1]).toBe("/fluid/aaa.mp4");
  });

  it("does NOT swap src mid-render while playing — one swap, at the end", async () => {
    // Re-pointing <video src> at each block reloads the element and restarts playback:
    // exactly what made the clip unwatchable against the music.
    vi.mocked(api.getStreamStatus)
      .mockResolvedValueOnce(running(12))
      .mockResolvedValueOnce(running(24))
      .mockResolvedValue(done("/fluid/bbb.mp4"));
    const { getByTestId } = render(<Probe ctx={makeCtx(true)} renderKey="k-playing" />);
    await settle();
    expect(getByTestId("urls").textContent).toBe("/fluid/bbb.mp4"); // exactly one url
  });

  it("re-shows an already rendered key from memory, with no API call", async () => {
    vi.mocked(api.getStreamStatus).mockResolvedValue(done("/fluid/ccc.mp4"));
    const first = render(<Probe ctx={makeCtx(false)} renderKey="k-memo" />);
    await settle();
    expect(first.getByTestId("urls").textContent).toBe("/fluid/ccc.mp4");
    expect(api.startStreamRender).toHaveBeenCalledTimes(1);
    cleanup();

    // Same key again (undo/redo, a slider nudged back, a card remounted): instant.
    vi.mocked(api.startStreamRender).mockClear();
    const again = render(<Probe ctx={makeCtx(false)} renderKey="k-memo" />);
    await settle(1);
    expect(again.getByTestId("urls").textContent).toBe("/fluid/ccc.mp4");
    expect(api.startStreamRender).not.toHaveBeenCalled();
  });

  it("keeps an in-flight render alive when the card scrolls out of view", async () => {
    vi.mocked(api.getStreamStatus)
      .mockResolvedValueOnce(running(12))
      .mockResolvedValue(done("/fluid/ddd.mp4"));

    function Gated({ active }: { active: boolean }) {
      const { videoUrl } = useStreamRender(makeCtx(false), "o", "k-scroll", active);
      return <span data-testid="u">{videoUrl}</span>;
    }
    const view = render(<Gated active />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    view.rerender(<Gated active={false} />); // panned off screen mid-render
    await settle();
    // The viewport decides whether to START a render, never to throw one away.
    expect(api.cancelStreamRender).not.toHaveBeenCalled();
    expect(view.getByTestId("u").textContent).toBe("/fluid/ddd.mp4");
  });
});
