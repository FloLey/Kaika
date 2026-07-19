import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ARG_HELP, argHelp } from "../lib/paramHelp";
import { NODE_PARAMS } from "../lib/nodeParams";
import Docs, { DOC_SECTION_IDS } from "../components/Docs";
import renderAnimNode from "../components/animation/renderAnimNode";
import { paletteSpecs } from "../components/animation/nodes/registry";
import type { NodeCtx, NodeHelpers } from "../components/animation/nodes/nodeProps";

// How many "?" badges each palette card renders in its DEFAULT factory state (badges on
// controls hidden by the default mode — e.g. lfo `duty`, pattern `seed` — aren't counted).
// This asserts the help is actually WIRED into the card, not merely present in the
// catalog: a control that renders bare (with no "?" badge) drops the count and fails
// here. Update a number only when you intend the card's controls to change.
const EXPECTED_BADGES: Record<string, number> = {
  fluid: 7, // enabled/radial/wrap + source ports (medium group collapsed by default)
  points: 0,
  combine: 5, // mode + 4 medium (merge is the default mode)
  montage: 5, // inputs (slot summary) + threshold + hysteresis + opacity/trigger ports
  output: 1, // the HD-render button's "?" (the video in/out ports use title tooltips)
  color: 3, // mode + intensity/opacity (swatch default; rgb rows hidden)
  math: 1, // op (mix hidden unless op==="mix")
  lfo: 4, // shape/rateMode/rate/phase (duty hidden unless square)
  noise: 3,
  shaper: 11,
  gate: 5, // threshold/hysteresis/minGap/divide/invert
  change: 4, // gain/attack/release/direction
  scope: 0,
  pattern: 6, // layout/count/radius/rotation/offsetX/offsetY (seed hidden unless scatter)
  "animate-points": 3, // mode/amount/rate (angle/length/taper are mode-specific)
  "merge-points": 0,
  lyrics: 8, // font + align/case/reveal + box (visual pad) + outline + outlineWidth + opacity port
  image: 3, // fit + box (visual pad) + opacity port
  slideshow: 6, // threshold + hysteresis + fit + box + opacity/trigger ports
  imagegen: 2, // seed + model (prompts use plain title tooltips)
  video: 7, // fit + sync + start + speed + loop + box + opacity port
  backdrop: 2, // colour swatch + opacity port
  waves: 12, // palette + color + video row + 9 ports (scale/steepness/depth/speed/direction/caustics/chroma/shine/opacity)
  lightning: 15, // palette + color + positions row + 12 ports (strike/origin_x/origin_y/direction/length/branchiness/thickness/glow/flicker/flash/afterglow/opacity)
  fire: 14, // palette + color + positions row + 11 ports (origin_x/origin_y/direction/intensity/width/cooling/turbulence/flicker/expansion/glow/opacity)
  aurora: 11, // palette + color + 9 ports (position_y/height/bands/sway/drift/shimmer/rays/brightness/opacity)
  rain: 11, // palette + color + video row + positions row + 7 ports (density/drop_size/ripple_speed/decay/distort/shine/opacity)
  clouds: 13, // palette + color + 11 ports (coverage/scale/softness/drift/direction/turbulence/light_angle/shading/silver/brightness/opacity)
  transform: 6, // mode + wrap + zoom/rotate/pan_x/pan_y ports (segments hidden unless kaleidoscope)
  extract: 1, // kind (video/out ports use plain title tooltips)
  stylize: 3, // model + inpaint + strength port (prompt + video/control ports use title tooltips)
  echo: 3, // mode + length/amount ports
  colorgrade: 4, // mode + map (thermal default) + intensity/shift ports (tint row: title tooltip)
};

const HELPERS = {
  portRef: () => () => {},
  startConnect: () => {},
  onTitlePointerDown: () => {},
} as unknown as NodeHelpers;

// The inline (non-port) arguments each card renders, keyed by their `data` field. Port
// arguments come from NODE_PARAMS and are checked separately. This is the contract: add a
// control to a card and you must list its key here (and give it help) or the test fails —
// which is exactly what stopped the old per-argument "?" from silently rotting.
const INLINE_ARGS: Record<string, string[]> = {
  fluid: ["enabled", "radial", "wrap"],
  color: ["mode"],
  colorgrade: ["mode", "map", "colorA", "colorB", "tint"],
  lyrics: ["font", "align", "case", "reveal", "box", "outline", "outlineWidth"],
  image: ["fit", "box"],
  video: ["fit", "sync", "start", "speed", "loop", "box"],
  backdrop: ["color"],
  waves: ["palette", "color"],
  lightning: ["palette", "color"],
  fire: ["palette", "color"],
  aurora: ["palette", "color"],
  rain: ["palette", "color"],
  clouds: ["palette", "color"],
  pattern: ["layout", "count", "radius", "rotation", "offsetX", "offsetY", "seed"],
  lfo: ["shape", "rateMode", "rate", "phase", "duty"],
  noise: ["rate", "octaves", "seed"],
  shaper: [
    "delay",
    "wrap",
    "invert",
    "attack",
    "release",
    "threshold",
    "gamma",
    "gain",
    "offset",
    "lo",
    "hi",
  ],
  "animate-points": ["mode", "amount", "rate", "angle", "count", "fade"],
  math: ["op", "mix"],
  change: ["gain", "attack", "release", "direction"],
  combine: ["mode", "dissipation", "velocity_dissipation", "viscosity", "vorticity"],
  montage: ["threshold", "hysteresis", "inputs"],
  imagegen: ["model"],
};

describe("per-argument help catalog", () => {
  it("every port param (NODE_PARAMS) has a help entry", () => {
    for (const [type, params] of Object.entries(NODE_PARAMS)) {
      for (const p of params) {
        expect(ARG_HELP[type]?.[p.key], `${type}.${p.key} is missing help text`).toBeTruthy();
      }
    }
  });

  it("every inline argument has a help entry", () => {
    for (const [type, keys] of Object.entries(INLINE_ARGS)) {
      for (const k of keys) {
        expect(ARG_HELP[type]?.[k], `${type}.${k} is missing help text`).toBeTruthy();
      }
    }
  });

  it("all help strings are non-empty", () => {
    for (const [type, m] of Object.entries(ARG_HELP)) {
      for (const [k, v] of Object.entries(m)) {
        expect(v.trim().length, `${type}.${k} help is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("every referenced guide section is a real doc anchor (a '?' can't point nowhere)", () => {
    const ids = new Set<string>(DOC_SECTION_IDS);
    for (const [type, m] of Object.entries(ARG_HELP)) {
      for (const k of Object.keys(m)) {
        // group only affects fluid's section, and both fluid subsections are in the set,
        // so the key alone is enough to check membership.
        const { section } = argHelp(type, k);
        expect(section, `${type}.${k} resolved no section`).toBeTruthy();
        expect(ids.has(section as string), `${type}.${k} → "${section}" is not a doc section`).toBe(
          true
        );
      }
    }
  });

  it("fluid params link to the right subsection by group", () => {
    expect(argHelp("fluid", "emit", "source").section).toBe("fluid-source");
    expect(argHelp("fluid", "vorticity", "medium").section).toBe("fluid-medium");
  });

  it("every palette card renders its expected '?' badges (help is wired, not just catalogued)", () => {
    for (const spec of paletteSpecs()) {
      const node = spec.factory!(0, 0);
      const ctx = {
        graph: { nodes: [node], edges: [] },
        signals: [],
        segment: { start: 0, end: 8 },
        onGraphChange: () => {},
      } as unknown as NodeCtx;
      const html = renderToStaticMarkup(renderAnimNode(node, HELPERS, ctx));
      const badges = (html.match(/role="note"/g) || []).length; // one per Info badge
      expect(badges, `${spec.type} rendered ${badges} '?' badges`).toBe(
        EXPECTED_BADGES[spec.type] ?? 0
      );
    }
  });

  it("DOC_SECTION_IDS matches the anchors actually rendered by the guide", () => {
    const html = renderToStaticMarkup(<Docs />);
    const rendered = new Set([...html.matchAll(/id="([a-z-]+)"/g)].map((m) => m[1]));
    for (const id of DOC_SECTION_IDS) {
      expect(rendered.has(id), `#${id} is declared in DOC_SECTION_IDS but not rendered`).toBe(true);
    }
    for (const id of rendered) {
      expect(
        new Set<string>(DOC_SECTION_IDS).has(id),
        `#${id} is rendered but missing from DOC_SECTION_IDS`
      ).toBe(true);
    }
  });
});
