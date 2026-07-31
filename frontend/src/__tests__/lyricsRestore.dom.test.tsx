// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import LyricsNode from "../components/animation/nodes/LyricsNode";
import { emptyGraph, lyricsNode } from "../lib/graphModel";
import type { Graph, LyricLine, LyricsNode as LyricsNodeT, Segment } from "../lib/types";
import type { NodeCtx } from "../components/animation/nodes/nodeProps";

// "↺ restore original" puts back the alignment stored at analysis time. The point of a
// stored snapshot (rather than re-running Whisper) is that it survives EVERY edit — so
// the two things worth pinning are that the button posts the snapshot verbatim, and that
// it stays out of the way when there is nothing to restore to.

const segment: Segment = { id: "s1", label: "verse", start: 0, end: 8, signals: [] };

const line = (text: string): LyricLine => ({ t0: 0, t1: 1, text, aligned: true });

function mountCard(lyricLines: LyricLine[], lyricLinesDefault?: LyricLine[]) {
  const ln = lyricsNode(0, 0);
  const graph: Graph = { ...emptyGraph(), nodes: [ln] };
  const onSaveLyricLines = vi.fn(async () => {});
  const ctx: NodeCtx = {
    graph,
    segment,
    compositions: {},
    signals: [],
    assets: [],
    job: "j",
    updateCompositions: vi.fn(),
    onGraphChange: vi.fn(),
    lyricLines,
    lyricLinesDefault,
    onSaveLyricLines,
  };
  const helpers = {
    onTitlePointerDown: vi.fn(),
    portRef: vi.fn(),
    startConnect: vi.fn(),
  } as unknown as Parameters<typeof LyricsNode>[0]["helpers"];
  const { container } = render(
    <LyricsNode
      node={graph.nodes[0] as LyricsNodeT}
      selected={false}
      helpers={helpers}
      ctx={ctx}
      onGraphChange={vi.fn()}
      onDetach={vi.fn()}
      onDelete={vi.fn()}
    />
  );
  const btn = () =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("restore"));
  return { btn, onSaveLyricLines };
}

describe("the Lyrics card's restore button", () => {
  it("posts the stored snapshot, not the edited lines", async () => {
    const original = [line("as sung")];
    const { btn, onSaveLyricLines } = mountCard([line("rewritten")], original);
    fireEvent.click(btn()!);
    await waitFor(() => expect(onSaveLyricLines).toHaveBeenCalledWith(original));
  });

  it("is disabled when the lines already ARE the original", () => {
    // Compared by value: a reload rebuilds both arrays, and an offer to restore what you
    // already have reads as a bug.
    const { btn } = mountCard([line("as sung")], [line("as sung")]);
    expect(btn()!.disabled).toBe(true);
  });

  it("is absent on a project analysed before snapshots existed", () => {
    // No snapshot means no restore point — showing the button would promise a recovery
    // the backend cannot perform.
    const { btn } = mountCard([line("as sung")], undefined);
    expect(btn()).toBeUndefined();
  });
});
