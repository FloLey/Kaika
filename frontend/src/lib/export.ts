// Project-level FINAL EXPORT settings, edited in the export stage: the HD render
// size, fps, simulation detail (grid cells — higher = crisper but slower), and a
// solid background color. One object per project, persisted in the project blob
// under `export`, and sent when the final full-track render is generated.

export interface ExportSettings {
  width: number;
  height: number;
  fps: number;
  gridCells: number;
  background: string;
}

export const EXPORT_DEFAULTS: ExportSettings = {
  width: 1080,
  height: 1920,
  fps: 30,
  gridCells: 216, // simulation short-side cells — higher = sharper + slower
  background: "#000000",
};

// Fill any missing fields from defaults (stored export may be partial/empty).
export function withExportDefaults(o?: Partial<ExportSettings> | null): ExportSettings {
  return { ...EXPORT_DEFAULTS, ...(o || {}) };
}
