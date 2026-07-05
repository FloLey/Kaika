// The per-ARGUMENT help catalog: one short sentence per control on every animation
// card, plus which guide section its "?" links to. This is the single source of truth
// the cards read (via `argHelp`) so the hover text + doc deep-links stay complete and
// in one reviewable place. A test (paramHelp.test.ts) asserts every rendered argument
// has an entry here and that every referenced section exists in Docs — so it can't
// silently rot the way the old per-card help did.
//
// Keys are the node `data`/port field names (NOT the display label, which can change,
// e.g. animate-points "rate"→"speed"). Sections are ids in components/Docs.tsx.

// nodeType -> (fieldKey -> one-line help).
export const ARG_HELP: Record<string, Record<string, string>> = {
  fluid: {
    emit: "How much dye each source releases per frame — higher = denser, brighter streams.",
    radius: "Size of the emitter blob at each source point.",
    force: "How hard the source pushes the fluid — higher = faster, more turbulent motion.",
    angle: "Direction the source pushes, in degrees (0 = right, 90 = down).",
    dissipation: "How fast the dye fades. Lower = trails vanish quickly; higher = they linger.",
    velocity_dissipation: "How fast the motion settles. Lower = quick calm; higher = keeps swirling.",
    viscosity: "Thickness of the fluid — higher smears neighbouring motion together (syrupy).",
    vorticity: "Adds swirl and curl back into the fluid — higher = more eddies and detail.",
    enabled: "Turn this fluid's dye emission on or off.",
    radial: "Push dye outward from the centre instead of along a fixed heading.",
    wrap: "On: dye leaving one edge re-enters the opposite (a looping torus). Off: it's gone for good.",
  },
  color: {
    mode: "swatch = one solid colour; rgb = drive r/g/b with signals; gradient = scrub along stops.",
    r: "Red channel of the dye colour.",
    g: "Green channel of the dye colour.",
    b: "Blue channel of the dye colour.",
    intensity: "Overall brightness multiplier of the colour.",
    opacity: "How opaque the dye is over the background.",
    position: "Where along the gradient to sample (0 = first stop, 1 = last) — modulate to sweep it.",
  },
  lyrics: {
    font: "Typeface for the burned-in lyrics. Drop a .ttf in backend/assets/fonts to add more.",
    align: "Horizontal alignment of the text within the box.",
    case: "Force upper- or lower-case, or leave the lyrics as written.",
    reveal: "line = show the whole line at once; word = fill in word-by-word over the line.",
    box: "The text box: drag the rectangle to move it, drag a corner to resize. Text wraps and fills it (defines size + placement).",
    outline: "Draw a black outline under the text so it stays readable over anything.",
    outlineWidth: "Outline thickness, as a fraction of the font size.",
    opacity: "Text opacity over the video.",
  },
  image: {
    box: "Placement box: drag the rectangle to move it, drag a corner to resize. The image is scaled into it by `fit`.",
    fit: "cover = fill the box, cropping overflow; contain = fit inside, letterboxed; stretch = distort to the box.",
    opacity: "Image opacity over the video.",
  },
  video: {
    box: "Placement box: drag the rectangle to move it, drag a corner to resize. The clip is scaled into it by `fit`.",
    fit: "cover = fill the box, cropping overflow; contain = fit inside, letterboxed; stretch = distort to the box.",
    sync: "song = the playhead follows the whole song's clock; segment = it restarts at this segment.",
    start: "Start offset into the source clip, in seconds.",
    speed: "Playback rate — 1 = normal, 2 = twice as fast, 0.5 = half speed.",
    loop: "Loop the clip if it's shorter than the window instead of freezing on its last frame.",
    opacity: "Clip opacity over the video.",
  },
  backdrop: {
    color: "The fill colour. Wire this into the BOTTOM input of a stack combine for a non-black background.",
    opacity: "Backdrop opacity over the layers beneath it.",
  },
  pattern: {
    layout: "Arrangement of the points: circle, ring, grid, line, spiral or scatter.",
    count: "How many source points to generate.",
    radius: "Size of the layout from its centre (extent for grid/line).",
    rotation: "Rotate the whole layout, in degrees.",
    offsetX: "Shift the layout left/right from the frame centre (0 = centred).",
    offsetY: "Shift the layout up/down from the frame centre (0 = centred).",
    seed: "Random seed for the scatter layout — change it for a different arrangement.",
  },
  "animate-points": {
    mode: "orbit = each point circles the centre; drift = slides along a heading; chase = a moving lit snake.",
    amount: "Orbit radius / drift distance (0–0.5 of the frame).",
    rate: "How many loops over the clip (chase: how fast the snake sweeps).",
    angle: "Drift heading, in degrees.",
    count: "Chase: how many points are lit at once (snake length).",
    fade: "Chase: tail taper — 0 = solid arc, 1 = fades from head to tail.",
  },
  lfo: {
    shape: "Waveform: sine, triangle, saw or square.",
    rateMode: "cycles/clip = N oscillations per segment; hz = cycles per second.",
    rate: "Oscillation speed, in the chosen rate unit.",
    phase: "Shift the wave's starting point (0–1 of a cycle).",
    duty: "Square only: fraction of each cycle spent high.",
  },
  noise: {
    rate: "How fast the noise wanders (control points per second).",
    octaves: "Fractal detail — more octaves = finer, busier variation.",
    seed: "Random seed — change for a different wander (renders stay stable).",
  },
  shaper: {
    delay: "Time-shift the value later, in ms — delay its response to the input.",
    wrap: "Wrap the shifted tail back to the start instead of padding the gap with zero.",
    invert: "Flip the curve: loud → low, quiet → high.",
    attack: "How quickly the value rises to a jump (ms). Lower = snappier.",
    release: "How quickly the value falls after a peak (ms). Higher = longer tails.",
    threshold: "Ignore everything below this level, then rescale what's above it.",
    gamma: "Bend the curve: > 1 emphasises peaks, < 1 lifts the quiet parts.",
    gain: "Multiply the value before clamping — boost or attenuate.",
    offset: "Add a constant to shift the whole curve up or down.",
    lo: "Output floor — the value 0 maps to.",
    hi: "Output ceiling — the value 1 maps to.",
  },
  math: {
    op: "How to fold the inputs: multiply, add, subtract, max, min, or mix (crossfade).",
    mix: "Crossfade between the first two inputs (0 = first, 1 = second).",
  },
  combine: {
    mode: "merge = inputs share one simulation (they interact); layered = stack with transparency.",
    dissipation: "Shared medium: how fast dye fades in the merged simulation.",
    velocity_dissipation: "Shared medium: how fast motion settles in the merged simulation.",
    viscosity: "Shared medium: thickness of the merged fluid.",
    vorticity: "Shared medium: swirl added back into the merged fluid.",
  },
};

// nodeType -> guide section id its "?" links to. `fluid` is resolved per param group
// (source vs medium) in `sectionFor`, so it's intentionally absent here.
export const ARG_SECTION: Record<string, string> = {
  color: "animation-fx",
  lyrics: "animation-sources",
  image: "animation-sources",
  video: "animation-sources",
  backdrop: "animation-sources",
  pattern: "animation-points",
  "animate-points": "animation-points",
  lfo: "animation-modulators",
  noise: "animation-modulators",
  math: "animation-modulators",
  shaper: "animation-modulators",
  combine: "animation-combine",
};

function sectionFor(type: string, group?: string): string | undefined {
  if (type === "fluid") return group === "medium" ? "fluid-medium" : "fluid-source";
  return ARG_SECTION[type];
}

// The help text + doc section for one argument. Returns props shaped to spread straight
// onto `Ctl`/`Toggle` (`help`/`section`); `ArgInfo` maps `help`→`Info`'s `text`. Empty
// object when there's no entry (no "?" is shown). `group` disambiguates fluid's section.
export function argHelp(
  type: string,
  key: string,
  group?: string
): { help?: string; section?: string } {
  const help = ARG_HELP[type]?.[key];
  if (!help) return {};
  return { help, section: sectionFor(type, group) };
}
