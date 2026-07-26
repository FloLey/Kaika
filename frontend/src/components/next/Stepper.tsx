// Where you are in the flow, and where you may go — one always-visible control.
//
// It replaced three one-way buttons in three different places — "↩ edit split" inside
// the Studio's own header, "Final export ▸" beside it, and "↩ studio" in a header the
// export screen invented for itself — none of which showed the shape of the flow or
// which parts of it you had finished.
//
// Reachability is the honest part: export is refused until every segment carries a
// ★-final output, using the SAME predicate the export console computes for its
// checklist, so the stepper and the Generate button can't disagree about readiness.

import { finalOutputIdOf, rootCompositionOf } from "../../lib/compositions";
import type { CompositionPool, Segment } from "../../lib/types";

export type Stage = "upload" | "review" | "studio" | "export";

const STAGES: { key: Stage; label: string }[] = [
  { key: "upload", label: "upload" },
  { key: "review", label: "review" },
  { key: "studio", label: "studio" },
  { key: "export", label: "export" },
];

export interface StepperProps {
  current: Stage | null; // null on the projects list / a transient screen
  hasProject: boolean;
  segments: Segment[];
  compositions: CompositionPool;
  onGo: (stage: Stage) => void;
}

// Why a stage can't be entered yet, or null when it can.
export function blockedReason(
  stage: Stage,
  { hasProject, segments, compositions }: Omit<StepperProps, "current" | "onGo">
): string | null {
  if (stage === "upload") return hasProject ? "this project already has its audio" : null;
  if (!hasProject) return "open a project first";
  if (stage === "review" || stage === "studio") {
    return segments.length ? null : "no segments yet";
  }
  // export — the same readiness ExportStep's checklist computes.
  if (!segments.length) return "no segments yet";
  const n = segments.filter((s) => !finalOutputIdOf(rootCompositionOf(s, compositions))).length;
  if (!n) return null;
  return n === 1
    ? "1 segment still needs a final output"
    : `${n} segments still need a final output`;
}

export default function Stepper({
  current,
  hasProject,
  segments,
  compositions,
  onGo,
}: StepperProps) {
  const currentIdx = current ? STAGES.findIndex((s) => s.key === current) : -1;
  return (
    <nav className="stepper" aria-label="workflow">
      {STAGES.map((s, i) => {
        const blocked = blockedReason(s.key, { hasProject, segments, compositions });
        const isCurrent = s.key === current;
        // "done" is positional, not a claim about quality — you got past it.
        const done = currentIdx >= 0 && i < currentIdx;
        return (
          <button
            key={s.key}
            className={
              "stepper-step" +
              (isCurrent ? " on" : "") +
              (done ? " done" : "") +
              (blocked ? " blocked" : "")
            }
            disabled={!!blocked || isCurrent}
            aria-current={isCurrent ? "step" : undefined}
            title={blocked || `go to ${s.label}`}
            onClick={() => onGo(s.key)}
          >
            <span className="stepper-num">{done ? "✓" : i + 1}</span>
            <span className="stepper-label">{s.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
