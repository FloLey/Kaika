// Project-level OUTPUT (render) settings, shared across the animation editor:
// video size + orientation, render quality (sim resolution), fps, and a solid
// background color. One object per project, edited in the settings modal,
// persisted in the project blob, and sent on every /animate render.

export const OUTPUT_DEFAULTS = {
  width: 1080,
  height: 1920,
  quality: "normal",   // "draft" | "normal" | "high" -> short-side sim cells
  fps: 24,
  background: "#000000",
};

// Orientation presets at standard social resolutions. Custom W×H is also allowed.
export const ORIENTATION_PRESETS = [
  { key: "portrait", label: "Portrait", ratio: "9:16", width: 1080, height: 1920 },
  { key: "landscape", label: "Landscape", ratio: "16:9", width: 1920, height: 1080 },
  { key: "square", label: "Square", ratio: "1:1", width: 1080, height: 1080 },
];

export const QUALITY_PRESETS = [
  { key: "draft", label: "Draft", hint: "fast" },
  { key: "normal", label: "Normal", hint: "default" },
  { key: "high", label: "High", hint: "sharp" },
];

export const FPS_OPTIONS = [24, 30, 60];

// Fill any missing fields from defaults (stored output may be partial/empty).
export function withOutputDefaults(o) {
  return { ...OUTPUT_DEFAULTS, ...(o || {}) };
}

// The orientation preset key matching the current size, or "custom".
export function presetFor(o) {
  const p = ORIENTATION_PRESETS.find((x) => x.width === o.width && x.height === o.height);
  return p ? p.key : "custom";
}

// CSS aspect-ratio value ("w / h") for sizing previews to the chosen shape.
export const aspectOf = (o) => `${o.width} / ${o.height}`;
