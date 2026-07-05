// Project-level FINAL EXPORT settings, edited in the export stage: the HD render
// size, fps, and simulation detail (grid cells — higher = crisper but slower).
// There is no background — un-dyed pixels are black; backdrops are layers. One
// object per project, persisted under `export`, sent when the full-track render runs.

import { withDefaults } from "./defaults";

export interface ExportSettings {
  width: number;
  height: number;
  fps: number;
  gridCells: number;
  // Which audio the final mp4 carries: the uploaded mix, or the vocals-removed
  // "instrumental" (drums+bass+other — the karaoke track for covers).
  audioMode: "original" | "instrumental";
}

export const EXPORT_DEFAULTS: ExportSettings = {
  width: 1080,
  height: 1920,
  fps: 30,
  gridCells: 216, // simulation short-side cells — higher = sharper + slower
  audioMode: "original",
};

// Fill any missing fields from defaults (stored export may be partial/empty).
export function withExportDefaults(o?: Partial<ExportSettings> | null): ExportSettings {
  return withDefaults(EXPORT_DEFAULTS, o);
}
