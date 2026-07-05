// The signal card's curve state: the extracted 0–1 curve for the current
// band/segment/shaping, re-extracted (debounced 220ms) whenever any of those
// change. The cleanup cancels a pending (not-yet-fired) extraction, so rapid
// edits coalesce into one request; `loading` stays true across the debounce.

import { useEffect, useState } from "react";
import { extractSignal } from "../../lib/api";
import type { Signal } from "../../lib/types";

const FPS = 30;

export function useSignalCurve(
  signal: Signal,
  jobId: string | undefined,
  segStart: number,
  segEnd: number,
  winLen: number
) {
  const [curve, setCurve] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);

  // Debounced re-extraction of the curve.
  useEffect(() => {
    if (!jobId || winLen <= 0.001) return;
    setLoading(true);
    const t = setTimeout(() => {
      extractSignal({
        job_id: jobId,
        stem: signal.stemKey,
        start: segStart,
        end: segEnd,
        minHz: signal.minHz,
        maxHz: signal.maxHz,
        feature: signal.feature,
        fps: FPS,
        attack: signal.attack,
        release: signal.release,
        invert: signal.invert,
        gamma: signal.gamma,
        gain: signal.gain,
        offset: signal.offset,
        threshold: signal.threshold,
      })
        .then((d: { curve?: number[] }) => {
          setCurve(d.curve || []);
          setLoading(false);
        })
        .catch(() => {
          setCurve([]);
          setLoading(false);
        });
    }, 220);
    return () => clearTimeout(t);
    // Deliberately keyed on the individual fields (not the `signal` object) so an
    // unrelated edit — e.g. renaming the signal — doesn't trigger a re-extraction.
  }, [
    jobId,
    signal.stemKey,
    signal.minHz,
    signal.maxHz,
    signal.feature,
    signal.attack,
    signal.release,
    signal.invert,
    signal.gamma,
    signal.gain,
    signal.offset,
    signal.threshold,
    segStart,
    segEnd,
    winLen,
  ]);

  return { curve, loading };
}
