import { makeGenSourceNode } from "./GenSourceNode";
import { FIRE_PARAMS } from "../../../lib/nodeParams";

// Fire: real buoyant combustion on the fluid solver — place it anywhere with
// origin x/y, aim it with `direction`, size it with `width`/`cooling`. A points card
// in `positions` lights one flame per point; flames close together lean into each
// other and MERGE, like real fires. Wire `energy` to `intensity` for a breathing blaze.
export default makeGenSourceNode({
  type: "fire",
  title: "fire",
  accent: "var(--ember, #ff7a3c)",
  params: FIRE_PARAMS,
  palettes: ["flame", "blue-fire", "green-fire", "ghost"],
  positionsIn: "wire a points card here: one flame per point (they merge when close)",
});
