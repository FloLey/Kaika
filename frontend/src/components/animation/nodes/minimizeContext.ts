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
}

export const MinimizeContext = createContext<MinimizeCtx>({
  minimized: new Set<string>(),
  toggle: () => {},
});
