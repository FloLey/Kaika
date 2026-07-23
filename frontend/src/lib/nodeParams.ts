// The modulatable-param registry: per node type, the list of ports that can be a
// const value or a signal-driven [lo, hi]. ALL specs come from the GENERATED
// fluidParams.js (backend animation_params is the single source of truth — see
// gen_fluid_params + tests/test_fluid_params_codegen.py), so the UI ranges can
// never drift from what the render maps. This is the single place the wiring
// (graphModel connect/disconnect) and the port UI (ParamRow) look up a param's
// range/default/label — so a card's ports stay in lockstep everywhere.

import {
  FLUID_PARAMS,
  COLOR_PARAMS as GEN_COLOR_PARAMS,
  SOURCE_PARAMS as GEN_SOURCE_PARAMS,
} from "./fluidParams.js";
import type { FluidParam } from "./types";

// fluidParams.js is untyped JS; pin the shapes this registry hands out.
const SOURCE_PARAMS = GEN_SOURCE_PARAMS as Record<string, FluidParam[]>;

// The colour card's ports. r/g/b: a swatch (swatch mode) or individual modulatable
// rows (rgb mode); intensity/opacity always modulatable; position (0..1) scrubs the
// gradient in gradient mode.
export const COLOR_PARAMS = GEN_COLOR_PARAMS as FluidParam[];

// The source layer cards: box/fit (and video timing) are static data, so `opacity`
// is the only modulatable port — plus `speed` on video (the source advances by
// speed/fps each frame, so a wired signal time-warps the clip).
export const LYRICS_PARAMS: FluidParam[] = SOURCE_PARAMS.lyrics;
export const TEXT_PARAMS: FluidParam[] = SOURCE_PARAMS.text;
export const IMAGE_PARAMS: FluidParam[] = SOURCE_PARAMS.image;
export const SLIDESHOW_PARAMS: FluidParam[] = SOURCE_PARAMS.slideshow;
export const VIDEO_PARAMS: FluidParam[] = SOURCE_PARAMS.video;
// The montage switcher (N wired video slots): `trigger` cuts to the next slot on
// each rising edge past the card's built-in hysteresis threshold.
export const MONTAGE_PARAMS: FluidParam[] = SOURCE_PARAMS.montage;
export const BACKDROP_PARAMS: FluidParam[] = SOURCE_PARAMS.backdrop;
// Generative source cards: behavioural ports only — colour is a static `palette`
// preset + an optional wired `color` card override (both static data, not ports).
export const WAVES_PARAMS: FluidParam[] = SOURCE_PARAMS.waves;
export const LIGHTNING_PARAMS: FluidParam[] = SOURCE_PARAMS.lightning;
export const FIRE_PARAMS: FluidParam[] = SOURCE_PARAMS.fire;
export const AURORA_PARAMS: FluidParam[] = SOURCE_PARAMS.aurora;
export const RAIN_PARAMS: FluidParam[] = SOURCE_PARAMS.rain;
export const CLOUDS_PARAMS: FluidParam[] = SOURCE_PARAMS.clouds;
// The transform FX card (video -> video): zoom/rotate/pan warp the incoming frames.
export const TRANSFORM_PARAMS: FluidParam[] = SOURCE_PARAMS.transform;
// The AI Stylize FX card: `strength` = the img2img denoise curseur.
export const STYLIZE_PARAMS: FluidParam[] = SOURCE_PARAMS.stylize;
// The Echo look-FX card: motion trails — `length` (half-life, s) + `amount` (mix).
export const ECHO_PARAMS: FluidParam[] = SOURCE_PARAMS.echo;
// The Color Grade look-FX card: `intensity` (dry↔graded) + `shift` (LUT/midpoint/hue).
export const COLORGRADE_PARAMS: FluidParam[] = SOURCE_PARAMS.colorgrade;

// node type -> its modulatable param specs. Cards with no entry have no ports.
export const NODE_PARAMS: Record<string, FluidParam[]> = {
  fluid: FLUID_PARAMS as FluidParam[],
  color: COLOR_PARAMS,
  lyrics: LYRICS_PARAMS,
  text: TEXT_PARAMS,
  image: IMAGE_PARAMS,
  slideshow: SLIDESHOW_PARAMS,
  video: VIDEO_PARAMS,
  montage: MONTAGE_PARAMS,
  backdrop: BACKDROP_PARAMS,
  waves: WAVES_PARAMS,
  lightning: LIGHTNING_PARAMS,
  fire: FIRE_PARAMS,
  aurora: AURORA_PARAMS,
  rain: RAIN_PARAMS,
  clouds: CLOUDS_PARAMS,
  transform: TRANSFORM_PARAMS,
  stylize: STYLIZE_PARAMS,
  echo: ECHO_PARAMS,
  colorgrade: COLORGRADE_PARAMS,
};

export const nodeParams = (type: string): FluidParam[] => NODE_PARAMS[type] || [];
export const nodeParam = (type: string, key: string): FluidParam | undefined =>
  nodeParams(type).find((p) => p.key === key);
