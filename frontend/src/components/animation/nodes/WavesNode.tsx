import { makeGenSourceNode } from "./GenSourceNode";
import { WAVES_PARAMS } from "../../../lib/nodeParams";

// Waves: pool water — a dispersion-correct wave spectrum whose caustics dance on the
// floor and REFRACT whatever is wired into `video` (an image, a clip, a fluid). Wire
// `energy` to `steepness` and the water chops with the music.
export default makeGenSourceNode({
  type: "waves",
  title: "waves",
  accent: "var(--courant)",
  params: WAVES_PARAMS,
  palettes: ["ocean", "tropical", "storm", "sunset"],
  videoIn: "optional video in — the pool floor the water refracts (palette when empty)",
});
