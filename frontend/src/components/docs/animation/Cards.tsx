// Part of the guide's `animation` section (cleanup step 13 split an 842-line file).
// A fragment, not a <section>: the h3 anchor ids inside are deep-link targets that
// paramHelp.test.tsx checks against DOC_SECTION_IDS, so they must render unchanged.
export default function Cards() {
  return (
    <>
      <h3>The cards</h3>
      <p>
        The palette (top-left of the canvas) groups cards into category buttons —{" "}
        <strong>Sources</strong> (signal, colour), <strong>Modulators</strong> (the value cards),{" "}
        <strong>Points</strong> (source positions for a fluid), <strong>Generators</strong> (fluid,
        image, video, slideshow, image gen, backdrop, lyrics), <strong>Compositing</strong>,{" "}
        <strong>Output</strong> (in data-flow order). Open a category and{" "}
        <strong>hover any item</strong> for a tip describing what it does and what it takes in →
        puts out, then click to drop it. Every card shows as a <strong>compact tile</strong> — its
        name, a small live preview, and one input + one output dot;{" "}
        <strong>click a card's body</strong> to open its settings window and edit it. The{" "}
        <strong>✨ arrange</strong> toolbar button lays the cards out along the data flow — sources
        left, output right — giving them room and untangling wire crossings where it can (a{" "}
        <a href="#animation-montage">montage</a>'s extracts are re-ordered on the card itself, not
        by moving cards). Clicking arrange again changes nothing. The settings window shows{" "}
        <strong>inputs &amp; controls on the left, a big live preview on the right</strong> (editing
        the graph live — <kbd>Esc</kbd>, the ✕, or a click outside closes it). The right-hand
        preview is tailored per card — the sim/composite, a value's pulse, an image/video in its
        placement box, a colour swatch, a gallery of generated images (click one for a lightbox with
        ‹ › arrows), or a slideshow cycling its slides. The <em>lyrics</em> window adds a second{" "}
        <strong>lyrics</strong> tab to edit the line words &amp; timings; clicking the{" "}
        <em>output</em> card's render opens it big with a ★ mark-final toggle. Every card gets a{" "}
        <strong>default name</strong> (its type plus a counter — <em>fluid 1</em>, <em>fluid 2</em>
        …); <strong>double-click the title</strong> to rename it (on the canvas or in its settings
        window), so you can find it again by name in every input dropdown. Every card has a{" "}
        <strong>✕</strong> in its top-right corner to delete it (which also removes its wires). The{" "}
        <em>output</em> card is the one exception — its body is the live render preview, so it
        always shows in full.
      </p>
      <p>
        Three more canvas tools: the canvas <strong>opens fitted</strong> (every card framed in
        view), and <strong>⊙ fit</strong> (toolbar, or <strong>double-click empty canvas</strong>)
        re-fits it any time — the rescue move when a card was dragged off-screen. The{" "}
        <strong>↶ / ↷</strong> toolbar buttons (or <kbd>Cmd</kbd>+<kbd>Z</kbd> / <kbd>Shift</kbd>+
        <kbd>Cmd</kbd>+<kbd>Z</kbd>) <strong>undo/redo</strong> graph edits (wires, cards, knob
        drags — a whole slider drag reverts as one step; typing in a text field keeps its own undo).
        They grey out when there's nothing to step through, and the history is per segment and
        resets when you reload. And when the graph contains <strong>dead wiring</strong> that would
        render silently wrong — a gate with no input (a flat 0), a wired port whose lo–hi range
        collapsed to zero width (the signal is flattened, so e.g. a slideshow trigger never fires),
        an output with no input, a stale ★ final mark — a <strong>⚠ problems</strong> chip appears
        in the toolbar; click a row to jump straight to the offending card.
      </p>
      <table>
        <tbody>
          <tr>
            <th>Card</th>
            <th>What it does</th>
          </tr>
          <tr>
            <td>signal</td>
            <td>
              Exposes one of this segment's signals (from the other tab) as a 0–1 curve, with a live
              pulse pad so you can see it move. Pick which signal from the <strong>+ Signal</strong>{" "}
              menu. One output.
            </td>
          </tr>
          <tr>
            <td>math · lfo · noise · shaper</td>
            <td>
              The <strong>modulator</strong> cards — they make a 0–1 curve composable in the graph
              itself (see <a href="#animation-modulators">below</a>). <em>Math</em> blends signals,{" "}
              <em>LFO</em> and <em>noise</em> generate motion with no audio, and <em>shaper</em>{" "}
              re-curves a signal. Each has one value output.
            </td>
          </tr>
          <tr>
            <td>fluid</td>
            <td>
              The simulation. Static bits (on/off, radial, a base colour) live on the card; every
              animatable parameter — force, vorticity, emit, the red/green/blue colour channels, … —
              is an <strong>input port</strong>, grouped into collapsible{" "}
              <em>source / colour / medium</em> sections. One video output.
            </td>
          </tr>
          <tr>
            <td>points</td>
            <td>
              A small canvas you draw points on (see below). Wire it into a fluid's{" "}
              <em>positions</em> input and the fluid puts a <strong>source at each point</strong>{" "}
              instead of one in the centre.
            </td>
          </tr>
          <tr>
            <td>lyrics</td>
            <td>
              A non-fluid <strong>video source</strong> (<a href="#animation-sources">see below</a>
              ): <em>lyrics</em> burns the segment's aligned lyrics into the video. It gives a video
              out.
            </td>
          </tr>
          <tr>
            <td>slideshow · image gen</td>
            <td>
              A <strong>slideshow</strong> switches between several images and video clips on a
              trigger signal (<a href="#animation-sources">see below</a>); an{" "}
              <strong>image gen</strong> card generates images locally — one per prompt — and feeds
              them into a slideshow via its <em>images</em> wire.
            </td>
          </tr>
          <tr>
            <td>image · video</td>
            <td>
              Layer an <strong>uploaded picture or clip</strong> into the frame (
              <a href="#animation-sources">see below</a>): drop a file on the card (or pick from the{" "}
              <a href="#assets">📚 library</a>; the video card can also import from YouTube), place
              it with the box, choose how it fills, and stack it with fluids in a <em>layered</em>{" "}
              combine. Each gives a video out.
            </td>
          </tr>
          <tr>
            <td>backdrop</td>
            <td>
              Fills the whole frame with a solid <strong>colour</strong> — the bottom layer of a{" "}
              <em>layered</em> combine when you want a non-black background (
              <a href="#animation-sources">see below</a>). One video out.
            </td>
          </tr>
          <tr>
            <td>color</td>
            <td>
              Sets a fluid's <a href="#animation-fx">dye colour</a> at the source — swatch, RGB
              channels, or a gradient you scrub. Wire it into a fluid's <em>color</em> input; its
              channels can be signal-driven too.
            </td>
          </tr>
          <tr>
            <td>combine</td>
            <td>
              Composes several fluids into one (see below): <em>merge</em> = their sources share one
              simulation and interact; <em>layered</em> = the inputs are stacked with per-input
              transparency. Dynamic inputs (a <strong>+ input</strong> button), one video output.
            </td>
          </tr>
          <tr>
            <td>output</td>
            <td>
              Shows the rendered looping video — wire a fluid's (or combine's) video output into it.
              It also <strong>passes its input through</strong> (a video out port), so you can
              preview a stream <em>and</em> feed it onward. You can have several independent
              fluid/combine → output pipelines in one graph.
            </td>
          </tr>
        </tbody>
      </table>

      <h3>Wiring &amp; the [lo, hi] range</h3>
      <ul>
        <li>
          <strong>Connect</strong> — a card shows one input dot standing in for <em>all</em> its
          inputs, so a wire dropped on it can't always know which one you mean. When the destination
          is unambiguous (an output's video input, a combine's free slot, a fluid's positions, a
          card with a single free port) it wires itself; otherwise the line{" "}
          <strong>parks gray</strong> — connected, but not assigned to a port yet.
        </li>
        <li>
          <strong>Assign a gray wire</strong> — open the card (click its body) and use each input's
          dropdown. The dropdown has <strong>three sections</strong>: the gray wires waiting on this
          card (<em>connected — unassigned</em>) on top, then sources already wired to one of this
          card's inputs (<em>connected</em>), then <em>other</em> candidates. Pick one and the gray
          line goes live. Choosing <em>— none —</em> sends a wire back to gray so you can re-route
          it without redrawing it.
        </li>
        <li>
          <strong>Cards keep their wires tidy</strong> — every assigned inbound wire converges on
          the single left dot and the output leaves from the single right dot.
        </li>
        <li>
          <strong>Animate a parameter</strong> — when a <em>signal</em> drives a parameter, its 0–1
          curve is mapped into a <strong>[lo, hi]</strong> range you set right on that port. So a
          kick-energy signal on <em>force</em> with range 0–45 makes the jet punch on every kick.
          Set lo and hi to taste; detach with the ✕.
        </li>
        <li>
          <strong>Steady values</strong> — an un-wired port just holds a steady value (its slider)
          in the parameter's native range.
        </li>
        <li>
          <strong>Move / delete</strong> — drag a card by its title bar; pan the canvas by dragging
          the background and zoom with the scroll wheel. Delete a card with its ✕, or select a
          card/wire and press Delete.
        </li>
        <li>
          <strong>Select several at once</strong> — <kbd>Shift</kbd>- or <kbd>⌘</kbd>-click cards to
          add them to the selection, or <kbd>Shift</kbd>-drag a box across the background to grab
          everything inside it. Then drag any selected card to{" "}
          <strong>move the whole group in one go</strong>, or press Delete to remove them all. Click
          an empty spot to clear the selection.
        </li>
      </ul>
      <p>
        The fluid parameters are the same ones documented under
        <a href="#fluid-source"> Fluid Lab</a> — the difference here is that any of them (including
        the colour channels) can be driven by a signal over the clip instead of being fixed.
      </p>
    </>
  );
}
