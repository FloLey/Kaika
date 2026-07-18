import { makeGenSourceNode } from "./GenSourceNode";
import { AURORA_PARAMS } from "../../../lib/nodeParams";

// Aurora: calm curtains built like the real thing — horizontal arcs with vertical
// rays whose intensities breathe on the ~1 s oxygen-line timescale, colours
// stratified by altitude. Wire `harmonic` to `brightness` and the sky breathes.
export default makeGenSourceNode({
  type: "aurora",
  title: "aurora",
  accent: "var(--aurora, #4fe0a0)",
  params: AURORA_PARAMS,
  palettes: ["aurora", "solar", "ice", "spectrum"],
});
