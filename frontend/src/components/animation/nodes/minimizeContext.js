import { createContext } from "react";

// Session-only "minimize card to header" state. AnimationCanvas provides it; the
// shared NodeFrame consumes it to render a minimize/restore button on every card
// (so node components need no changes). Default is a no-op so NodeFrame still works
// without a provider (e.g. in tests).
export const MinimizeContext = createContext({ minimized: new Set(), toggle: () => {} });
