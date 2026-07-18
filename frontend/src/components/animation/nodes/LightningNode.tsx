import { makeGenSourceNode } from "./GenSourceNode";
import { LIGHTNING_PARAMS } from "../../../lib/nodeParams";

// Lightning: dielectric-breakdown bolts that tear from (origin x, origin y) toward
// `direction`, restrike the same channel (the real flicker) and light the sky around
// the origin. A points card in `positions` strikes from a different point each time.
// Wire `onset` to `strike` and each drum hit fires a bolt.
export default makeGenSourceNode({
  type: "lightning",
  title: "lightning",
  accent: "var(--electric, #7aa2ff)",
  params: LIGHTNING_PARAMS,
  palettes: ["electric", "violet", "white-hot", "ember"],
  positionsIn: "wire a points card here: each strike picks one of the points as its origin",
});
