// The `fluid-lab` section of the in-app user guide. Split out of a single 1557-line
// Docs.tsx (cleanup step 13) — pure static JSX, no props, no shared state.
// The anchor id is load-bearing: every "?" in the UI deep-links to /?doc=fluid-lab,
// and paramHelp.test.tsx asserts the rendered ids match DOC_SECTION_IDS exactly.
export default function FluidLab() {
  return (
    <section id="fluid-lab">
      <h2>
        <span className="num">8</span>Playground &amp; the fluid card
      </h2>
      <p>
        The <strong>Playground</strong> is an always-present sandbox project (open it from the
        Projects screen). It holds one segment per card, each a small working pipeline that shows
        what that card does — the quickest way to see a card in isolation and copy its wiring. It
        opens in the Studio like any project, with synthetic stems so the signal cards have
        something to react to.
      </p>
      <p>
        Reworked a demo and want to keep it? The <strong>💾 save fixture</strong> button at the top
        of the CARDS rail writes the current Playground into the committed fixture (
        <code>backend/playground_pipelines.json</code>) — the state the Playground is rebuilt from
        on the next seed. It saves your latest edits first, so what you see is exactly what's
        captured. The file is under git, so review the diff and commit when you're happy (it's the
        in-app twin of <code>make export-playground</code>). A warning appears if a card would be
        left without a demo — every card must keep one.
      </p>
      <p>
        At the heart of most pipelines is the <strong>fluid</strong> card — a real-time fluid
        simulation. A source injects coloured dye and pushes the fluid around; the result renders to
        a short looping video. Every control below is a port you can drive with a signal, and each
        carries a <strong>?</strong> in the card that links back here. The controls group into the{" "}
        <em>source</em> (the emitter) and the <em>medium</em> (how the fluid flows).
      </p>

      <h3 id="fluid-source">The source — the dye emitter</h3>
      <table>
        <tbody>
          <tr>
            <th>Control</th>
            <th>Effect</th>
          </tr>
          <tr>
            <td>colour</td>
            <td>
              The dye colour, intensity (HDR glow) and opacity now live on the separate{" "}
              <strong>Color</strong> card — wire it into the fluid's <em>color</em> input. Unwired,
              the fluid uses its default colour.
            </td>
          </tr>
          <tr>
            <td>emit</td>
            <td>How much dye the source releases each frame.</td>
          </tr>
          <tr>
            <td>radius</td>
            <td>Size of the source splat (as a fraction of the canvas).</td>
          </tr>
          <tr>
            <td>force</td>
            <td>Strength of the jet the source pushes into the fluid.</td>
          </tr>
          <tr>
            <td>angle</td>
            <td>
              Direction the jet pushes (0° = right, 90° = down, 270° = up). Ignored when{" "}
              <em>radial</em> is on.
            </td>
          </tr>
          <tr>
            <td>radial</td>
            <td>Push outward in all directions from the centre instead of one heading.</td>
          </tr>
          <tr>
            <td>enabled</td>
            <td>Turn the dye emission on or off (a disabled fluid still carries motion).</td>
          </tr>
          <tr>
            <td>wrap edges</td>
            <td>
              On: dye leaving one edge re-enters the opposite (a looping torus). Off: dye that
              leaves the frame is gone for good.
            </td>
          </tr>
        </tbody>
      </table>

      <h3 id="fluid-medium">The medium — how the fluid behaves</h3>
      <table>
        <tbody>
          <tr>
            <th>Control</th>
            <th>Effect</th>
          </tr>
          <tr>
            <td>dissipation</td>
            <td>How fast the dye fades (lower = fades faster).</td>
          </tr>
          <tr>
            <td>velocity dissipation</td>
            <td>How fast the flow loses momentum (lower = calms faster).</td>
          </tr>
          <tr>
            <td>viscosity</td>
            <td>Thickness — smooths the velocity field (higher = gooier).</td>
          </tr>
          <tr>
            <td>vorticity</td>
            <td>Swirl — re-energises little vortices (higher = more curl).</td>
          </tr>
        </tbody>
      </table>
      <p>
        The clip always spans the full segment and loops seamlessly. Identical settings are cached,
        so re-rendering the same look is instant.
      </p>
    </section>
  );
}
