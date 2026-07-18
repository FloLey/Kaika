import { makeGenSourceNode } from "./GenSourceNode";
import { RAIN_PARAMS } from "../../../lib/nodeParams";

// Rain: drops on a liquid surface — real wave-equation rings that collide and
// interfere, refracting the layer wired into `video` (the liquid's floor). A points
// card in `positions` turns uniform rain into fixed drip points. Wire `energy` to
// `density` and the storm follows the track.
export default makeGenSourceNode({
  type: "rain",
  title: "rain",
  accent: "var(--courant)",
  params: RAIN_PARAMS,
  palettes: ["downpour", "silver", "neon", "monsoon"],
  videoIn: "optional video in — the liquid's floor the rings refract (palette when empty)",
  positionsIn: "wire a points card here: drops fall on those spots instead of everywhere",
});
