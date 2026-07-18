import { makeGenSourceNode } from "./GenSourceNode";
import { CLOUDS_PARAMS } from "../../../lib/nodeParams";

// Clouds: sunlit cumulus — a Beer-Lambert march toward `light angle` self-shadows the
// masses, thin rims blaze silver around the sun. Wire `energy` to `brightness` and
// `flux` to `turbulence`. A dreamy sky or a nebula depending on the palette.
export default makeGenSourceNode({
  type: "clouds",
  title: "clouds",
  accent: "var(--nebula, #a06fe0)",
  params: CLOUDS_PARAMS,
  palettes: ["sky", "nebula", "ink", "dust"],
});
