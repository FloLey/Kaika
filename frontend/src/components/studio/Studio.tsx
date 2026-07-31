import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ChangeEvent } from "react";
import SegmentRail from "./SegmentRail";
import SignalCard from "./SignalCard";
import TransportClock from "./TransportClock";
import AnimationCanvas from "../animation/AnimationCanvas";
import OutputSettings from "../animation/OutputSettings";
import AssetLibrary from "../assets/AssetLibrary";
import { defaultCardName } from "../animation/nodeInputs";
import { addAssetCard, emptyGraph } from "../../lib/graphModel";
import type { Asset as AssetT, LyricLine } from "../../lib/types";
import VolumeControl from "./VolumeControl";
import ConfirmDialog from "../../ui/ConfirmDialog";
import { useStudioPlayback } from "./useStudioPlayback";
import { useCompositionNav } from "./useCompositionNav";
import { engine } from "../../lib/audio";
import { PLAYGROUND_JOB, defaultTab } from "../../lib/route";
import { STEM_META, seedSignal } from "../../lib/segments";
import { copyLayout, createComposition, refCounts as poolRefCounts } from "../../lib/compositions";
import type {
  CompositionPool,
  Graph,
  OutputSettings as OutputSettingsT,
  Segment,
  Signal,
  StemInfo,
} from "../../lib/types";

interface StudioProps {
  segments: Segment[];
  setSegments: (updater: (prev: Segment[]) => Segment[]) => void;
  compositions: CompositionPool;
  setCompositions: (updater: (prev: CompositionPool) => CompositionPool) => void;
  activeSegId?: string;
  setActiveSegId: (id: string) => void;
  stems: Record<string, StemInfo>;
  duration?: number;
  job?: string;
  output: OutputSettingsT;
  setOutput: (o: OutputSettingsT) => void;
  // The final-export settings — the Output cards' HD render uses exactly these.
  exportSettings?: import("../../lib/export").ExportSettings;
  assets?: import("../../lib/types").Asset[];
  lyricLines?: LyricLine[];
  lyricLinesDefault?: LyricLine[];
  onSaveLyricLines?: (lines: LyricLine[]) => Promise<void>;
  // Which mix the shared transport plays ("instrumental" while building a cover
  // keeps the old vocal from fighting the new words).
  audioMode?: "original" | "instrumental";
  onEditSplit?: () => void;
  onExport?: () => void;
  // Playground only: capture the live state into the committed fixture (💾 in the rail).
  onSaveFixture?: () => Promise<import("../../lib/api").FixtureExport>;
  // Which of the two tabs is showing. Optional and CONTROLLED: pass both to hold it
  // somewhere else — the ?ui=next shell keeps it in the URL so a link can open the
  // graph. Omit both and Studio keeps it internally, as it always has.
  tab?: string;
  onTabChange?: (tab: string) => void;
}

// Stage 3 — the studio. Owns all playback/ephemeral state (rail open, what's
// playing, the full-mix reference clock, the per-signal audio registry) and the
// per-segment signal edits. App owns the project (segments/activeSegId) and
// passes setters down. Unmounting (leaving the studio) tears the audio graph
// down via the cleanup effect, so App never reaches into these internals.
export default function Studio({
  segments,
  setSegments,
  compositions,
  setCompositions,
  activeSegId,
  setActiveSegId,
  stems,
  duration,
  job,
  output,
  setOutput,
  exportSettings,
  assets,
  lyricLines,
  lyricLinesDefault,
  onSaveLyricLines,
  audioMode,
  onEditSplit,
  onExport,
  onSaveFixture,
  tab: tabProp,
  onTabChange,
}: StudioProps) {
  const [railOpen, setRailOpen] = useState(true);
  // The uncontrolled fallback, for a host that does not put the tab in the URL. The
  // rule itself is `route.defaultTab` — a routed host asks it directly, and this line
  // exists only to translate its answer into the two names this component uses.
  const [ownTab, setOwnTab] = useState(defaultTab(job ?? "") === "graph" ? "animation" : "signals");
  // "signals" | "animation" — controlled when the host passes both props, else ours.
  const tab = tabProp ?? ownTab;
  const setTab = onTabChange ?? setOwnTab;
  const [showOutput, setShowOutput] = useState(false); // output-settings modal
  const [showAssets, setShowAssets] = useState(false); // asset-library manager modal

  // Fullscreen the WHOLE studio panel (timeline + canvas + output modal + tabs), not
  // just the canvas — so the segment transport stays visible and the settings modal,
  // which lives in this subtree, still renders on top in fullscreen.
  const studioMainRef = useRef<HTMLDivElement>(null);
  const [isFull, setIsFull] = useState(false);
  useEffect(() => {
    const onFs = () => setIsFull(document.fullscreenElement === studioMainRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const toggleFullscreen = useCallback(() => {
    const el = studioMainRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => {});
  }, []);

  const activeSeg = useMemo(
    () => segments.find((s) => s.id === activeSegId) || null,
    [segments, activeSegId]
  );

  // Which composition is on screen, the breadcrumb that got you there, and the song
  // window that descent implies. The window feeds playback and every render key below,
  // which is why the descent and the window are computed together.
  const {
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
  } = useCompositionNav({ activeSeg, activeSegId, compositions, setCompositions, duration });

  // "used ×N" per composition (segment roots + extracts) — the reuse picker's
  // indicator and the last-reference confirm read it through ctx.
  const compRefCounts = useMemo(
    () => poolRefCounts(compositions, segments),
    [compositions, segments]
  );

  // The full mix this segment plays. `instrumental` while building a cover keeps the
  // old vocal from fighting the new words.
  const mixUrl = job
    ? `/audio/${job}/${audioMode === "instrumental" ? "instrumental" : "original"}`
    : "";

  // The playback surface (segment clock, per-signal registry, play/seek/solo/volume)
  // lives in this hook, over `lib/transport`; Studio just wires its output into the
  // view. The element itself is the shell's, mounted above the screen switch, so
  // leaving the studio doesn't stop the music.
  const {
    refAudio,
    allPlaying,
    subscribeClock,
    getClockT,
    volume,
    setVolume,
    loop,
    setLoop,
    seek,
    playAll,
    registerAudio,
    onPlayingChange,
    handleSolo,
  } = useStudioPlayback({ winStart, winEnd, segLen, src: mixUrl });

  const selectSegment = useCallback(
    (id: string) => {
      resetNav(); // back to the root even when re-clicking the same segment
      setActiveSegId(id);
    },
    [resetNav, setActiveSegId]
  );

  // ---- per-segment signal edits --------------------------------------------
  const editActiveSignals = useCallback(
    (fn: (sigs: Signal[]) => Signal[]) => {
      setSegments((prev) =>
        prev.map((s) => (s.id === activeSegId ? { ...s, signals: fn(s.signals) } : s))
      );
    },
    [activeSegId, setSegments]
  );

  const updateSignal = useCallback(
    (id: string, p: Partial<Signal>) => {
      editActiveSignals((sigs) => sigs.map((s) => (s.id === id ? { ...s, ...p } : s)));
    },
    [editActiveSignals]
  );

  const addSignal = useCallback(
    (stemKey: string) => {
      editActiveSignals((sigs) => {
        const meta = STEM_META.find((m: { key: string }) => m.key === stemKey);
        const n = sigs.filter((s) => s.stemKey === stemKey).length + 1;
        const name = `${(meta?.name || stemKey).toLowerCase()} ${n}`;
        return [...sigs, seedSignal(stems, name, stemKey)];
      });
    },
    [editActiveSignals, stems]
  );

  const removeSignal = useCallback(
    (id: string) => {
      engine.remove(id);
      registerAudio(id, null); // drop it from the playback registry
      editActiveSignals((sigs) => sigs.filter((s) => s.id !== id));
    },
    [editActiveSignals, registerAudio]
  );

  // The animation graph lives on the CURRENT composition in the pool (the root, or
  // the child the breadcrumb points at); patch it and let App's autosave persist
  // pool + segments together. The FIRST edit of a segment with no animation creates
  // its root composition and points the segment at it — two state updates from one
  // discrete event (the reference and the entry must land together, and neither
  // setter can reach the other's state). A NESTED composition always exists (an
  // extract references it), so creation only ever happens at the root.
  const setActiveGraph = useCallback(
    (graph: Graph) => {
      if (currentCompId && compositions[currentCompId]) {
        setCompositions((pool) => ({
          ...pool,
          [currentCompId]: { ...pool[currentCompId], graph },
        }));
        return;
      }
      if (!activeSeg || navFrame) return;
      const comp = createComposition(activeSeg.label, graph);
      setCompositions((pool) => ({ ...pool, [comp.id]: comp }));
      setSegments((prev) =>
        prev.map((s) => (s.id === activeSeg.id ? { ...s, rootCompositionId: comp.id } : s))
      );
    },
    [activeSeg, navFrame, currentCompId, compositions, setCompositions, setSegments]
  );

  // Mark (or clear, with an empty id) the composition's "final" output — the one
  // the export stage renders (for the root) or the extract plays (for a child).
  // Lives on the composition (`outputId`), same autosave path as a graph edit. An
  // OutputNode toggles this via ctx.setFinalOutput.
  const setFinalOutput = useCallback(
    (nodeId: string) => {
      if (!currentCompId) return; // no composition yet — nothing to mark
      setCompositions((pool) =>
        pool[currentCompId]
          ? { ...pool, [currentCompId]: { ...pool[currentCompId], outputId: nodeId || undefined } }
          : pool
      );
    },
    [currentCompId, setCompositions]
  );

  // Copy the current segment's card layout (its root composition) onto an ADJACENT
  // segment (previous or next), so you can build once and reuse the pipeline up or
  // down the track. `copyLayout` clones the composition AND rewires its signal cards
  // onto the target segment's own signals (matching bands, cloning any it's missing)
  // — so the copy drives the right segment, never the source.
  const segIdx = useMemo(
    () => segments.findIndex((s) => s.id === activeSegId),
    [segments, activeSegId]
  );
  const prevSeg = segIdx > 0 ? segments[segIdx - 1] : null;
  const nextSeg = segIdx >= 0 && segIdx + 1 < segments.length ? segments[segIdx + 1] : null;
  const hasCards = !!activeComp?.graph.nodes?.length;
  const segHasCards = useCallback(
    (seg: Segment | null) =>
      !!(seg?.rootCompositionId && compositions[seg.rootCompositionId]?.graph.nodes?.length),
    [compositions]
  );
  const runCopyLayout = useCallback(
    (target: Segment) => {
      if (!activeSeg) return;
      const res = copyLayout(activeSeg, target, compositions);
      setCompositions(() => res.pool);
      setSegments((prev) => prev.map((s) => (s.id === target.id ? res.target : s)));
      selectSegment(target.id); // follow the copy onto the target segment
    },
    [activeSeg, compositions, setCompositions, setSegments, selectSegment]
  );
  // Clicking an asset in the library DROPS ITS CARD on the canvas, already pointing at
  // that file — the montage workflow is "pick twenty clips", and doing that through the
  // palette meant: add card, open its library, pick, repeat. The modal stays open so a
  // run of clips is a run of clicks; cards stack in a column under the existing graph so
  // nothing lands on top of anything.
  const [addedCount, setAddedCount] = useState(0);
  const dropAssetCard = useCallback(
    (asset: AssetT) => {
      if (!activeSeg) return;
      const base = activeComp?.graph || emptyGraph();
      setActiveGraph(addAssetCard(base, asset, defaultCardName(base, asset.kind)));
      setAddedCount((n) => n + 1);
      setTab("animation"); // the card lands on the canvas — show it
    },
    // `setTab` is a real dependency now that the tab can be CONTROLLED: it is either
    // our own state setter (stable) or the host's `onTabChange` (not necessarily).
    [activeSeg, activeComp, setActiveGraph, setTab]
  );

  // Overwriting a segment that already has cards asks first (the target's animation
  // is replaced wholesale); an empty target copies straight through.
  const [copyTarget, setCopyTarget] = useState<Segment | null>(null);
  const copyLayoutTo = useCallback(
    (target: Segment | null) => {
      if (!target || !hasCards) return;
      if (segHasCards(target)) setCopyTarget(target);
      else runCopyLayout(target);
    },
    [hasCards, segHasCards, runCopyLayout]
  );

  return (
    <div className={"studio" + (railOpen ? "" : " rail-collapsed")}>
      {railOpen ? (
        <SegmentRail
          segments={segments}
          activeSegId={activeSegId}
          onSelect={selectSegment}
          onCollapse={() => setRailOpen(false)}
          grouped={job === PLAYGROUND_JOB}
          onSaveFixture={onSaveFixture}
        />
      ) : (
        <button className="rail-reopen" title="Show segments" onClick={() => setRailOpen(true)}>
          ☰
        </button>
      )}
      <div className={"studio-main" + (isFull ? " full" : "")} ref={studioMainRef}>
        <div className="results-head">
          <span className="section-title">
            {navStack.length ? (
              // The breadcrumb: segment ▸ extract 3 · clip ▸ … — every ancestor is a
              // click back up; exactly one composition's graph is on screen at a time.
              <span className="comp-breadcrumb">
                <button className="crumb" onClick={() => navTo(0)}>
                  {activeSeg?.label.toUpperCase()}
                </button>
                {navStack.map((f, i) => (
                  <span key={`${f.compositionId}-${i}`}>
                    {" ▸ "}
                    {i === navStack.length - 1 ? (
                      renameDraft != null && f.kind === "comp" ? (
                        <input
                          className="crumb-rename"
                          value={renameDraft}
                          autoFocus
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") setRenameDraft(null);
                          }}
                        />
                      ) : (
                        <span
                          className="crumb-here"
                          title={
                            f.kind === "comp"
                              ? "double-click to rename this composition"
                              : undefined
                          }
                          onDoubleClick={() =>
                            f.kind === "comp" && setRenameDraft(activeComp?.name || "")
                          }
                        >
                          {f.label}
                        </span>
                      )
                    ) : (
                      <button className="crumb" onClick={() => navTo(i + 1)}>
                        {f.label}
                      </button>
                    )}
                  </span>
                ))}
                <button className="btn sm crumb-up" onClick={() => navTo(navStack.length - 1)}>
                  ↩ up
                </button>
              </span>
            ) : (
              <>
                {activeSeg ? activeSeg.label.toUpperCase() : "FULL TRACK"}
                {/* The active tab already names the mode, so only the (informative) "by
                    track" nuance of the signals tab is worth spelling out in the title. */}
                {tab === "signals" ? " · EXTRACT SIGNALS BY TRACK" : ""}
              </>
            )}
          </span>
          {/* The header row is now IDENTITY + TRANSPORT only. Everything that acts on
              something — the mode tabs, the segment actions, the step nav — moved down
              to `.studio-bar`, grouped by what it acts ON. */}
          <div className="controls">
            <div className="rh-transport">
              <button
                className="btn on seg-play"
                onClick={playAll}
                title={allPlaying ? "Pause" : "Play segment"}
                aria-label={allPlaying ? "Pause" : "Play segment"}
              >
                {allPlaying ? "❚❚" : "▶"}
              </button>
              <TransportClock
                subscribe={subscribeClock}
                getClockT={getClockT}
                segLen={segLen}
                seek={seek}
              />
              <VolumeControl value={volume} onChange={setVolume} />
              <label className="loop-toggle" title="Loop the segment">
                <input
                  type="checkbox"
                  checked={loop}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setLoop(e.target.checked)}
                />
                loop
              </label>
            </div>
          </div>
        </div>

        {/* One bar, three clusters, ordered by widening scope: which VIEW of this
            segment (the tabs — they used to live at the far bottom of the page, a full
            stage away from the title that names the active one), what acts on THIS
            SEGMENT, and what leaves the step entirely. `📚 assets` sits in the segment
            cluster because it is an action (it opens a modal) — as a third tab it read
            as a mode you could switch to, which it never was. */}
        <nav className="studio-bar">
          <div className="mode-tabs" role="tablist" aria-label="segment view">
            <button
              className={"mode-tab" + (tab === "signals" ? " on" : "")}
              role="tab"
              aria-selected={tab === "signals"}
              onClick={() => setTab("signals")}
            >
              extract signals by track
            </button>
            <button
              className={"mode-tab" + (tab === "animation" ? " on" : "")}
              role="tab"
              aria-selected={tab === "animation"}
              onClick={() => setTab("animation")}
            >
              create animation
            </button>
          </div>

          {/* Acts on THIS segment. */}
          <div className="rh-segment">
            {tab === "animation" && !navFrame && (
              // One segmented control: copy this segment's card layout onto the
              // previous / next neighbour. Each side disables at its end of the track.
              // Hidden inside an extract — copying is a segment-root affair.
              <span className="rh-copy" role="group" aria-label="copy layout to a neighbour">
                <span className="rh-copy-label">⧉ copy</span>
                <button
                  className="btn sm rh-copy-btn"
                  onClick={() => copyLayoutTo(prevSeg)}
                  disabled={!(prevSeg && hasCards)}
                  title={
                    prevSeg
                      ? `Copy these cards to the previous segment (${prevSeg.label})`
                      : "No previous segment to copy to"
                  }
                >
                  ‹ prev
                </button>
                <button
                  className="btn sm rh-copy-btn"
                  onClick={() => copyLayoutTo(nextSeg)}
                  disabled={!(nextSeg && hasCards)}
                  title={
                    nextSeg
                      ? `Copy these cards to the next segment (${nextSeg.label})`
                      : "No next segment to copy to"
                  }
                >
                  next ›
                </button>
              </span>
            )}
            <button
              className="btn sm"
              onClick={() => setShowAssets(true)}
              title="Images, videos and audio you've uploaded — pick one to drop a card"
            >
              📚 assets
            </button>
          </div>

          {/* Leaves the step: back to the split, or on to the final export. */}
          <div className="rh-nav">
            <button className="btn sm edit-split" onClick={onEditSplit}>
              ↩ edit split
            </button>
            {onExport && (
              <button
                className="btn sm final-export"
                onClick={onExport}
                title="Render the whole track in HD (mark a final output per segment first)"
              >
                Final export ▸
              </button>
            )}
          </div>
        </nav>

        {tab === "signals"
          ? activeSeg &&
            STEM_META.filter((m: { key: string }) => stems[m.key]).map(
              (stem: { key: string; name: string; color: string }) => {
                const sigs = activeSeg.signals.filter((s) => s.stemKey === stem.key);
                return (
                  <div
                    className="track-group"
                    key={stem.key}
                    style={{ "--accent": stem.color } as CSSProperties}
                  >
                    <div className="track-group-head">
                      <span className="track-name">
                        <span className="dot" />
                        {stem.name}
                      </span>
                      <button className="btn sm" onClick={() => addSignal(stem.key)}>
                        + add band
                      </button>
                    </div>
                    {sigs.length === 0 && (
                      <div className="track-empty">
                        no signals — add a frequency band to extract one
                      </div>
                    )}
                    <div className="signals">
                      {sigs.map((sg) => (
                        <SignalCard
                          key={sg.id}
                          signal={sg}
                          stems={stems}
                          segStart={activeSeg.start}
                          segEnd={activeSeg.end}
                          duration={duration}
                          jobId={job}
                          onChange={updateSignal}
                          onRemove={removeSignal}
                          registerAudio={registerAudio}
                          onSolo={handleSolo}
                          onPlayingChange={onPlayingChange}
                          groupClock={refAudio}
                          groupPlaying={allPlaying}
                        />
                      ))}
                    </div>
                  </div>
                );
              }
            )
          : activeSeg &&
            viewSegment && (
              <AnimationCanvas
                // Keyed per COMPOSITION: entering an extract remounts the canvas
                // (fresh selection/undo — history is per composition).
                key={currentCompId || activeSeg.id}
                segment={viewSegment}
                graph={activeComp?.graph ?? null}
                finalOutputId={activeComp?.outputId}
                compositions={compositions}
                compositionId={currentCompId}
                refCounts={compRefCounts}
                updateCompositions={setCompositions}
                enterExtract={enterExtract}
                enterMontage={enterMontage}
                montageEditorNodeId={
                  navFrame?.kind === "montage" ? navFrame.montageNodeId : undefined
                }
                stems={stems}
                job={job}
                output={output}
                exportSettings={exportSettings}
                assets={assets}
                lyricLines={lyricLines}
                lyricLinesDefault={lyricLinesDefault}
                onSaveLyricLines={onSaveLyricLines}
                groupClock={refAudio}
                groupPlaying={allPlaying}
                isFullscreen={isFull}
                onToggleFullscreen={toggleFullscreen}
                onOpenOutput={() => setShowOutput(true)}
                onGraphChange={setActiveGraph}
                setFinalOutput={setFinalOutput}
                // ⌘K's reach beyond this composition (?ui=next): jump to a segment
                // without going back through the rail.
                segments={segments}
                onSelectSegment={selectSegment}
              />
            )}

        {showOutput && (
          <OutputSettings
            output={output}
            onChange={setOutput}
            onClose={() => setShowOutput(false)}
          />
        )}
        {showAssets && (
          <AssetLibrary
            jobId={job}
            onPick={activeSeg ? dropAssetCard : undefined}
            pickLabel={
              addedCount ? `${addedCount} card${addedCount === 1 ? "" : "s"} added` : undefined
            }
            onClose={() => {
              setShowAssets(false);
              setAddedCount(0);
            }}
          />
        )}
      </div>

      <ConfirmDialog
        open={!!copyTarget}
        message={`Replace “${copyTarget?.label}”'s animation with this segment's layout?`}
        confirmLabel="Replace"
        danger
        onConfirm={() => {
          if (copyTarget) runCopyLayout(copyTarget);
          setCopyTarget(null);
        }}
        onCancel={() => setCopyTarget(null)}
      />
    </div>
  );
}
