import { useCallback, useEffect, useMemo, useState } from "react";
import * as transport from "../../lib/transport";
import type { CompositionPool, Segment } from "../../lib/types";

// Which composition is on screen, and the breadcrumb that got you there.
//
// Exactly ONE composition is on screen: the segment's root, or — after "open" on a
// montage extract — a child, any depth down. Each frame snapshots the extract's absolute
// song WINDOW at entry (computed by the montage card from its cut schedule): the child's
// edits can't move the parent's cuts, because the trigger lives in the parent, so the
// snapshot stays true while you are inside and the transport and previews simply follow
// the current window.
//
// The window is the reason this is a hook rather than a component: `winStart`/`winEnd`
// come out of the nav stack and feed playback, the canvas's view segment, and every
// render key, so the descent and the window have to be computed in one place.
//
// It calls `transport.reset()` directly rather than taking a reset callback. That looks
// like a shortcut and is the opposite: the reset lives on the module-level store, so
// taking it as an argument would create a cycle — playback needs the window this hook
// produces, and this hook would need a function playback returns.

export interface NavFrame {
  // "comp" = a child composition's canvas; "montage" = the montage EDITOR over a montage
  // card of the frame's composition (same composition, richer surface).
  kind: "comp" | "montage";
  compositionId: string;
  montageNodeId?: string; // montage frames only
  label: string; // "extract 3 · clip name" / the montage's name — the breadcrumb text
  window: { start: number; end: number }; // absolute song seconds
}

interface NavOpts {
  activeSeg: Segment | null;
  activeSegId?: string;
  compositions: CompositionPool;
  setCompositions: (updater: (prev: CompositionPool) => CompositionPool) => void;
  duration?: number;
}

export function useCompositionNav({
  activeSeg,
  activeSegId,
  compositions,
  setCompositions,
  duration,
}: NavOpts) {
  const [navStack, setNavStack] = useState<NavFrame[]>([]);
  useEffect(() => setNavStack([]), [activeSegId]); // a new segment starts at its root

  const navFrame = navStack.length ? navStack[navStack.length - 1] : null;
  const currentCompId = navFrame?.compositionId ?? activeSeg?.rootCompositionId;
  const activeComp = (currentCompId && compositions[currentCompId]) || null;

  // A frame whose composition — or, for a montage frame, whose montage card — vanished
  // (deleted in another view) pops itself.
  useEffect(() => {
    if (!navFrame) return;
    const comp = compositions[navFrame.compositionId];
    const gone =
      !comp ||
      (navFrame.kind === "montage" &&
        !comp.graph.nodes.some((n) => n.id === navFrame.montageNodeId && n.type === "montage"));
    if (gone) setNavStack((s) => s.slice(0, -1));
  }, [navFrame, compositions]);

  // No segment selected → the window is the whole track, so the full mix can play before
  // any segment exists. Inside an extract, the window IS the extract's: the transport
  // plays just that slice of the song, so the live view scrubs against the right bars.
  const winStart = navFrame ? navFrame.window.start : activeSeg ? activeSeg.start : 0;
  const winEnd = navFrame ? navFrame.window.end : activeSeg ? activeSeg.end : duration || 0;
  const segLen = Math.max(0.001, winEnd - winStart);

  // What the canvas edits: the host segment, re-windowed to the current frame — every
  // consumer (previews, render keys, signal resolution) reads start/end + signals off
  // ctx.segment, so re-windowing here drives them all at once.
  const viewSegment = useMemo(
    () => (activeSeg && navFrame ? { ...activeSeg, start: winStart, end: winEnd } : activeSeg),
    [activeSeg, navFrame, winStart, winEnd]
  );

  // Back to the root — used when selecting a segment, including re-selecting the current
  // one, which is why it does not check whether the id changed.
  const resetNav = useCallback(() => {
    transport.reset();
    setNavStack([]);
  }, []);

  // "Open" on a montage extract: descend into its child composition. The card computes
  // the window (it owns the cut schedule) and hands it over.
  const enterExtract = useCallback(
    (montageNodeId: string, extractId: string, window: { start: number; end: number }) => {
      const comp = activeComp;
      if (!comp) return;
      const mg = comp.graph.nodes.find((n) => n.id === montageNodeId && n.type === "montage");
      const extracts = mg?.type === "montage" ? mg.data.extracts : [];
      const idx = extracts.findIndex((x) => x.id === extractId);
      const child = idx >= 0 ? compositions[extracts[idx].compositionId] : undefined;
      if (!child) return;
      transport.reset();
      setNavStack((s) => [
        ...s,
        {
          kind: "comp",
          compositionId: child.id,
          label: `extract ${idx + 1} · ${child.name}`,
          window,
        },
      ]);
    },
    [activeComp, compositions]
  );

  // A montage card's compact body opens the MONTAGE EDITOR — its own breadcrumb level
  // over the SAME composition and window (the strip + live view + wiring rail want the
  // full canvas area, not a modal).
  const enterMontage = useCallback(
    (montageNodeId: string) => {
      const comp = activeComp;
      if (!comp) return;
      const mg = comp.graph.nodes.find((n) => n.id === montageNodeId && n.type === "montage");
      if (!mg) return;
      setNavStack((s) => [
        ...s,
        {
          kind: "montage",
          compositionId: comp.id,
          montageNodeId,
          label: mg.name || "montage",
          window: { start: winStart, end: winEnd },
        },
      ]);
    },
    [activeComp, winStart, winEnd]
  );

  // The breadcrumb: click the segment crumb (depth -1) or any ancestor frame to pop back
  // to it.
  const navTo = useCallback((depth: number) => {
    transport.reset();
    setNavStack((s) => s.slice(0, Math.max(0, depth)));
  }, []);

  // Double-click the CURRENT crumb to rename the open composition — a shared
  // composition's name is how the reuse picker and every referencing strip tile identify
  // it, so it is editable where you are already looking at it.
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const commitRename = useCallback(() => {
    const name = renameDraft?.trim();
    setRenameDraft(null);
    if (!name || !navFrame || navFrame.kind !== "comp" || !currentCompId) return;
    setCompositions((pool) =>
      pool[currentCompId] ? { ...pool, [currentCompId]: { ...pool[currentCompId], name } } : pool
    );
    // The frame label snapshots the name at entry — follow the rename.
    setNavStack((s) =>
      s.map((f, i) =>
        i === s.length - 1 ? { ...f, label: f.label.replace(/·[^·]*$/, `· ${name}`) } : f
      )
    );
  }, [renameDraft, navFrame, currentCompId, setCompositions]);

  return {
    navStack,
    navFrame,
    currentCompId,
    activeComp,
    winStart,
    winEnd,
    segLen,
    viewSegment,
    resetNav,
    enterExtract,
    enterMontage,
    navTo,
    renameDraft,
    setRenameDraft,
    commitRename,
  };
}
