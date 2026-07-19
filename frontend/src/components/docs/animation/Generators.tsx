// Part of the guide's `animation` section (cleanup step 13 split an 842-line file).
// A fragment, not a <section>: the h3 anchor ids inside are deep-link targets that
// paramHelp.test.tsx checks against DOC_SECTION_IDS, so they must render unchanged.
export default function Generators() {
  return (
    <>
      <h3 id="animation-generators">Simulation layers — water, lightning, fire &amp; skies</h3>
      <p>
        These cards are small physical <em>simulations</em>, driven by your signals — real wave
        optics, a real electric discharge, real buoyant combustion, a real rippling surface, lit
        volumetric clouds. They output a video layer, so stack them with fluids in a{" "}
        <em>layered</em> combine or send one straight to an output. Each takes a <em>palette</em>{" "}
        preset (or wire a <a href="#animation-fx">colour card</a> into its <em>colour</em> input to
        override it), and like the fluid card they join the wider graph: a{" "}
        <a href="#animation-points">points card</a> fans fire / lightning / rain out to several
        origins (an <em>animate points</em> card even moves them), every port takes a signal or LFO,
        and a <em>merge</em> combine joins same-kind cards into ONE shared field — two fires become
        one blaze, two rains drip into one surface.
      </p>
      <ul>
        <li>
          <strong>Waves</strong> — pool water seen from above. A fan of real dispersive waves (long
          swells genuinely outrun fine ripples) focuses light into the dancing caustic filament
          network, and <em>refracts</em> whatever you wire into its <em>video</em> input — an image,
          a clip, a fluid — complete with chromatic fringes (<em>chroma</em>), sun glints (
          <em>shine</em>) and the blue-green depth tint (<em>depth</em>). Nothing wired = the
          palette floor. Wire energy to <em>steepness</em> and the water chops with the music.
        </li>
        <li>
          <strong>Lightning</strong> — a genuine dielectric-breakdown discharge: hierarchical,
          self-avoiding branches grown from (<em>origin x</em>, <em>origin y</em>) toward{" "}
          <em>direction</em>, with a white-hot core inside a tinted halo. Each rising edge of{" "}
          <em>strike</em> fires one (wire an <a href="#animation-modulators">onset or gate</a>{" "}
          signal); <em>flicker</em> adds the real thing's restrikes — the same channel, minus its
          branches, re-flashing at ~50 ms — and <em>flash</em> lights the sky around the origin.{" "}
          <em>branches</em> runs from a bare spear to a full Lichtenberg tree.
        </li>
        <li>
          <strong>Fire</strong> — buoyant combustion on the fluid solver: heat rises, cools like
          real radiating gas (<em>cooling</em> is the flame-height knob) and glows with true
          blackbody colour. Place the base anywhere (<em>origin x/y</em>), aim it with{" "}
          <em>direction</em> (a sideways torch works — it literally rotates gravity), and feed a
          points card into <em>positions</em> for several flames: bring two close and they lean into
          each other and merge, exactly like real fires. Merging fire cards in a combine — even with
          a dye fluid — shares one simulation.
        </li>
        <li>
          <strong>Aurora</strong> — built like the real curtains: near-horizontal arcs with a sharp
          lower edge, vertical rays whose intensities bloom and die on the ~1 s oxygen-glow
          timescale (<em>shimmer</em>), colours stratified by altitude — purple fringe, green body,
          red top. Quasi-static and veil-calm by default; <em>position y</em> and <em>height</em>{" "}
          place it in the sky. Wire a tonal <em>harmonic</em> signal to <em>brightness</em>.
        </li>
        <li>
          <strong>Rain</strong> — drops on a liquid surface whose floor is the layer wired into{" "}
          <em>video</em>. Each drop punches a crater, rebounds and rings out; the rings race outward
          (fine capillary ripples leading, as on real water), collide and <em>interfere</em>,
          bending the image beneath (<em>distort</em>). A points card into <em>positions</em> turns
          uniform rain into fixed drip points; merged rain cards drip into one shared surface. Wire
          energy to <em>density</em> and it pours with the music.
        </li>
        <li>
          <strong>Clouds</strong> — sunlit cumulus: billowing masses that self-shadow along{" "}
          <em>light angle</em>, read brighter in the crevices than on the bulges (the real powder
          effect) and flare a <em>silver</em> lining on thin rims near the sun. Sky shows through
          between them, so it layers cleanly. A dreamy sky or a saturated <em>nebula</em> by
          palette; wire <em>flux</em> to <em>turbulence</em> so busy passages churn the sky.
        </li>
      </ul>

      <h3 id="animation-fx">Colour — the dye card</h3>
      <p>
        The <strong>Color</strong> card sets a fluid's <em>dye</em> colour at the source — wire it
        into the fluid's <em>color</em> input. Its <em>mode</em> is <em>swatch</em> (one colour),{" "}
        <em>rgb</em> (drive r/g/b with signals), or <em>gradient</em> (colour stops plus a
        modulatable <em>position</em> that scrubs along them); <em>intensity</em> and{" "}
        <em>opacity</em> are always modulatable. Because it colours the dye at emission (not a
        finished picture), it works with both <em>layered</em> and <em>merge</em> combines.
      </p>
    </>
  );
}
