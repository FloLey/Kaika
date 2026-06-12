// The right-hand context panel: one surface that toggles between the
// assisted flow (creative suggestions + chat copilot) and manual tuning
// (the schema inspector). Assisted is the default.
import { ReactNode } from "react";

export type ContextMode = "assist" | "tune";

interface Props {
  mode: ContextMode;
  onMode: (m: ContextMode) => void;
  assist: ReactNode;       // SuggestionsPanel + ChatPanel
  tune: ReactNode;         // Inspector
}

export default function ContextPanel({ mode, onMode, assist, tune }: Props) {
  return (
    <div>
      <div className="context-toggle">
        <button className={mode === "assist" ? "active" : ""}
          onClick={() => onMode("assist")}>✨ Assistant</button>
        <button className={mode === "tune" ? "active" : ""}
          onClick={() => onMode("tune")}>⚙ Réglages</button>
      </div>
      {mode === "assist"
        ? <div className="context-stack">{assist}</div>
        : tune}
    </div>
  );
}
