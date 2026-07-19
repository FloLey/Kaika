import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { portalTarget } from "../../lib/portalTarget";
import type { ChangeEvent } from "react";
import { listAssets, uploadAsset, deleteAsset, assetFromYoutube, pollJob } from "../../lib/api";
import { videoThumbSrc } from "../../lib/assetPreview";
import type { Asset } from "../../lib/types";

interface AssetLibraryProps {
  jobId?: string;
  kind?: "image" | "video"; // filter to one kind (picker mode); undefined = show all
  onPick?: (asset: Asset) => void; // present = a click selects; absent = browse only
  // Set by the manager (Studio): the modal STAYS OPEN after a pick, and this line says
  // what happened. Picking twenty clips for a montage is twenty clicks, not twenty
  // open-pick-reopen rounds.
  pickLabel?: string;
  onClose: () => void;
}

// Mirror of backend `paths.ASSET_EXTS` — a folder upload filters to these client-side
// (everything else in the folder — .DS_Store, sidecars, raw files — is skipped quietly).
const FOLDER_EXTS: Record<string, "image" | "video"> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  mp4: "video",
  mov: "video",
  webm: "video",
  m4v: "video",
};
const extKind = (name: string): "image" | "video" | null =>
  FOLDER_EXTS[name.split(".").pop()?.toLowerCase() || ""] ?? null;

// Group a (possibly kind-filtered) asset list by `folder` for display: loose assets
// (no folder) first, then each folder's assets under its path, folders sorted. WITHIN
// a folder, items sort by NAME (numeric-aware) — phone clips encode their shot time
// in the filename (PXL_20260503_2036…), so name order IS chronological order; the
// library's raw insertion order scrambles on a deduping re-upload (re-registering an
// existing file moves it to the end of `data.assets`). Loose assets keep insertion
// order (upload history), as before folders existed.
export function groupByFolder(assets: Asset[]): { folder: string; items: Asset[] }[] {
  const groups = new Map<string, Asset[]>();
  for (const a of assets) {
    const key = a.folder || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }
  const folders = [...groups.keys()].filter(Boolean).sort((x, y) => x.localeCompare(y));
  const out: { folder: string; items: Asset[] }[] = [];
  if (groups.has("")) out.push({ folder: "", items: groups.get("")! });
  const byName = (x: Asset, y: Asset) =>
    (x.name || "").localeCompare(y.name || "", undefined, { numeric: true });
  for (const f of folders) out.push({ folder: f, items: [...groups.get(f)!].sort(byName) });
  return out;
}

// The thumb <img> with a placeholder fallback while the backfill hasn't produced the
// file yet (or ffmpeg couldn't) — never a live <video>.
function VideoThumb({ a }: { a: Asset }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <div className="asset-lib-thumb-fallback">🎞</div>;
  return (
    <img
      src={videoThumbSrc(a.url)}
      alt={a.name}
      draggable={false}
      onError={() => setBroken(true)}
    />
  );
}

// The per-project asset library modal. In MANAGER mode (no `onPick`, opened from the
// Studio toolbar) it browses/uploads/deletes the project's `data.assets`. In PICKER mode
// (an Image/Video card passes `onPick` + its `kind`) a click returns the chosen asset.
// A YouTube URL row imports a video asset (async); a 📁 folder upload imports every
// image/video inside a picked folder, keeping its structure as per-asset `folder`
// metadata the grid groups by. Rendered through a portal to <body> so the fixed-position
// scrim isn't clipped by the pan/zoomed graph canvas it may open from.
export default function AssetLibrary({
  jobId,
  kind,
  onPick,
  pickLabel,
  onClose,
}: AssetLibraryProps) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [yt, setYt] = useState("");
  const [ytStart, setYtStart] = useState("");
  const [ytEnd, setYtEnd] = useState("");
  const [ytBusy, setYtBusy] = useState(false);
  const closedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!jobId) return;
    try {
      const list = await listAssets(jobId);
      if (!closedRef.current) setAssets(list);
    } catch (ex) {
      if (!closedRef.current) setErr(ex instanceof Error ? ex.message : "could not load assets");
    }
  }, [jobId]);

  useEffect(() => {
    refresh();
    return () => {
      closedRef.current = true;
    };
  }, [refresh]);

  // ESC closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = kind ? assets.filter((a) => a.kind === kind) : assets;

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !jobId) return;
    setBusy(true);
    setErr(null);
    try {
      await uploadAsset(jobId, file);
      await refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "upload failed");
    } finally {
      setBusy(false);
    }
  };

  // Folder upload: every image/video under the picked folder, one upload per file, its
  // relative directory (webkitRelativePath minus the filename) kept as `folder`. Files
  // upload sequentially — a month of phone clips would flood the server in parallel —
  // with a k/n progress readout; failures are counted, not fatal (the rest still land).
  const onFolder = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length || !jobId) return;
    const wanted = files.filter((f) => {
      const k = extKind(f.name);
      return k !== null && (!kind || k === kind) && !f.name.startsWith(".");
    });
    if (!wanted.length) {
      setErr("no images or videos found in that folder");
      return;
    }
    setBusy(true);
    setErr(null);
    setProgress({ done: 0, total: wanted.length });
    let failed = 0;
    let lastErr = "";
    for (const f of wanted) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      const folder = rel.split("/").slice(0, -1).join("/");
      try {
        await uploadAsset(jobId, f, folder);
      } catch (ex) {
        failed += 1;
        lastErr = ex instanceof Error ? ex.message : "upload failed";
      }
      if (closedRef.current) return; // modal closed mid-batch — stop quietly
      setProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
    }
    if (failed) setErr(`${failed} of ${wanted.length} files failed — ${lastErr}`);
    setProgress(null);
    setBusy(false);
    await refresh();
  };

  const onImportYoutube = async () => {
    if (!yt.trim() || !jobId) return;
    setYtBusy(true);
    setErr(null);
    try {
      const { job_id } = await assetFromYoutube(jobId, yt.trim(), ytStart.trim(), ytEnd.trim());
      await pollJob<Asset>(job_id);
      setYt("");
      setYtStart("");
      setYtEnd("");
      await refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "youtube import failed");
    } finally {
      setYtBusy(false);
    }
  };

  const onRemove = async (a: Asset) => {
    if (!jobId) return;
    setErr(null);
    try {
      await deleteAsset(jobId, a.id);
      await refresh();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "delete failed");
    }
  };

  return createPortal(
    <div className="anim-modal-scrim" onPointerDown={onClose}>
      <div
        className="anim-modal asset-lib"
        role="dialog"
        aria-label="Asset library"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="anim-modal-head">
          <span className="anim-modal-title">
            ASSET LIBRARY{kind ? ` · ${kind}s` : ""}
            {onPick && !kind && (
              <span className="asset-lib-hint">
                {pickLabel || "click a clip to drop its card on the canvas"}
              </span>
            )}
          </span>
          <button className="iconbtn" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="anim-modal-body">
          <div className="asset-lib-actions">
            <label className={"btn sm" + (busy ? " on" : "")}>
              <input
                type="file"
                accept={
                  kind === "image" ? "image/*" : kind === "video" ? "video/*" : "image/*,video/*"
                }
                onChange={onFile}
                disabled={busy}
                hidden
              />
              {busy && !progress ? "uploading…" : "＋ upload"}
            </label>
            <label
              className={"btn sm" + (busy ? " on" : "")}
              title="Upload every image/video inside a folder — its structure is kept"
            >
              {/* webkitdirectory isn't in React's input typing; the spread smuggles it. */}
              <input
                type="file"
                multiple
                onChange={onFolder}
                disabled={busy}
                hidden
                {...({ webkitdirectory: "" } as Record<string, string>)}
              />
              {progress ? `${progress.done}/${progress.total}…` : "📁 upload folder"}
            </label>
            {kind !== "image" && (
              <div className="asset-lib-yt">
                <input
                  type="text"
                  className="hz-input"
                  placeholder="YouTube URL → video"
                  value={yt}
                  onChange={(e) => setYt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onImportYoutube();
                  }}
                  disabled={ytBusy}
                />
                {yt.trim() && (
                  <>
                    <input
                      type="text"
                      className="hz-input asset-lib-yt-ts"
                      placeholder="0:00"
                      title="Optional start — only this section of the video is downloaded"
                      value={ytStart}
                      onChange={(e) => setYtStart(e.target.value)}
                      disabled={ytBusy}
                    />
                    <input
                      type="text"
                      className="hz-input asset-lib-yt-ts"
                      placeholder="end"
                      title="Optional end — only this section of the video is downloaded"
                      value={ytEnd}
                      onChange={(e) => setYtEnd(e.target.value)}
                      disabled={ytBusy}
                    />
                  </>
                )}
                <button
                  className="btn sm"
                  onClick={onImportYoutube}
                  disabled={ytBusy || !yt.trim()}
                >
                  {ytBusy ? "importing…" : "import"}
                </button>
              </div>
            )}
          </div>

          {err && <div className="anim-asset-err">{err}</div>}

          {shown.length === 0 ? (
            <div className="asset-lib-empty">
              {jobId ? "no assets yet — upload one above" : "no project"}
            </div>
          ) : (
            groupByFolder(shown).map(({ folder, items }) => (
              <div key={folder || "·root·"}>
                {folder && <div className="asset-lib-folder">📁 {folder}</div>}
                <div className="asset-lib-grid">
                  {items.map((a) => (
                    <div
                      key={a.id}
                      className={"asset-lib-item" + (onPick ? " pickable" : "")}
                      title={folder ? `${folder}/${a.name}` : a.name}
                      onClick={onPick ? () => onPick(a) : undefined}
                    >
                      <div className="asset-lib-thumb">
                        {a.kind === "video" ? (
                          <VideoThumb a={a} />
                        ) : (
                          <img src={a.url} alt={a.name} draggable={false} />
                        )}
                        <span className="asset-lib-kind">{a.kind === "video" ? "🎞" : "🖼"}</span>
                      </div>
                      <span className="asset-lib-name">{a.name}</span>
                      <button
                        className="asset-lib-del iconbtn"
                        title="Delete asset"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemove(a);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    portalTarget()
  );
}
