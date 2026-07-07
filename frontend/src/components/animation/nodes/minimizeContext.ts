import { createContext } from "react";

// The compact-view state. AnimationCanvas provides it; the shared NodeFrame consumes
// it to render the per-card ▢/– override button (so node components need no changes).
// `minimized` is the DERIVED compact set (mode + overrides already applied);
// `mode` is the canvas view mode, so the button can word its tooltip. Default is a
// no-op so NodeFrame still works without a provider (e.g. in tests).
export interface MinimizeCtx {
  minimized: Set<string>;
  toggle: (id: string) => void;
  mode?: "detailed" | "compact";
  // Rename a card (node-level `name`). NodeFrame's title is double-click-editable and
  // saves through this, so no per-card threading. Optional — a no-op default keeps
  // NodeFrame working without a provider (tests) and makes the title read-only there.
  rename?: (id: string, name: string) => void;
}

export const MinimizeContext = createContext<MinimizeCtx>({
  minimized: new Set<string>(),
  toggle: () => {},
});
