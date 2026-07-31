import { useRef, useState } from "react";
import BreakpointTimeline, { partColor, useLivePart } from "./BreakpointTimeline";
import CropPad from "./nodes/CropPad";
import StreamPreview from "./nodes/StreamPreview";
import InputPicker from "./InputPicker";
import AssetLibrary from "../assets/AssetLibrary";
import Ctl from "../../ui/Ctl";
import ArgInfo from "./nodes/ArgInfo";
import { useMontageShortfall } from "./nodes/useMontageShortfall";
import { useNodeData } from "./nodes/useNodeData";
import { dp2 } from "./nodes/nodeConstants";
import { argHelp } from "../../lib/paramHelp";
import { ctxAspect } from "../../lib/output";
import ConfirmDialog from "../../ui/ConfirmDialog";
import { videoClipSrc, videoThumbSrc } from "../../lib/assetPreview";
import { leafComposition, wouldCycle } from "../../lib/compositions";
import {
  addExtract,
  moveExtract,
  removeExtract,
  setExtractComposition,
  setExtractSpan,
} from "../../lib/graphModel";
import { jobIdOf, type NodeCtx } from "./nodes/nodeProps";
import type { Asset, Graph, GraphNode, MontageData } from "../../lib/types";

interface Props {
  node: GraphNode; // the live montage node (updates on every graph commit)
  ctx: NodeCtx;
  onGraphChange: (updater: (g: Graph) => Graph) => void;
}

// A leaf clip's thumbnail with a graceful miss: the server-side `<sha>-thumb.jpg`
// only exists for LIBRARY videos (upload/backfill write it) — a seeded or
// hand-placed asset has none, and a broken-image icon reads as "the app is
// broken". On error, fall back to a metadata-only <video> over the server-cut
// 1s excerpt (`/asset-clip` generates it on demand, ~57 KB): a real first frame,
// never the raw asset.
function TileThumb({ url, start }: { url: string; start: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <video src={videoClipSrc(url, start, 1)} preload="metadata" muted playsInline />;
  }
  return <img src={videoThumbSrc(url)} alt="" draggable={false} onError={() => setFailed(true)} />;
}

// The MONTAGE EDITOR — the full-area view a montage opens into (its own breadcrumb
// level: segment ▸ montage). The strip of extracts runs across the top, each tile
// showing its child composition (a leaf clip's thumbnail, or an "animation" tile);
// the live switched output plays large underneath, slaved to the shared transport —
// scrub the timeline and the extract under the playhead is what you see, with the
// audio it will play under. The right rail keeps the wiring surface (trigger/opacity
// via the INPUTS panel) and the gate's threshold/hysteresis.
export default function MontageEditor({ node, ctx, onGraphChange }: Props) {
  const d = node.data as MontageData;
  const set = useNodeData<MontageData>(node, onGraphChange);
  const {
    extracts,
    comps,
    cuts,
    fps,
    coverage,
    extractLabel,
    clips,
    shortfall,
    shortRows,
    repeats,
  } = useMontageShortfall(node, ctx);

  // The extract under the playhead: its tile and timeline band highlight while the
  // transport moves, so "which video is this?" answers itself.
  const segStart = ctx.segStart ?? ctx.segment?.start ?? 0;
  const liveExtract = useLivePart(ctx.groupClock, cuts?.starts, cuts?.total ?? 0, fps, segStart);

  // Clicking a coverage band on the timeline SELECTS that video: its tile scrolls
  // into view and takes a dashed outline in its colour — the answer to "which tile
  // is that stretch?" on a strip too long to eyeball. Clicking a tile selects too,
  // so the highlight reads both ways. Index-based; clamped so a removed extract
  // can't leave a stale highlight.
  const [selected, setSelected] = useState<number | null>(null);
  const tileRefs = useRef<(HTMLDivElement | null)[]>([]);
  const picked = selected != null && selected < extracts.length ? selected : null;
  const selectExtract = (k: number) => {
    setSelected(k);
    // jsdom has no scrollIntoView — guard, the highlight alone still testifies.
    tileRefs.current[k]?.scrollIntoView?.({
      behavior: "smooth",
      inline: "nearest",
      block: "nearest",
    });
  };

  // "+ video" appends a leaf; "pick" on a tile RE-POINTS that extract at a new leaf
  // (the composition it left stays in the pool — lifecycle is the prune's job).
  const [picking, setPicking] = useState<null | { replaceId?: string }>(null);
  const pickVideo = (asset: Asset) => {
    const comp = leafComposition(asset);
    ctx.updateCompositions?.((pool) => ({ ...pool, [comp.id]: comp }));
    const replaceId = picking?.replaceId;
    onGraphChange((g) =>
      replaceId
        ? setExtractComposition(g, node.id, replaceId, comp.id)
        : addExtract(g, node.id, comp.id)
    );
    if (replaceId) setPicking(null); // replacing is one pick; adding stays open for a run
  };

  const openExtract = (k: number) => {
    if (!ctx.enterExtract || !ctx.segment) return;
    const seg = ctx.segment;
    let start = seg.start;
    let end = seg.end;
    if (cuts && k < cuts.starts.length) {
      const endF = k + 1 < cuts.starts.length ? cuts.starts[k + 1] : cuts.total;
      start = seg.start + cuts.starts[k] / fps;
      end = seg.start + endF / fps;
    }
    ctx.enterExtract(node.id, extracts[k].id, { start, end });
  };

  // Strip drag-reorder: plain HTML5 drag, dropping on a tile moves the dragged
  // extract to that index (moveExtract clamps).
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  // "⟳ reuse": reference an EXISTING composition from a new extract — the DAG
  // sharing gesture. Anything that would make this composition contain itself
  // (directly or transitively) is filtered OUT at the source; the backend's
  // validate_pool 400s as the belt-and-braces.
  const [reusing, setReusing] = useState(false);
  const pool = ctx.compositions || {};
  const reusable = Object.values(pool).filter(
    (c) => !ctx.compositionId || !wouldCycle(pool, ctx.compositionId, c.id)
  );

  // Removing the LAST reference orphans the composition (the save-time prune
  // collects it) — say so before it happens. Other references keep it alive, so
  // those removals don't ask.
  const [confirmRemove, setConfirmRemove] = useState<{ extractId: string; name: string } | null>(
    null
  );
  const removeOne = (k: number) => {
    const comp = comps[k];
    const uses = comp ? (ctx.refCounts?.[comp.id] ?? 0) : 0;
    if (comp && uses <= 1) {
      setConfirmRemove({ extractId: extracts[k].id, name: comp.name });
    } else {
      onGraphChange((g) => removeExtract(g, node.id, extracts[k].id));
    }
  };

  return (
    <div className="montage-editor">
      <div className="montage-strip" role="list" aria-label="extracts">
        {extracts.map((x, k) => {
          const comp = comps[k];
          const clip = clips[k];
          const sf = shortfall(k);
          const goesBlack = sf != null && !sf.loop;
          const label = extractLabel(k);
          return (
            <div
              key={x.id}
              role="listitem"
              ref={(el) => {
                tileRefs.current[k] = el;
              }}
              className={
                "montage-tile" +
                (goesBlack ? " short" : "") +
                (label === "unused" ? " unused" : "") +
                (k === liveExtract ? " live" : "") +
                (k === picked ? " picked" : "")
              }
              style={k === liveExtract || k === picked ? { outlineColor: partColor(k) } : undefined}
              onClick={() => setSelected(k)}
              draggable
              onDragStart={() => setDragFrom(k)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragFrom != null && dragFrom !== k) {
                  onGraphChange((g) => moveExtract(g, node.id, extracts[dragFrom].id, k));
                }
                setDragFrom(null);
              }}
            >
              <div className="montage-tile-thumb">
                {clip ? (
                  <TileThumb url={clip.url} start={clip.start + (x.inPoint || 0)} />
                ) : (
                  <span className="montage-tile-anim">{comp ? "✦" : "⚠"}</span>
                )}
              </div>
              <div className="montage-tile-name" title={comp?.name}>
                <span className="montage-tile-key" style={{ background: partColor(k) }} />
                {k + 1}. {comp ? comp.name : "missing composition"}
              </div>
              <div className="montage-tile-meta">
                {label && <span className="anim-montage-dur">{label}</span>}
                {sf && (
                  <span
                    className="anim-montage-short"
                    title={
                      `clip too short: ${sf.avail.toFixed(1)}s available for a ` +
                      `${sf.needed.toFixed(1)}s extract — ` +
                      (sf.loop ? "it loops" : `BLACK for the last ${sf.short.toFixed(1)}s`)
                    }
                  >
                    ⚠ −{sf.short.toFixed(1)}s
                  </span>
                )}
                {repeats[k] && (
                  <span
                    className={"anim-montage-dup" + (repeats[k]!.identical ? " same" : "")}
                    title={`same footage as extract ${repeats[k]!.row}${
                      repeats[k]!.identical ? " — identical frames" : " (different in-point)"
                    }`}
                  >
                    ⧉ {repeats[k]!.row}
                  </span>
                )}
              </div>
              <div className="montage-tile-actions">
                <button
                  className={"iconbtn anim-montage-span" + ((x.span || 1) > 1 ? " on" : "")}
                  title="cuts this extract swallows (click: ×1 → ×2 → ×3 → ×4)"
                  onClick={() =>
                    onGraphChange((g) =>
                      setExtractSpan(
                        g,
                        node.id,
                        x.id,
                        Math.max(1, Math.round(x.span || 1)) >= 4
                          ? 1
                          : Math.max(1, Math.round(x.span || 1)) + 1
                      )
                    )
                  }
                >
                  ×{Math.max(1, Math.round(x.span || 1))}
                </button>
                <button
                  className="iconbtn"
                  title="pick a different clip for this extract"
                  onClick={() => setPicking({ replaceId: x.id })}
                >
                  🎬
                </button>
                {comp && (
                  <button
                    className="iconbtn anim-extract-open"
                    title="open this extract's composition — edit what it plays"
                    onClick={() => openExtract(k)}
                  >
                    ▸
                  </button>
                )}
                <button
                  className="iconbtn anim-combine-rm"
                  title={
                    comp && (ctx.refCounts?.[comp.id] ?? 0) > 1
                      ? `remove extract — "${comp.name}" stays (used in ${ctx.refCounts![comp.id]} places)`
                      : "remove extract"
                  }
                  onClick={() => removeOne(k)}
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })}
        <button
          className="montage-tile montage-tile-add"
          onClick={() => setPicking({})}
          title="pick a clip from the library — it becomes a video→output composition played by a new extract"
        >
          + video
        </button>
        <button
          className="montage-tile montage-tile-add"
          onClick={() => setReusing(true)}
          title="reference an EXISTING composition — the same one can play in several extracts; editing it updates them all"
        >
          ⟳ reuse
        </button>
      </div>

      {reusing && (
        <div className="montage-reuse" role="dialog" aria-label="reuse a composition">
          <div className="anim-fx-hint">
            reuse a composition — ancestors are hidden (a composition can't contain itself)
            <button className="iconbtn" onClick={() => setReusing(false)} title="close">
              ✕
            </button>
          </div>
          {reusable.length === 0 && <div className="anim-fx-hint">nothing reusable yet</div>}
          {reusable.map((c) => (
            <button
              key={c.id}
              className="montage-reuse-row"
              onClick={() => {
                onGraphChange((g) => addExtract(g, node.id, c.id));
                setReusing(false);
              }}
            >
              <span className="montage-reuse-name">{c.name}</span>
              <span className="montage-reuse-uses">used ×{ctx.refCounts?.[c.id] ?? 0}</span>
            </button>
          ))}
        </div>
      )}

      {/* Both cut sources on one strip, provenance always visible: gate cuts click
          off/on (they stay greyed, never hidden), manual cuts place/drag/delete.
          The extract boundaries above redraw live off the same schedule. */}
      {cuts && (
        <BreakpointTimeline
          nodeId={node.id}
          marks={cuts.marks}
          fps={fps}
          total={cuts.total}
          clock={ctx.groupClock}
          segStart={segStart}
          onGraphChange={onGraphChange}
          lane={
            /* The EXTRACTS lane: material coverage, one clickable band per stretch.
               Click a band to SELECT the video playing there — its own lane above the
               rail, so selecting can never collide with click-to-place-a-cut. */
            <div className="bp-extracts" role="group" aria-label="extract coverage">
              {coverage.map((b, i) => (
                <button
                  key={`c${i}`}
                  type="button"
                  className={
                    "bp-band" +
                    (b.kind === "black" ? " bp-band-black" : "") +
                    (b.kind === "covered" && b.extract === liveExtract ? " bp-band-live" : "")
                  }
                  style={{
                    left: `${(b.from / cuts.total) * 100}%`,
                    width: `${((b.to - b.from) / cuts.total) * 100}%`,
                    // The band under the playhead brightens (b3 vs 59 alpha): "this is
                    // the video playing right now".
                    ...(b.kind === "covered"
                      ? {
                          background: `${partColor(b.extract)}${b.extract === liveExtract ? "b3" : "59"}`,
                        }
                      : {}),
                  }}
                  title={
                    (b.kind === "black"
                      ? `no material here — the export renders BLACK (extract ${b.extract + 1})`
                      : `extract ${b.extract + 1}`) + " — click to select its tile"
                  }
                  onClick={() => selectExtract(b.extract)}
                />
              ))}
            </div>
          }
          legend={
            <>
              <span className="bp-key bp-key-gate" /> gate ·{" "}
              <span className="bp-key bp-key-manual" /> manual ·{" "}
              <span className="bp-key bp-key-covered" /> filmed ·{" "}
              <span className="bp-key bp-key-black" /> black · {(cuts.total / fps).toFixed(1)}s
              <ArgInfo type="montage" k="breakpoints" />
            </>
          }
        />
      )}

      <div className="montage-editor-body">
        <div className="montage-live">
          {/* The switched output, big, slaved to the shared transport — at any
              playhead position this IS the current extract, playing under its audio. */}
          <StreamPreview node={node} ctx={ctx} aspect={ctxAspect(ctx)} />
          <div className="anim-fx-hint anim-slideshow-count">
            {extracts.length} extract{extracts.length === 1 ? "" : "s"} · cuts{" "}
            <strong>{cuts ? cuts.rises : 0}×</strong>
            {shortRows.black > 0.05 && (
              <span className="anim-montage-short">
                {" · ⚠ "}
                <strong>{shortRows.black.toFixed(1)}s black</strong>
              </span>
            )}
            <ArgInfo type="montage" k="extracts" />
          </div>
        </div>

        <div className="montage-rail">
          {/* The picked tile's FRAMING, right here in the editor: the rect is locked
              to the export shape (what's inside IS the final image), ⬚ shows the
              default centered cover — no diving into each extract to fix a crop. */}
          {picked != null && clips[picked] && comps[picked] && (
            <div className="anim-static montage-crop">
              <span className="anim-mod-remap-label">
                framing — extract {picked + 1} <ArgInfo type="video" k="crop" />
              </span>
              <CropPad
                crop={clips[picked]!.crop}
                src={clips[picked]!.url}
                targetAspect={(ctx.output?.width || 1080) / Math.max(1, ctx.output?.height || 1920)}
                onChange={(c) => {
                  const compId = comps[picked]!.id;
                  const videoId = clips[picked]!.nodeId;
                  ctx.updateCompositions?.((pool) => {
                    const comp = pool[compId];
                    if (!comp) return pool;
                    const nodes = comp.graph.nodes.map((n) =>
                      n.id === videoId
                        ? ({
                            ...n,
                            data: {
                              ...n.data,
                              crop_x: c.x,
                              crop_y: c.y,
                              crop_w: c.w,
                              crop_h: c.h,
                            },
                          } as typeof n)
                        : n
                    );
                    return { ...pool, [compId]: { ...comp, graph: { ...comp.graph, nodes } } };
                  });
                }}
              />
            </div>
          )}
          <div className="anim-static">
            <Ctl
              label="threshold"
              value={d.threshold}
              min={0}
              max={1}
              step={0.01}
              fmt={dp2}
              onChange={(v) => set({ threshold: v })}
              {...argHelp("montage", "threshold")}
            />
            <Ctl
              label="hysteresis"
              value={d.hysteresis}
              min={0}
              max={0.5}
              step={0.01}
              fmt={dp2}
              onChange={(v) => set({ hysteresis: v })}
              {...argHelp("montage", "hysteresis")}
            />
          </div>
          {/* The wiring surface (trigger/opacity: value + source), same panel as the
              settings window — the editor replaces the modal for this card. */}
          {ctx.graph && (
            <InputPicker
              node={node}
              graph={ctx.graph}
              signals={ctx.segment?.signals}
              onGraphChange={onGraphChange}
            />
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!confirmRemove}
        message={`This is the last reference to “${confirmRemove?.name}” — removing the extract will delete the composition on the next save.`}
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          if (confirmRemove) {
            const id = confirmRemove.extractId;
            onGraphChange((g) => removeExtract(g, node.id, id));
          }
          setConfirmRemove(null);
        }}
        onCancel={() => setConfirmRemove(null)}
      />
      {picking && (
        <AssetLibrary
          jobId={jobIdOf(ctx.job)}
          kind="video"
          onPick={pickVideo}
          pickLabel={
            picking.replaceId
              ? "pick the replacement"
              : `${extracts.length} extract${extracts.length === 1 ? "" : "s"}`
          }
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}
