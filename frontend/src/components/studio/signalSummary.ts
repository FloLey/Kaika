// A signal, in one readable line.
//
// An expanded card shows ~19 interactive things at once and no summary of any of
// them, so four bands on `drums` is four identical-looking blocks you have to open
// and read slider by slider to tell apart. Everything here is DERIVED — no new
// fields, nothing to migrate.

import { FEATURES } from "./signalCatalog";
import { fmtHz } from "../../lib/mel";
import type { Signal } from "../../lib/types";

// beat/bar are tempo-locked phases: the frequency band has no effect on them.
export const bandIgnoredFor = (feature: string) => feature === "beat" || feature === "bar";

// The envelope in words. The thresholds are where the character actually changes,
// not even splits: an attack under 20 ms is percussive, over 300 ms is a swell.
export function shapeWords(s: Signal): string[] {
  const out: string[] = [];
  if (s.attack <= 20) out.push("snappy");
  else if (s.attack >= 300) out.push("slow swell");
  if (s.release >= 800) out.push("long tail");
  else if (s.release <= 80) out.push("tight");
  if (s.gamma >= 1.8) out.push("peaks only");
  else if (s.gamma <= 0.6) out.push("lifted");
  if (s.threshold > 0) out.push(`gated ${s.threshold.toFixed(2)}`);
  if (s.gain !== 1) out.push(`×${s.gain.toFixed(2)}`);
  if (s.offset !== 0) out.push(`${s.offset > 0 ? "+" : ""}${s.offset.toFixed(2)}`);
  if (s.invert) out.push("inverted");
  return out;
}

// "bass · 40–120 Hz · energy · snappy, long tail"
export function summariseSignal(s: Signal): string {
  const feature = FEATURES.find((f) => f.key === s.feature)?.label || s.feature;
  const band = bandIgnoredFor(s.feature) ? "whole track" : `${fmtHz(s.minHz)}–${fmtHz(s.maxHz)}`;
  const words = shapeWords(s);
  return [s.stemKey, band, feature, words.join(", ")].filter(Boolean).join(" · ");
}
