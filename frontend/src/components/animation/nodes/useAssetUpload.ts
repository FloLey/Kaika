import { useState } from "react";
import type { ChangeEvent } from "react";
import { uploadAsset, assetFromYoutube, pollJob } from "../../../lib/api";
import type { Asset } from "../../../lib/types";
import type { NodeCtx } from "./nodeProps";

// `ctx.job` may be a bare id string or a project-ish record — normalise to the id.
export function jobIdOf(job: unknown): string | undefined {
  if (typeof job === "string") return job;
  const r = job as { job_id?: string; jobId?: string } | undefined;
  return r?.job_id || r?.jobId;
}

// Shared upload flow for the Image/Video layer cards (they only differ in the preview
// markup + accept filter). Extracts the project job id from `ctx`, POSTs a picked file
// to /upload-asset/<job> (api.uploadAsset), and hands the served URL to `onUrl`. The Video
// card also imports from YouTube (async job → asset). Returns the busy/error state, an
// `onChange` for a hidden <input type="file">, `fromYoutube`, and the resolved job id.
export function useAssetUpload(ctx: NodeCtx | undefined, onUrl: (url: string) => void) {
  const jobId = jobIdOf(ctx?.job);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same file be re-picked later
    if (!file) return;
    if (!jobId) {
      setErr("no project to upload to");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await uploadAsset(jobId, file);
      onUrl(res.url);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "upload failed");
    } finally {
      setBusy(false);
    }
  };

  const fromYoutube = async (url: string, start?: string, end?: string) => {
    if (!url.trim()) return;
    if (!jobId) {
      setErr("no project to import to");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const { job_id } = await assetFromYoutube(jobId, url.trim(), start?.trim(), end?.trim());
      const asset = await pollJob<Asset>(job_id);
      onUrl(asset.url);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "youtube import failed");
    } finally {
      setBusy(false);
    }
  };

  return { busy, err, onFile, fromYoutube, jobId };
}

// The uploaded asset's display name (basename of the served URL).
export const assetName = (url: string) => url.split("/").pop() || url;
