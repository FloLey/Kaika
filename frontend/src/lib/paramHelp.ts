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
    velocity_dissipation:
      "How fast the motion settles. Lower = quick calm; higher = keeps swirling.",
    viscosity: "Thickness of the fluid — higher smears neighbouring motion together (syrupy).",
    vorticity: "Adds swirl and curl back into the fluid — higher = more eddies and detail.",
    enabled: "Turn this fluid's dye emission on or off.",
    radial: "Push dye outward from the centre instead of along a fixed heading.",
    wrap: "On: dye leaving one edge re-enters the opposite (a looping torus). Off: it's gone for good.",
    positions:
      "Wire a Points / Pattern card here to emit a source at each drawn point (else one source at the centre).",
    color: "Wire a Colour card here to set the dye colour (else the fluid's static colour).",
  },
  color: {
    mode: "swatch = one solid colour; rgb = drive r/g/b with signals; gradient = scrub along stops.",
    r: "Red channel of the dye colour.",
    g: "Green channel of the dye colour.",
    b: "Blue channel of the dye colour.",
    intensity: "Overall brightness multiplier of the colour.",
    opacity: "How opaque the dye is over the background.",
    position:
      "Where along the gradient to sample (0 = first stop, 1 = last) — modulate to sweep it.",
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
    fillColor: "Wire a Colour card here to drive the text fill colour (else white).",
    outlineColor: "Wire a Colour card here to drive the outline colour (else black).",
  },
  image: {
    box: "Placement box: drag the rectangle to move it, drag a corner to resize. The image is scaled into it by `fit`.",
    fit: "cover = fill the box, cropping overflow; contain = fit inside, letterboxed; stretch = distort to the box.",
    opacity: "Image opacity over the video.",
  },
  slideshow: {
    trigger:
      "Each RISING edge of this signal past the threshold shows the NEXT image (wrapping). Feed it through a gate card to control exactly when it switches.",
    opacity: "Layer transparency \u2014 wire a signal to fade the slideshow with the music.",
    threshold: "The trigger level that counts as a switch: rising past it advances the image.",
    hysteresis:
      "Dead band under the threshold \u2014 the trigger must fall below it before it can advance again (no machine-gunning).",
    fit: "How each image fills the box: cover (fill + crop), contain (letterbox), stretch.",
    box: "Where the slideshow sits in the frame \u2014 drag to move, pull a corner to size.",
    images: "Wire an Image gen card here to feed its generated list into the slideshow.",
  },
  imagegen: {
    in: "Wire a gate here to size the prompt list to its pulses (one image per switch).",
    prompts:
      "One image per prompt \u2014 the card generates them in order (image i uses seed + i).",
    seed: "Generation seed \u2014 the same prompts + seed reproduce the same images; it bumps automatically after each \u2728.",
    model:
      "Which model the \u2728 draft uses: SD-Turbo is fast and low-res for building; Z-Image-Turbo is HD but slow. The final export always regenerates in HD regardless.",
  },
  video: {
    box: "Placement box: drag the rectangle to move it, drag a corner to resize. The clip is scaled into it by `fit`.",
    crop: "Select which part of the SOURCE clip is used: drag a corner to cut a region out of the frame, drag the rectangle to move it. Only that region gets fitted into the box — pick the part that matters when the clip is too wide/tall for the format.",
    fit: "cover = fill the box, cropping overflow; contain = fit inside, letterboxed; stretch = distort to the box.",
    sync: "song = the playhead follows the whole song's clock; segment = it restarts at this segment's (or, inside a montage extract, that extract's) start. A montage's picked clips are created on the segment clock so they start at their in-point on the cut.",
    start: "Start offset into the source clip, in seconds.",
    speed: "Playback rate — 1 = normal, 2 = twice as fast, 0.5 = half speed.",
    loop: "Loop the clip if it's shorter than the window instead of freezing on its last frame.",
    opacity: "Clip opacity over the video.",
  },
  backdrop: {
    color:
      "The fill colour. Wire this into the BOTTOM input of a stack combine for a non-black background.",
    opacity: "Backdrop opacity over the layers beneath it.",
  },
  waves: {
    palette:
      "The water colour scheme (ocean / tropical / storm / sunset) — the pool floor when no video is wired.",
    color:
      "Optional: wire a color card here to override the palette. A gradient card supplies the whole water ramp.",
    video:
      "Optional: the layer the water refracts — an image, a clip, a fluid. The caustics dance on it and the ripples bend it. Empty = the palette floor.",
    scale:
      "Wavelength of the dominant waves — small is fine ripples, large is broad slow swells (they really travel slower: deep-water dispersion).",
    steepness:
      "Wave slope — the realism knob. Low is glassy calm, high is lively chop. Wire energy here and the water stirs with the music.",
    depth:
      "How deep the pool is: focuses the caustic filaments, strengthens the refraction and deepens the blue-green absorption tint.",
    speed:
      "Time multiplier on the whole surface (dispersion preserved — big and small waves keep their relative speeds).",
    direction:
      "The mean travel direction of the wave fan, in degrees (a couple of components always reflect back off the pool walls).",
    caustics: "Brightness of the focused-light filament network on the floor.",
    chroma:
      "Chromatic dispersion: red/blue fringes on the caustic filaments and refraction edges, like real water splits light.",
    shine: "Sun glints on the surface — tight sparkles on wave facets that align with the sun.",
    opacity: "Layer opacity over everything beneath it.",
  },
  lightning: {
    palette: "The bolt/glow colour scheme (electric blue / violet / white-hot / ember).",
    color: "Optional: wire a color card here to override the palette bolt colour.",
    strike: "Fires a bolt each time this rises past its midpoint — wire an onset or beat signal.",
    positions:
      "Optional: wire a points card here and each strike picks one of its points as origin (an animate-points card moves them over the clip).",
    origin_x:
      "Where the bolt starts, horizontally (0 = left edge, 1 = right). Modulate it and each strike lands somewhere new.",
    origin_y:
      "Where the bolt starts, vertically (0 = top). Ignored when a points card is wired into positions.",
    direction:
      "The bolt's overall travel direction in degrees (90 = downward). The discharge grows toward this heading.",
    length: "How far the bolt reaches, as a fraction of the frame diagonal.",
    branchiness:
      "The discharge's branching density — 0 is a near-bare channel, 1 is a full Lichtenberg tree of forks.",
    thickness: "Core channel width in pixels — branches taper thinner from it.",
    glow: "Strength of the atmospheric halo around the channel (the core always burns white-hot).",
    flicker:
      "Restrikes: how many times the SAME channel re-flashes (without its branches) at ~50 ms — the real lightning flicker.",
    flash:
      "Sky illumination around the origin, pulsing with each stroke — cloud-scatter, not a flat veil.",
    afterglow:
      "The continuing-current ember: how long a faint channel glow persists after the strokes.",
    opacity: "Layer opacity over everything beneath it.",
  },
  fire: {
    palette:
      "The flame ramp — `flame` is the physical blackbody locus (dim red → orange → white-hot); the others recolour the same heat.",
    color:
      "Optional: wire a color card here to override the palette. A gradient card supplies the whole heat ramp.",
    positions:
      "Optional: wire a points card here to light one flame per point — close flames lean into each other and merge, like real fires.",
    origin_x: "The flame's base, horizontally (0..1). Wire an LFO and the flame glides.",
    origin_y: "The flame's base, vertically (0 = top, 1 = bottom).",
    direction:
      "Which way the flame rises (270 = up). It literally rotates gravity for this field — a sideways torch streams sideways.",
    intensity:
      "Heat injected at the base — the size and violence of the blaze. Wire energy for a breathing fire.",
    width: "Radius of the emitting base — narrow is a candle/torch, wide is a wall of flame.",
    cooling:
      "How fast the gas cools (quartic, like real radiation) — the flame-height knob: high cooling = short lively flame.",
    turbulence: "Vorticity confinement in the hot column — the licking, curling tongues.",
    flicker:
      "Slow organic breathing of the emission (~4 Hz smoothed noise) — never per-frame jitter.",
    expansion: "Combustion expansion at the base — fuller, rounder flames.",
    glow: "Bloom radius around the hot regions.",
    opacity: "Layer opacity over everything beneath it.",
  },
  aurora: {
    palette:
      "Colour by ALTITUDE in the curtain, like the real emission lines: purple fringe at the bottom edge, oxygen green above, red at the top.",
    color: "Optional: wire a color card here to override the altitude ramp.",
    position_y: "Where the curtain's bright lower edge sits in the sky (0 = top of frame).",
    height: "How far the rays extend above the lower edge — the curtain's vertical reach.",
    bands: "How many arcs hang across the sky.",
    sway: "Amplitude of the arcs' slow folding — how far the curtain snakes.",
    drift:
      "Horizontal glide of the whole curtain. Real quiet arcs barely move — keep it low for calm.",
    shimmer:
      "How fast individual rays bloom and die (their positions never slide — only intensities crossfade, like the real ~1 s oxygen glow).",
    rays: "Density of the vertical rays inside the curtain.",
    brightness: "Overall intensity. Wire a tonal / harmonic signal so the pads light the sky.",
    opacity: "Layer opacity over everything beneath it.",
  },
  rain: {
    palette: "The surface tint when no video is wired (the lit liquid).",
    color: "Optional: wire a color card here to override the surface tint.",
    video:
      "Optional: the layer at the bottom of the liquid — the rings refract and bend it. Empty = the palette surface.",
    positions:
      "Optional: wire a points card here and the drops fall on those spots (fixed drips whose ring trains interfere) instead of everywhere.",
    density: "How many drops fall per second. Wire an energy signal so it pours on the loud parts.",
    drop_size: "Size of each impact — bigger drops throw wider, taller rings.",
    ripple_speed:
      "How fast the rings race outward (fine ripples always lead the main ring — capillary dispersion).",
    decay:
      "How long rings survive — high keeps them crossing the whole frame and interfering with each other.",
    distort: "How strongly the surface bends the layer beneath (refraction magnitude).",
    shine: "Specular glints on the ring slopes.",
    opacity: "Layer opacity over everything beneath it.",
  },
  clouds: {
    palette:
      "The lighting ramp (sky / nebula / ink / dust) — sunlit cumulus or a saturated nebula.",
    color:
      "Optional: wire a color card here to override the palette. A gradient card supplies the whole ramp.",
    coverage: "How much of the sky the clouds fill — from a few puffs to an overcast lid.",
    scale: "Cloud mass size — low is small puffs, high is towering billows.",
    softness: "Edge feathering — crisp cauliflower rims versus misty veils.",
    drift:
      "How fast the clouds travel (each detail scale drifts at its own speed, so they morph rather than slide).",
    direction: "The wind direction the clouds drift along, in degrees.",
    turbulence: "Domain-warp churn — how roiled and eroded the masses are. Wire flux here.",
    light_angle:
      "Where the sun sits, in degrees — the masses self-shadow away from it and rims blaze on its side.",
    shading: "Depth of the self-shadowing (the Beer-Lambert march toward the sun).",
    silver: "Silver-lining strength: thin rims flare around the sun's position.",
    brightness:
      "Overall lighting level. Wire an energy signal to make the sky glow with the music.",
    opacity: "Layer opacity over everything beneath it.",
  },
  transform: {
    mode: "transform pans/zooms/rotates the video; mirror reflects one half across the centre; kaleidoscope folds it into mirrored wedges.",
    segments: "How many mirrored wedges the kaleidoscope folds the frame into.",
    wrap: "How the frame's outside is filled. Mirror/kaleidoscope already mirror the edge so there are no black gaps on any aspect; On tiles the frame instead. A plain transform is black outside unless On.",
    zoom: "Scale the video about its centre — above 1 zooms in, below 1 zooms out (revealing black edges unless wrapped).",
    rotate: "Spin the whole frame, in degrees. Wire this to a signal for beat-locked rotation.",
    pan_x: "Slide the video horizontally, as a fraction of the frame width.",
    pan_y: "Slide the video vertically, as a fraction of the frame height.",
  },
  stylize: {
    model:
      "Which local diffusion model to use: SD-Turbo is a fast draft (a few seconds per frame) — iterate with it. Z-Image is HD and slow (~30s per frame, so a clip takes tens of minutes): it must generate at a higher resolution — any lower and it paints blobs instead of subjects. Switch to it once the draft looks right.",
    inpaint:
      "Off = repaint the whole frame (img2img). On = confine the repaint to the input's shape (leaves the black background untouched).",
    prompt: "The look to paint the video into — e.g. flowers, molten lava, storm clouds.",
    strength:
      "How far the AI reinvents the input — the generation always STARTS from the input, so it keeps its layout (a fluid's black background stays black). With SD-Turbo the strength is near-binary: 1.0 fully restyles to the prompt (real flowers/lava, prompt colours) — this is the default; below ~0.9 it keeps the input's own colours (a subtle blend). Z-Image (HD) blends gradually: 1.0 restyles hardest, ~0.85 keeps more of the fluid's form. Modulatable — wire a signal to drive it.",
  },
  extract: {
    kind: "What structure to pull from the video: canny = hard edges (real-time); soft = a softened edge map; density = the input's own brightness — the best 'volume' control for a fluid; depth = a depth map from a model (for real 3D footage, not fluids — downloads on first use). Feed the result into AI Stylize's control input.",
  },
  echo: {
    mode: "What the trail remembers. ghost = translucent afterimages of every change — the classic echo on real footage, whatever the contrast. bright = only bright-on-dark content trails, at full brightness (comet tails for fluids; black stays black). dark = the mirror: dark subjects on a bright scene drag solid shadow trails.",
    length:
      "How long ghosts linger — the trail's half-life in seconds (0 = off). Wire this to a signal and the trails stretch on every hit.",
    amount: "Dry ↔ trail mix: 0 = the untouched video, 1 = full ghosting.",
  },
  colorgrade: {
    mode: "How the video is recoloured. thermal = luminance through a heat colormap; duotone = a shadow→highlight two-colour remap (poster look); neon = glowing edges on black. thermal (except inferno) and duotone recolour the black background too — put grade modes at the END of the chain.",
    map: "The thermal colormap: turbo/jet run blue→red, inferno stays near-black in the shadows, ocean is a cold blue ramp.",
    colorA: "The duotone shadow colour — what the darkest parts of the video become.",
    colorB: "The duotone highlight / neon glow colour. A color card wired into tint overrides it.",
    tint: "Wire a color card here to drive the grade colour. A gradient card with its position bound to a signal sweeps the colour with the music.",
    intensity:
      "Dry ↔ graded mix (neon: how strong the glow halo is). Wire a signal to fade the grade in and out.",
    shift:
      "A per-mode colour shift: rolls the thermal colormap, moves the duotone midpoint (darker↔brighter split), or rotates the neon glow's hue. Wire a signal to animate it.",
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
    in: "Wire a Points / Pattern card here — the set this card animates over the clip.",
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
    in: "The 0..1 value to re-shape — wire a signal / LFO / noise / math here.",
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
  gate: {
    in: "The 0..1 value to gate \u2014 wire a signal / LFO / noise / math here.",
    threshold: "The level the gate switches around: input above \u2192 1, below \u2192 0.",
    hysteresis:
      "Dead band centred on the threshold \u2014 wider = harder for a hovering signal to flicker the gate.",
    minGap:
      "Minimum seconds between spikes: a rising edge closer than this to the last kept one is dropped. Caps the spike RATE by time (0 = off).",
    divide:
      "Keep only every Nth spike (1/N). 1/1 passes all, 1/4 passes every fourth \u2014 a divider off the input's own rate.",
    invert: "Flip the output: 1 while the input is BELOW the threshold.",
  },
  change: {
    in: "The 0..1 value to watch — wire a signal (energy, chroma…) / LFO / math here.",
    gain: "Scale on the change rate. A curve sweeping 0→1 in one second reads ≈1.0 at gain 1 — raise it to catch subtler movement.",
    attack: "How fast the output reacts when change starts, in ms. Keep it low for sharp response.",
    release:
      "How long the bump lingers after the change stops, in ms. Slow enough that a downstream gate sees ONE clean pulse per transition.",
    direction:
      "both = any movement; rise = only when the signal climbs; fall = only when it drops.",
  },
  math: {
    input:
      "A 0..1 value to fold in — wire a signal / LFO / noise / gate here. Slot order matters for subtract/mix; assign a source to a slot in the settings window to move it there (it leaves any other slot) — swap operands without rewiring.",
    op: "How to fold the inputs: multiply, add, subtract, max, min, or mix (crossfade).",
    mix: "Crossfade between the first two inputs (0 = first, 1 = second).",
  },
  combine: {
    layer:
      "A video source to composite — wire a fluid / another combine / a layer card. Slot order is stack order (in 1 = top); assign a source to a slot to move it there (it leaves any other), so you can reorder layers without rewiring.",
    mode: "merge = inputs share one simulation (they interact); layered = stack with transparency.",
    dissipation: "Shared medium: how fast dye fades in the merged simulation.",
    velocity_dissipation: "Shared medium: how fast motion settles in the merged simulation.",
    viscosity: "Shared medium: thickness of the merged fluid.",
    vorticity: "Shared medium: swirl added back into the merged fluid.",
  },
  montage: {
    trigger:
      "Each RISING edge of this signal past the threshold CUTS to the next extract, its composition restarted at the cut. Wire signal → gate (use divide for every Nth beat) → here for musical cuts; manual breakpoints add cuts by hand and combine with these.",
    opacity: "Layer transparency — wire a signal to fade the montage with the music.",
    threshold: "The trigger level that counts as a cut: rising past it starts the next extract.",
    hysteresis:
      "Dead band under the threshold — the trigger must fall below it before it can cut again (no machine-gunning).",
    extracts:
      "One composition per extract, played in order — extract 1 from the window start, each next one from its cut. + video picks a clip from the library (it becomes a tiny video→output composition you can open and edit); ×N makes an extract swallow N cuts. The row shows the extract's start – end window in seconds. The same composition can be referenced by several extracts — editing it updates them all.",
  },
  scope: {
    in: "The value to monitor — it passes straight through, unchanged.",
  },
  "merge-points": {
    input:
      "A points set to merge in — wire a Points / Pattern / Animate card. Slot order sets concatenation order; assign a source to a slot to move it there (it leaves any other), so you can reorder without rewiring.",
  },
  output: {
    video: "The video to render — wire a fluid or a combine into this output.",
  },
};

// nodeType -> guide section id its "?" links to. `fluid` is resolved per param group
// (source vs medium) in `sectionFor`, so it's intentionally absent here.
export const ARG_SECTION: Record<string, string> = {
  color: "animation-fx",
  lyrics: "animation-sources",
  image: "animation-sources",
  slideshow: "animation-sources",
  imagegen: "animation-sources",
  video: "animation-sources",
  backdrop: "animation-sources",
  waves: "animation-generators",
  lightning: "animation-generators",
  fire: "animation-generators",
  aurora: "animation-generators",
  rain: "animation-generators",
  clouds: "animation-generators",
  pattern: "animation-points",
  "animate-points": "animation-points",
  lfo: "animation-modulators",
  noise: "animation-modulators",
  math: "animation-modulators",
  shaper: "animation-modulators",
  gate: "animation-modulators",
  change: "animation-modulators",
  scope: "animation-modulators",
  "merge-points": "animation-points",
  output: "animation-output",
  combine: "animation-combine",
  montage: "animation-montage",
  transform: "animation-transform",
  stylize: "animation-stylize",
  extract: "animation-stylize",
  echo: "animation-lookfx",
  colorgrade: "animation-lookfx",
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
