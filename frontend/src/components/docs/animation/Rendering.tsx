// Part of the guide's `animation` section (cleanup step 13 split an 842-line file).
// A fragment, not a <section>: the h3 anchor ids inside are deep-link targets that
// paramHelp.test.tsx checks against DOC_SECTION_IDS, so they must render unchanged.
export default function Rendering() {
  return (
    <>
      <h3>Rendering — it's automatic</h3>
      <p>
        There's no render button: the clip <strong>re-renders on its own</strong>
        (debounced) whenever you change the graph or a signal, and the result drops into the output
        card. The clip always spans the <strong>full segment</strong>. An incomplete graph (no
        output wired yet) just waits quietly; a real failure shows an error on the output card.
        Identical renders are cached, so repeats are instant.
      </p>
      <p>
        Use the <strong>transport</strong> at the top of the workspace (shared with the signals tab)
        to preview: <strong>▶ play segment</strong> plays the audio while the output video and every
        pulse pad animate off the same playhead; drag the <strong>timeline</strong> to scrub, set
        the
        <strong>🔊 volume</strong> (the simulation keeps running at any level), and toggle{" "}
        <strong>loop</strong>.
      </p>
      <p>
        Built a pipeline you like? The <strong>⧉ copy ‹prev│next›</strong> control (in the transport
        bar) copies the whole card layout onto the adjacent segment — and rewires its signal cards
        onto that segment's own signals (cloning any it's missing), so the copy reacts to the right
        audio, not the source segment's. Each side is disabled at the ends of the track (no segment
        on that side).
      </p>

      <h3 id="animation-output">Output settings</h3>
      <p>
        The <strong>⚙ output</strong> button opens project-wide render settings (they apply to every
        segment's animation):
      </p>
      <table>
        <tbody>
          <tr>
            <th>Setting</th>
            <th>What it does</th>
          </tr>
          <tr>
            <td>orientation / size</td>
            <td>Portrait 9:16, Landscape 16:9, Square 1:1, or a custom width×height.</td>
          </tr>
          <tr>
            <td>quality</td>
            <td>
              Draft (fast) · Normal · High (sharper swirls, slower) — the simulation resolution.
            </td>
          </tr>
          <tr>
            <td>fps</td>
            <td>24, 30, or 60 frames per second.</td>
          </tr>
        </tbody>
      </table>
      <div className="note">
        There's no background colour setting: un-dyed pixels render <strong>black</strong>. For a
        non-black background, add a <a href="#animation-sources">Backdrop</a> card as the{" "}
        <strong>bottom</strong> layer of a <em>layered</em> combine. These settings drive the
        per-segment <em>previews</em>; the final track renders in HD from the{" "}
        <a href="#export">export stage</a>.
      </div>

      <h3 id="animation-output-hd">See one segment in HD</h3>
      <p>
        The clip on an output card is a <em>draft</em> — small, and simulated on the coarse grid the
        quality preset picks, so it stays responsive while you edit. To judge how a segment will
        really look, hit <strong>⬛ HD</strong> on the output card: it renders that one segment at{" "}
        <strong>exactly the final export's settings</strong> (size, fps, detail, and HD-regenerated
        Image-gen / AI-Stylize / <a href="#animation-dream">Dream</a> assets), muxes in the
        segment's audio, and opens it full screen with playback controls and a download link. What
        you see is what the master will contain for that segment — no need to export the whole track
        to find out.
      </p>
      <ul>
        <li>
          <strong>Rendered once.</strong> Reload the page and the card checks whether this exact
          segment is already in HD on disk: if it is, you get <strong>⤢ view HD ✓</strong> straight
          away instead of a fresh render. Edit anything that changes the frames and the offer
          disappears by itself — it is the render you'd get, not a note saying one exists.
        </li>
        <li>
          Change the settings in the <a href="#export">export stage</a> — the HD button always
          follows them, so there's one place to tune quality and no way for the two to disagree.
        </li>
        <li>
          It's a real HD render: <strong>minutes</strong>, not seconds. Progress shows the phase
          (preparing assets → generating Dream frames → rendering → adding audio); the button
          cancels it. A <a href="#animation-dream">Dream</a> card makes that second phase the long
          one — it's one image per frame — and it has its own counter for that reason. Leaving the
          segment (or the Studio) does <em>not</em> cancel — come back and it's still going.
        </li>
        <li>
          Only <strong>one</strong> HD render runs at a time, whether it's a segment or the full
          export — they'd otherwise starve each other and every card preview. Starting a second one
          tells you which is already running.
        </li>
        <li>
          The HD clip is cached separately from the card's draft, so rendering in HD never disturbs
          the preview you were working with.
        </li>
      </ul>
    </>
  );
}
