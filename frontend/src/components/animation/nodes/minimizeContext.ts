import { createContext } from "react";

// The compact-view state. AnimationCanvas provides it; the shared NodeFrame consumes
// it. `minimized` is the set of cards rendered compact (every non-output card, now
// that the detailed view is gone) — NodeFrame reads it only to know a card is in the
// compact set; there is no longer a per-card toggle. Default is a no-op so NodeFrame
// still works without a provider (e.g. in tests).
export interface MinimizeCtx {
  minimized: Set<string>;
  // Rename a card (node-level `name`). NodeFrame's title is double-click-editable and
  // saves through this, so no per-card threading. Optional — a no-op default keeps
  // NodeFrame working without a provider (tests) and makes the title read-only there.
  rename?: (id: string, name: string) => void;
}

export const MinimizeContext = createContext<MinimizeCtx>({
  minimized: new Set<string>(),
});
