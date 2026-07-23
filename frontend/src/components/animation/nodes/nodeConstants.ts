// Small shared constants/formatters for the node cards, hoisted here so each card
// doesn't re-declare its own copy.

import type { LayerFit } from "../../../lib/types";

// How an image/video asset scales into its placement box (Image + Video cards).
export const FITS: LayerFit[] = ["cover", "contain", "stretch"];

// The standard two-decimal readout for 0..1-ish sliders.
export const dp2 = (v: number) => v.toFixed(2);
export const pct = (v: number) => `${Math.round(v * 100)}%`;
