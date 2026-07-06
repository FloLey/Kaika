import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { portalTarget } from "../../lib/portalTarget";
import type { ChangeEvent } from "react";
import { listAssets, uploadAsset, deleteAsset, assetFromYoutube, pollJob } from "../../lib/api";
import type { Asset } from "../../lib/types";

interface AssetLibraryProps {
  jobId?: string;
  kind?: "image" | "video"; // filter to one kind (picker mode); undefined = show all
  onPick?: (asset: Asset) => void; // present = picker mode (click selects); absent = manager
  onClose: () => void;
}

// The per-project asset library modal. In MANAGER mode (no `onPick`, opened from the
// Studio toolbar) it browses/uploads/deletes the project's `data.assets`. In PICKER mode
// (an Image/Video card passes `onPick` + its `kind`) a click returns the chosen asset.
// A YouTube URL row imports a video asset (async). Rendered through a portal to <body> so
// the fixed-position scrim isn't clipped by the pan/zoomed graph canvas it may open from.
export default function AssetLibrary({ jobId, kind, onPick, onClose }: AssetLibraryProps) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [yt, setYt] = useState("");
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

  const onImportYoutube = async () => {
    if (!yt.trim() || !jobId) return;
    setYtBusy(true);
    setErr(null);
    try {
      const { job_id } = await assetFromYoutube(jobId, yt.trim());
      await pollJob<Asset>(job_id);
      setYt("");
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
                accept={kind === "image" ? "image/*" : kind === "video" ? "video/*" : "image/*,video/*"}
                onChange={onFile}
                disabled={busy}
                hidden
              />
              {busy ? "uploading…" : "＋ upload"}
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
                <button className="btn sm" onClick={onImportYoutube} disabled={ytBusy || !yt.trim()}>
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
            <div className="asset-lib-grid">
              {shown.map((a) => (
                <div
                  key={a.id}
                  className={"asset-lib-item" + (onPick ? " pickable" : "")}
                  title={a.name}
                  onClick={onPick ? () => onPick(a) : undefined}
                >
                  <div className="asset-lib-thumb">
                    {a.kind === "video" ? (
                      <video src={a.url} muted loop playsInline preload="metadata" />
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
          )}
        </div>
      </div>
    </div>,
    portalTarget()
  );
}
