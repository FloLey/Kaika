import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ARG_HELP, argHelp } from "../lib/paramHelp";
import { NODE_PARAMS } from "../lib/nodeParams";
import Docs, { DOC_SECTION_IDS } from "../components/Docs";
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
  montage: 5, // extracts (strip summary) + threshold + hysteresis + opacity/trigger ports
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
  text: 10, // text + font + align/case + box + outline + outlineWidth + sizing + font-size (fixed is the default mode) + opacity port
  lyrics: 9, // font + align/case/reveal + box (visual pad) + outline + outlineWidth + sizing (auto mode: the per-mode sliders are hidden) + opacity port
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
  dream: 9, // model + seedMode + fadeShape + prompts (on the timeline legend)
  //          + control_scale/keep/trigger/reseed ports. The prompt textareas
  //          and their fade/span fields use plain title tooltips, as do the in-ports.
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
//
// EVERY palette type must appear, `[]` meaning "renders no inline controls, deliberately"
// — see `every palette card is accounted for` below. Eleven types were simply absent
// before, so their controls were never checked at all.
const INLINE_ARGS: Record<string, string[]> = {
  fluid: ["enabled", "radial", "wrap"],
  // Cards with no inline data controls. `points`/`scope`/`merge-points` are wiring-only;
  // `output`'s single badge belongs to the HD-render button, not a `data` field.
  points: [],
  scope: [],
  "merge-points": [],
  output: [],
  transform: ["mode", "segments", "wrap"],
  extract: ["kind"],
  stylize: ["model", "inpaint"], // prompt is a textarea with a plain title tooltip
  dream: ["model", "seedMode", "seed", "fadeShape", "prompts"], // the rows use title tooltips
  echo: ["mode"],
  gate: ["threshold", "hysteresis", "minGap", "divide", "invert"],
  slideshow: ["threshold", "hysteresis", "fit", "box"],
  color: ["mode"],
  colorgrade: ["mode", "map", "colorA", "colorB", "tint"],
  text: ["text", "font", "align", "case", "box", "outline", "outlineWidth", "sizing", "sizeFixed"],
  lyrics: [
    "font",
    "align",
    "case",
    "reveal",
    "box",
    "outline",
    "outlineWidth",
    "sizeMin",
    "sizeMax",
  ],
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
  montage: ["threshold", "hysteresis", "extracts"],
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

  // Without this, both maps were opt-IN: a brand-new card absent from EXPECTED_BADGES got
  // `?? 0` and passed while rendering no help at all, and one absent from INLINE_ARGS had
  // its controls checked by nobody. Now a new card has to be listed — opting out is a
  // deliberate `[]`/`0`, written down, rather than silence.
  it("every palette card is accounted for in both help tables", () => {
    const types = paletteSpecs().map((s) => s.type);
    const missingBadges = types.filter((t) => !(t in EXPECTED_BADGES));
    const missingInline = types.filter((t) => !(t in INLINE_ARGS));
    expect(missingBadges, "add these to EXPECTED_BADGES (0 is a valid, explicit answer)").toEqual(
      []
    );
    expect(missingInline, "add these to INLINE_ARGS ([] is a valid, explicit answer)").toEqual([]);
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
      // Render the FULL card directly — the surface the settings modal shows. On the
      // canvas every card is compact (a preview that opens the modal), so the '?' badges
      // live on `spec.Component`, which is exactly what this invariant is about.
      const Card = spec.Component;
      const html = renderToStaticMarkup(
        <Card
          node={node}
          ctx={ctx}
          helpers={HELPERS}
          selected={false}
          onGraphChange={() => {}}
          onDelete={() => {}}
        />
      );
      const badges = (html.match(/role="note"/g) || []).length; // one per Info badge
      // No `?? 0` fallback: an unlisted card is caught by the accounting test above, and
      // silently expecting zero is how a help-less card used to pass.
      expect(badges, `${spec.type} rendered ${badges} '?' badges`).toBe(EXPECTED_BADGES[spec.type]);
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
