import { videoClipSrc } from "../../../lib/assetPreview";
import { feedsMontage } from "../../../lib/graphModel";
import type { NodeCtx } from "./nodeProps";
import type { BoxImagePreview, BoxVideoPreview } from "./BoxPad";
import type { ImageData, VideoData } from "../../../lib/types";

// The BoxPad content-preview objects, built from a card's data (+ transport ctx for
// video). Shared by the on-canvas cards AND the settings window's SettingsVisual, so the
// box preview is identical in both places.

// A const speed previews at that rate; a wired (modulated) speed previews at 1× (its
// per-frame curve isn't resolved in the card — the render is authoritative).
export function buildVideoPreview(
  d: VideoData,
  ctx?: NodeCtx,
  nodeId?: string
): BoxVideoPreview | undefined {
  if (!d.assetUrl) return undefined;
  const speedBinding = d.ports?.speed?.binding;
  const speed = speedBinding?.kind === "const" ? Number(speedBinding.value) : 1;
  // A montage input has NO song clock: the montage restarts it at its in-point on
  // each cut, and the card can't know where its slot falls. Preview it free-running
  // from the in-point (looping) rather than parked at the song position — which, on
  // a clip shorter than the segment's offset, showed a frozen last frame.
  const inMontage = !!nodeId && feedsMontage(ctx?.graph, nodeId);
  if (inMontage) {
    return {
      // Just the seconds the montage plays, cut server-side — and the file already
      // starts at the in-point, so `start` is 0 here (offsetting again would skip).
      src: videoClipSrc(d.assetUrl, d.start),
      fit: d.fit,
      sync: "segment",
      start: 0,
      speed,
      loop: true,
      segStart: ctx?.segStart ?? 0,
      crop: { x: d.crop_x ?? 0, y: d.crop_y ?? 0, w: d.crop_w ?? 1, h: d.crop_h ?? 1 },
      clock: ctx?.groupClock,
      playing: false, // free-run: the montage owns this clip's timing, not the transport
    };
  }
  return {
    // The lightweight preview copy — never the raw 4K asset (see lib/assetPreview).
    src: videoClipSrc(d.assetUrl, d.start),
    fit: d.fit,
    sync: d.sync,
    start: d.start,
    speed,
    loop: d.loop,
    segStart: ctx?.segStart ?? 0,
    crop: { x: d.crop_x ?? 0, y: d.crop_y ?? 0, w: d.crop_w ?? 1, h: d.crop_h ?? 1 },
    clock: ctx?.groupClock,
    playing: !!ctx?.groupPlaying,
  };
}

export function buildImagePreview(d: ImageData): BoxImagePreview | undefined {
  return d.assetUrl ? { src: d.assetUrl, fit: d.fit } : undefined;
}

// The COMPACT card's clip preview: the same excerpt, free-running in a loop. A compact
// body is a thumbnail — it needs to look alive, not to be frame-accurate with the
// transport, and it must never stream a whole source file (a canvas of 20 clips did
// exactly that, re-requesting each one continuously).
export function buildCompactVideoPreview(d: VideoData): BoxVideoPreview | undefined {
  if (!d.assetUrl) return undefined;
  return {
    src: videoClipSrc(d.assetUrl, d.start),
    fit: d.fit,
    sync: "segment",
    start: 0,
    speed: 1,
    loop: true,
    segStart: 0,
    crop: { x: d.crop_x ?? 0, y: d.crop_y ?? 0, w: d.crop_w ?? 1, h: d.crop_h ?? 1 },
    clock: undefined,
    playing: false,
  };
}
