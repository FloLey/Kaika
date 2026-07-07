import { useEffect } from "react";

// Every section/anchor id in this guide — the set a "?" deep-link (`/?doc=<id>`) can
// target. The per-argument help catalog (lib/paramHelp.ts) links into these, and a test
// (paramHelp.test.ts) asserts both that this list matches the ids actually rendered here
// AND that every section a "?" references is in it — so a link can never point nowhere.
export const DOC_SECTION_IDS = [
  "getting-started",
  "projects",
  "upload",
  "review",
  "studio",
  "studio-features",
  "studio-shaping",
  "animation",
  "animation-modulators",
  "animation-points",
  "animation-sources",
  "assets",
  "animation-fx",
  "animation-combine",
  "animation-output",
  "export",
  "fluid-lab",
  "fluid-source",
  "fluid-medium",
  "tips",
] as const;

// In-app user guide. Rendered as its own root (see main.tsx) when the URL has
// ?doc=<section>, so every "?" in the app can open it in a new tab scrolled to
// the relevant section. Section ids are referenced by Info badges and the header
// help link — keep them in sync (guarded by DOC_SECTION_IDS + paramHelp.test.ts).
export default function Docs({ section }: { section?: string }) {
  useEffect(() => {
    const id = section || (window.location.hash || "").replace(/^#/, "");
    if (!id) return;
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ block: "start" });
  }, [section]);

  return (
    <div className="docs">
      <header className="docs-head">
        <h1>
          Kaika <span className="kanji">開花</span>
        </h1>
        <span className="sub">user guide</span>
        <a className="back" href="/">
          ← back to the app
        </a>
      </header>

      <p className="lead">
        Kaika splits a song into musical <strong>segments</strong> (intro, verse, chorus…) and lets
        you rework each one independently. You upload audio (or a YouTube link) and optional lyrics;
        the app separates the stems, proposes a structure, and opens a studio where every segment
        gets its own per-stem, per-frequency-band <strong>signal extraction</strong>. Everything
        autosaves, so you can close the tab and resume later.
      </p>

      <nav className="toc">
        <div className="toc-title">Contents</div>
        <ol>
          <li>
            <a href="#getting-started">Getting started</a>
          </li>
          <li>
            <a href="#projects">Projects &amp; resuming</a>
          </li>
          <li>
            <a href="#upload">Upload — file, YouTube, lyrics &amp; stems</a>
          </li>
          <li>
            <a href="#review">Review — the segment structure</a>
          </li>
          <li>
            <a href="#studio">Studio — extracting signals</a>
          </li>
          <li>
            <a href="#animation">Create animation — the node graph</a>
          </li>
          <li>
            <a href="#export">Final export — the whole track in HD</a>
          </li>
          <li>
            <a href="#fluid-lab">Playground &amp; the fluid card</a>
          </li>
          <li>
            <a href="#tips">Tips &amp; troubleshooting</a>
          </li>
        </ol>
      </nav>

      <section id="getting-started">
        <h2>
          <span className="num">1</span>Getting started
        </h2>
        <p>
          Kaika runs locally. Once it's installed (see the project
          <code>README.md</code>), one command starts everything: <code>make dev</code>. That
          launches Postgres, the Flask API on <code>:5000</code>, and the web UI on{" "}
          <code>:5173</code>. Open <code>http://localhost:5173</code> and you'll land on the{" "}
          <strong>Projects</strong> screen.
        </p>
        <p>The workflow has three stages, always in this order:</p>
        <ul>
          <li>
            <span className="stage">1</span>
            <strong>Upload</strong> — bring in audio + optional lyrics; the app separates stems.
          </li>
          <li>
            <span className="stage">2</span>
            <strong>Review</strong> — check and edit the proposed segment structure.
          </li>
          <li>
            <span className="stage">3</span>
            <strong>Studio</strong> — extract and shape a signal from each stem, per segment.
          </li>
        </ul>
        <div className="note">
          The <strong>?</strong> in the app's top-right corner opens this guide at the section for
          whatever screen you're on. The smaller <span className="pill">?</span>
          badges next to individual controls show a one-line explanation on hover, and clicking one
          jumps straight to the matching part of this guide.
        </div>
      </section>

      <section id="projects">
        <h2>
          <span className="num">2</span>Projects &amp; resuming
        </h2>
        <p>
          The Projects screen lists every track you've worked on, most recent first. Each row shows
          the title, source, and how far you got (Review or Studio).
        </p>
        <ul>
          <li>
            <strong>+ new track</strong> — start a fresh upload.
          </li>
          <li>
            <strong>Open a project</strong> — click a row to jump back to where you left off; your
            segments and per-segment edits load exactly as you saved them.
          </li>
          <li>
            <strong>Delete</strong> — removes the project <em>and</em> its audio, stems, and
            spectrograms from disk. This can't be undone.
          </li>
          <li>
            <strong>🎮 playground</strong> — opens the always-present{" "}
            <a href="#fluid-lab">Playground</a> sandbox (one segment per card).
          </li>
        </ul>
        <p>
          Work is saved automatically as you go, so there is no “save” button — just leave when
          you're done.
        </p>
      </section>

      <section id="upload">
        <h2>
          <span className="num">3</span>Upload — file, YouTube, lyrics &amp; stems
        </h2>
        <p>
          This is where a track enters the studio. You provide one source of audio, plus optional
          lyrics.
        </p>

        <h3>Audio source</h3>
        <ul>
          <li>
            <strong>Drop a file</strong> — drag an audio file onto the drop zone, or click to pick
            one (mp3, wav, flac, m4a, ogg…).
          </li>
          <li>
            <strong>YouTube URL</strong> — paste a link and the app downloads the audio. The video
            title becomes the project name.
          </li>
        </ul>

        <h3>Lyrics (optional, but recommended)</h3>
        <p>
          Paste lyrics into the text box or upload a <code>.txt</code> or
          <code>.lrc</code> file. Lyrics dramatically improve the segment structure: the app aligns
          the words to the actual singing (using Whisper) so it can tell a repeated <em>chorus</em>{" "}
          from a unique <em>verse</em> and find the instrumental gaps between them. Plain text is
          fine — section markers like
          <code>[Chorus]</code> and ad-lib asides in parentheses are ignored automatically.
          Timestamped <code>.lrc</code> files are used as-is.
        </p>

        <h3>What happens next</h3>
        <p>
          When you submit, the app runs <strong>Demucs</strong> (on the Apple-Silicon GPU when
          available) to separate the song into stems, and renders a spectrogram for each. This is
          the slow step — expect a wait proportional to the track length. The five stems are:
        </p>
        <table>
          <tbody>
            <tr>
              <th>Stem</th>
              <th>What it is</th>
            </tr>
            <tr>
              <td>original</td>
              <td>The untouched full mix you uploaded.</td>
            </tr>
            <tr>
              <td>vocals</td>
              <td>Isolated lead and backing vocals.</td>
            </tr>
            <tr>
              <td>drums</td>
              <td>The drum kit — kick, snare, hats, cymbals, toms.</td>
            </tr>
            <tr>
              <td>bass</td>
              <td>Bass guitar / synth bass and low end.</td>
            </tr>
            <tr>
              <td>other</td>
              <td>Everything else — keys, guitars, strings, synths, FX.</td>
            </tr>
          </tbody>
        </table>
        <div className="note">
          The very first separation downloads the Demucs model weights (~80&nbsp;MB) and the first
          lyric alignment downloads a Whisper model. These one-time downloads happen automatically;
          later runs are faster.
        </div>
      </section>

      <section id="review">
        <h2>
          <span className="num">4</span>Review — the segment structure
        </h2>
        <p>
          Before the studio, the app proposes a split of the song into labelled sections and lets
          you correct it. You see the full-mix spectrogram with the vocal-activity envelope and
          aligned lyrics drawn over it, plus coloured bands marking each proposed segment.
        </p>

        <h3>How the structure is proposed</h3>
        <p>The app combines several signals, in order of trust:</p>
        <ul>
          <li>
            <strong>Lyrics alignment</strong> — when you supplied lyrics, Whisper transcribes the
            vocals and the words are matched to your lyric lines, so cuts land at the instrumental
            gaps between sung lines and repeated choruses are recognised.
          </li>
          <li>
            <strong>Vocal activity</strong> — the loudness of the vocals stem over time; used to
            find where singing starts and stops when there are no lyrics.
          </li>
          <li>
            <strong>Timbre clustering</strong> — groups the song into sections that <em>sound</em>{" "}
            alike, even in purely instrumental passages.
          </li>
          <li>
            <strong>Beat grid + LLM labelling</strong> — the app builds a per-bar table of energy,
            per-stem levels and lyrics and asks a local language model to name each section. If the
            model isn't available, it falls back to a built-in heuristic — the result is still
            sensible.
          </li>
        </ul>
        <p>Sections are labelled with the usual song-structure terms:</p>
        <p>
          <span className="pill">intro</span> <span className="pill">verse</span>{" "}
          <span className="pill">pre-chorus</span> <span className="pill">chorus</span>{" "}
          <span className="pill">bridge</span> <span className="pill">drop</span>{" "}
          <span className="pill">build</span> <span className="pill">break</span>{" "}
          <span className="pill">outro</span>
        </p>

        <h3>Editing the split</h3>
        <ul>
          <li>
            <strong>Play / seek</strong> — press play or click anywhere on the timeline to move the
            playhead.
          </li>
          <li>
            <strong>Add a cut</strong> — click <strong>✂ split at playhead</strong>, or double-click
            the timeline, to split a segment in two.
          </li>
          <li>
            <strong>Move a boundary</strong> — drag the handle between two segments to slide where
            one ends and the next begins.
          </li>
          <li>
            <strong>Relabel</strong> — pick a different label from the dropdown on any segment row.
          </li>
          <li>
            <strong>Merge</strong> — merge a segment into the one before it to remove a boundary.
          </li>
          <li>
            <strong>Play a segment</strong> — the play button on a segment row starts playback from
            that segment's start.
          </li>
        </ul>
        <p>
          When the structure looks right, press <strong>✓ validate split</strong> to open the
          Studio. You can always come back to Review later.
        </p>
      </section>

      <section id="studio">
        <h2>
          <span className="num">5</span>Studio — extracting signals
        </h2>
        <p>
          The Studio is where the real work happens. The idea: for any segment, pick a stem, isolate
          a <strong>frequency band</strong> inside it, and turn its movement into a clean{" "}
          <strong>0–1 curve</strong> — a “signal” you can shape precisely. One song can carry many
          signals (a low-end thump from the bass, a vocal shimmer, a hi-hat tick…), each scoped to a
          single segment.
        </p>

        <h3>Layout</h3>
        <ul>
          <li>
            <strong>Segment rail</strong> (left) — every segment as a clickable chip with its time
            range and duration. Pick one to edit it; the rail can be collapsed to widen the
            workspace.
          </li>
          <li>
            <strong>Signal cards</strong> (main area) — grouped per stem. Each card is one signal:
            its spectrogram band selector, the extracted curve, a live pulse pad, and the shaping
            controls.
          </li>
        </ul>

        <h3>Choosing the band</h3>
        <p>
          Each card shows that stem's spectrogram for the current segment. Drag the two horizontal
          handles to set the low and high edge of the band you care about. The curve underneath
          updates live as you drag. (For the
          <em>beat phase</em> and <em>bar phase</em> features the band is ignored.)
        </p>

        <h3 id="studio-features">Feature — what the signal measures</h3>
        <p>
          The <strong>feature</strong> dropdown decides <em>what</em> about the band becomes the
          curve:
        </p>
        <table>
          <tbody>
            <tr>
              <th>Feature</th>
              <th>What it tracks</th>
            </tr>
            <tr>
              <td>energy</td>
              <td>Loudness of the band over time — the default driver.</td>
            </tr>
            <tr>
              <td>onset</td>
              <td>
                A spike on each hit in the band (add a tail with <em>release</em>). Great for
                discrete events.
              </td>
            </tr>
            <tr>
              <td>flux</td>
              <td>How fast the band is changing — its “busy-ness”.</td>
            </tr>
            <tr>
              <td>brightness</td>
              <td>Where the energy sits in the band (low = dull, high = bright).</td>
            </tr>
            <tr>
              <td>harmonic</td>
              <td>Tonal / sustained share vs percussive / noisy content.</td>
            </tr>
            <tr>
              <td>chroma</td>
              <td>Dominant pitch class in the band (stepped) — handy for driving colour.</td>
            </tr>
            <tr>
              <td>beat phase</td>
              <td>A 0→1 ramp locked to each beat (sawtooth). The band is ignored.</td>
            </tr>
            <tr>
              <td>bar phase</td>
              <td>A 0→1 ramp locked to each 4-beat bar. The band is ignored.</td>
            </tr>
          </tbody>
        </table>

        <h3 id="studio-shaping">Shaping the curve</h3>
        <p>
          Once the feature is chosen, these controls sculpt the raw signal into exactly the motion
          you want:
        </p>
        <table>
          <tbody>
            <tr>
              <th>Control</th>
              <th>Effect</th>
            </tr>
            <tr>
              <td>attack</td>
              <td>
                How fast the curve <em>rises</em> when the sound gets louder. Low = snaps up
                instantly; high = a gentle swell.
              </td>
            </tr>
            <tr>
              <td>release</td>
              <td>
                How fast the curve <em>falls</em> when the sound quietens. Low = drops instantly;
                high = a long smooth tail.
              </td>
            </tr>
            <tr>
              <td>gamma</td>
              <td>
                Contrast. Above 1 emphasises peaks (only the loud moments register); below 1 lifts
                the quiet detail.
              </td>
            </tr>
            <tr>
              <td>thresh</td>
              <td>
                Gate: ignore everything below this level so the signal reacts only to strong hits,
                not background.
              </td>
            </tr>
            <tr>
              <td>gain</td>
              <td>Scales the whole curve up or down (multiplies the value).</td>
            </tr>
            <tr>
              <td>offset</td>
              <td>
                Shifts the whole curve up or down (adds a constant) — e.g. so it never quite reaches
                zero.
              </td>
            </tr>
            <tr>
              <td>invert</td>
              <td>
                Flips it: loud → low instead of loud → high. Invert + slow attack + fast release
                gives the classic sidechain pump (drops on the kick, swells between).
              </td>
            </tr>
          </tbody>
        </table>

        <h3>Hearing &amp; seeing it</h3>
        <ul>
          <li>
            <strong>Curve view</strong> — the shaped 0–1 signal drawn over the segment, with a
            playhead. Click it to seek.
          </li>
          <li>
            <strong>Pulse pad</strong> — a live square whose dot scales and glows with the curve's
            value at the playhead, so you can <em>feel</em> the motion.
          </li>
          <li>
            <strong>Play one signal</strong> — the play button on a card auditions just that band;
            playing one pauses the others (solo).
          </li>
          <li>
            <strong>Play the whole segment</strong> — plays the full mix for the segment while every
            pulse pad animates together off the same clock.
          </li>
        </ul>
        <p>
          Add as many signals per stem as you need, remove the ones you don't, and move between
          segments using the rail. Every change autosaves.
        </p>
      </section>

      <section id="animation">
        <h2>
          <span className="num">6</span>Create animation — the node graph
        </h2>
        <p>
          The Studio has two tabs, switched by the bar at the bottom of the workspace:{" "}
          <strong>extract signals by track</strong> (everything above) and{" "}
          <strong>create animation</strong>. The animation tab is a drag-and-drop
          <strong> playground</strong> where you wire a segment's signals into a fluid simulation to
          produce a looping video that reacts to the music. Each segment has its own graph, and it
          autosaves like everything else.
        </p>

        <h3>The cards</h3>
        <p>
          The palette (top-left of the canvas) groups cards into category buttons —{" "}
          <strong>Sources</strong> (signal, colour), <strong>Modulators</strong> (the value cards),{" "}
          <strong>Points</strong> (source positions for a fluid), <strong>Generators</strong> (fluid,
          image, video, slideshow, image gen, backdrop, lyrics), <strong>Compositing</strong>,{" "}
          <strong>Output</strong> (in data-flow order). Open a category
          and <strong>hover any item</strong> for a tip describing what it does and what it takes in
          → puts out, then click to drop it. The canvas has <strong>two views</strong>, switched
          from the toolbar: <strong>▦ detailed</strong> (the default — every card shows its full
          controls) and <strong>▤ compact</strong> (just the name, a small live preview, and one
          input + one output dot). In compact view, <strong>click a card's body</strong> to open
          its settings window (all the controls, editing the graph live — <kbd>Esc</kbd> or a
          click outside closes it). Every card gets a <strong>default name</strong> (its type plus
          a counter — <em>fluid 1</em>, <em>fluid 2</em>…); <strong>double-click the title</strong>{" "}
          to rename it (on the canvas or in its settings window), so you can find it again by name in
          every input dropdown. The <strong>▢/–</strong> button in a card's title bar
          overrides the view for that one card (switching views clears the overrides). Every card
          has a <strong>✕</strong> in its top-right corner to delete it (which also removes its
          wires). The <em>output</em> card is the one exception — its body is the live render
          preview, so it always shows in full.
        </p>
        <p>
          Three more canvas tools: the canvas <strong>opens fitted</strong> (every card framed in
          view), and <strong>⊙ fit</strong> (toolbar, or <strong>double-click empty canvas</strong>)
          re-fits it any time — the rescue move when a card was dragged off-screen.{" "}
          <kbd>Cmd</kbd>+<kbd>Z</kbd> /{" "}
          <kbd>Shift</kbd>+<kbd>Cmd</kbd>+<kbd>Z</kbd> <strong>undo/redo</strong> graph edits
          (wires, cards, knob drags — a whole slider drag reverts as one step; typing in a text
          field keeps its own undo). And when the graph contains <strong>dead wiring</strong> that
          would render silently wrong — a gate with no input (a flat 0), a wired port whose lo–hi
          range collapsed to zero width (the signal is flattened, so e.g. a slideshow trigger never
          fires), an output with no input, a stale ★ final mark — a{" "}
          <strong>⚠ problems</strong> chip appears in the toolbar; click a row to jump straight to
          the offending card.
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
                Exposes one of this segment's signals (from the other tab) as a 0–1 curve, with a
                live pulse pad so you can see it move. Pick which signal from the{" "}
                <strong>+ Signal</strong> menu. One output.
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
                animatable parameter — force, vorticity, emit, the red/green/blue colour channels, …
                — is an <strong>input port</strong>, grouped into collapsible{" "}
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
                A non-fluid <strong>video source</strong> (
                <a href="#animation-sources">see below</a>): <em>lyrics</em> burns the segment's
                aligned lyrics into the video. It gives a video out.
              </td>
            </tr>
            <tr>
              <td>slideshow · image gen</td>
              <td>
                A <strong>slideshow</strong> switches between several images on a trigger signal
                (<a href="#animation-sources">see below</a>); an <strong>image gen</strong> card
                generates images locally — one per prompt — and feeds them into a slideshow via
                its <em>images</em> wire.
              </td>
            </tr>
            <tr>
              <td>image · video</td>
              <td>
                Layer an <strong>uploaded picture or clip</strong> into the frame (
                <a href="#animation-sources">see below</a>): drop a file on the card (or pick from
                the <a href="#assets">📚 library</a>; the video card can also import from YouTube),
                place it with the box, choose how it fills, and stack it with fluids in a{" "}
                <em>layered</em> combine. Each gives a video out.
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
                Composes several fluids into one (see below): <em>merge</em> = their sources share
                one simulation and interact; <em>layered</em> = the inputs are stacked with
                per-input transparency. Dynamic inputs (a <strong>+ input</strong> button), one
                video output.
              </td>
            </tr>
            <tr>
              <td>output</td>
              <td>
                Shows the rendered looping video — wire a fluid's (or combine's) video output into
                it. It also <strong>passes its input through</strong> (a video out port), so you can
                preview a stream <em>and</em> feed it onward. You can have several independent
                fluid/combine → output pipelines in one graph.
              </td>
            </tr>
          </tbody>
        </table>

        <h3>Wiring &amp; the [lo, hi] range</h3>
        <ul>
          <li>
            <strong>Connect (detailed view)</strong> — drag from a card's output dot onto a specific
            input port (or a fluid's video output onto the output card). You can also <strong>drop
            the wire anywhere on a card</strong>: when the destination is obvious (an output's video
            input, a combine's free slot, a fluid's positions, a card with a single free port) it
            wires itself; otherwise the line parks on the card in <strong>gray</strong> — connected,
            but not assigned to a port yet.
          </li>
          <li>
            <strong>Connect (compact view)</strong> — a compact card shows one input dot standing in
            for <em>all</em> its inputs, so a wire dropped on it can't know which one you mean: it
            <strong> always parks gray</strong>. Open the card (click its body) and use each input's
            dropdown to assign it. The dropdown has <strong>three sections</strong>: the gray wires
            waiting on this card (<em>connected — unassigned</em>) on top, then sources already wired
            to one of this card's inputs (<em>connected</em>), then <em>other</em> candidates. Pick
            one and the gray line goes live. Choosing <em>— none —</em> sends a wire back to gray so
            you can re-route it without redrawing it.
          </li>
          <li>
            <strong>Compact cards keep their wires</strong> — every assigned inbound wire converges
            on the single left dot and the output leaves from the single right dot. Expand the card
            (▢) to wire a specific port directly.
          </li>
          <li>
            <strong>Animate a parameter</strong> — when a <em>signal</em> drives a parameter, its
            0–1 curve is mapped into a <strong>[lo, hi]</strong> range you set right on that port.
            So a kick-energy signal on <em>force</em> with range 0–45 makes the jet punch on every
            kick. Set lo and hi to taste; detach with the ✕.
          </li>
          <li>
            <strong>Steady values</strong> — an un-wired port just holds a steady value (its slider)
            in the parameter's native range.
          </li>
          <li>
            <strong>Move / delete</strong> — drag a card by its title bar; pan the canvas by
            dragging the background and zoom with the scroll wheel. Delete a card with its ✕, or
            select a card/wire and press Delete.
          </li>
          <li>
            <strong>Select several at once</strong> — <kbd>Shift</kbd>- or <kbd>⌘</kbd>-click cards
            to add them to the selection, or <kbd>Shift</kbd>-drag a box across the background to
            grab everything inside it. Then drag any selected card to <strong>move the whole group
            in one go</strong>, or press Delete to remove them all. Click an empty spot to clear the
            selection.
          </li>
        </ul>
        <p>
          The fluid parameters are the same ones documented under
          <a href="#fluid-source"> Fluid Lab</a> — the difference here is that any of them
          (including the colour channels) can be driven by a signal over the clip instead of being
          fixed.
        </p>

        <h3 id="animation-modulators">Shaping &amp; generating signals — modulator cards</h3>
        <p>
          A <em>signal</em> card is the only source of a 0–1 curve, but the{" "}
          <strong>modulator</strong> cards let you build new curves from it (or from nothing) right
          in the graph — so you don't have to bake every choice into the studio. They all output a
          value you wire into a fluid port (or into another modulator).
        </p>
        <ul>
          <li>
            <strong>Math</strong> — combines two or more signals: <em>multiply</em> to gate one by
            another (e.g. vocals × the beat), <em>max</em> to floor a curve under an LFO,{" "}
            <em>add/subtract</em>, or <em>mix</em> to crossfade. Use <strong>+ input</strong> for
            more.
          </li>
          <li>
            <strong>LFO</strong> — a sine / triangle / saw / square oscillator that needs no audio:
            steady drift or pulsing. Set its rate in <em>cycles per clip</em> or <em>Hz</em>, plus a
            phase offset.
          </li>
          <li>
            <strong>Noise</strong> — smooth, organic random wander where an LFO would feel
            mechanical. It's <strong>seeded</strong>, so a given seed always renders the same.
          </li>
          <li>
            <strong>Shaper</strong> — re-curves one signal (attack/release, threshold, gamma,
            gain/offset, invert, and an output [lo, hi] remap) <em>per use</em>, so you can reuse a
            single studio signal sharply on one port and softly on another. The little graph on the
            card previews the shape. <em>Delay</em> slides the signal later in time (in ms): the
            exposed head is silent by default, or tick <em>wrap</em> to loop the tail back to the
            start. To build a <strong>heartbeat</strong>, fan one beat signal out — feed it straight
            into a <em>math</em> card set to <em>add</em>, and also through a shaper with a short{" "}
            <em>delay</em> and a lower <em>gain</em> into the same math card — the delayed, weaker
            copy lands just after each beat as the second thump.
          </li>
          <li>
            <strong>Gate</strong> — turns any signal into a clean <strong>0/1 switch</strong>: 1
            while the input is above the <em>threshold</em>, 0 below it. The <em>hysteresis</em>{" "}
            band (centred on the threshold) keeps a hovering signal from flickering — the gate only
            releases once the input falls below the band. Two <strong>thinners</strong> cut down how
            often it spikes: <em>min gap</em> drops any spike that lands within N seconds of the last
            kept one (caps the rate by time), and <em>divide</em> keeps only every Nth spike (1/N — a
            divider off the input's own rate); combine them to, say, advance a slideshow at most once
            a second and only on every other beat. Use the gate to drive on/off-style ports: an{" "}
            image generator's <em>trigger</em>, a fluid's <em>emit</em>, a lyrics <em>opacity</em>.{" "}
            <em>invert</em> flips it.
          </li>
          <li>
            <strong>Scope</strong> — a monitor: wire any value into it (an lfo, signal, noise,
            math…) and it shows that value on a live sparkline + pulse pad, exactly like the signal
            card. It <em>passes the value straight through</em>, so you can splice it inline
            (<em>lfo → scope → fluid</em>) or just hang it off a value to confirm it's moving.
          </li>
        </ul>

        <h3 id="animation-points">Placing sources — the points card</h3>
        <p>
          By default a fluid emits from a single source in the centre. The
          <strong>points</strong> card lets you place sources wherever you like: drop a{" "}
          <strong>+ Points</strong> card, <strong>click</strong> its canvas to add a point,{" "}
          <strong>drag</strong> a dot to move it, <strong>double-click</strong>a dot to remove it.
          Then wire the card's output into a fluid's
          <strong> positions</strong> input (the dot on the fluid's left edge). The fluid now emits{" "}
          <strong>one source at every point</strong> — all sharing the fluid's colour, force, emit,
          etc. (and any signal modulation), just at different places. The card shows the project's
          aspect ratio so points land where you draw them.
        </p>
        <p>
          You don't have to place points by hand. Two more cards generate and transform a points set
          (wire them into a fluid's <strong>positions</strong> just like the points card):
        </p>
        <ul>
          <li>
            <strong>Pattern</strong> — a parametric layout (<em>circle, ring, grid, line, spiral,
            scatter</em>) with a count, radius and rotation. <em>offset x/y</em> shift the whole
            layout off-centre, so a figure needn't sit in the middle. The card previews the dots it
            makes.
          </li>
          <li>
            <strong>Animate points</strong> — takes a points set and moves it over the clip:{" "}
            <em>orbit</em> circles each source around the centre; <em>drift</em> slides them along a
            heading and loops back; <em>chase</em> keeps them put and runs a lit snake around the set.
          </li>
          <li>
            <strong>Merge points</strong> — concatenates two or more points sets into one. Wire a
            Pattern/Points/Animate card into each input (<strong>+ input</strong> for more) and its
            output into a fluid's <strong>positions</strong> — e.g. two offset Pattern rings combined
            into a single emitter set.
          </li>
        </ul>
        <div className="note">
          Chain them — e.g. <em>pattern → animate → fluid positions</em>, or{" "}
          <em>pattern + pattern → merge → fluid positions</em> — for richer source sets. A points
          pipeline is capped at 64 sources.
        </div>

        <h3 id="animation-sources">Other video sources — lyrics, image, video &amp; backdrop</h3>
        <p>
          Not every layer has to be a fluid. These cards synthesise a video stream you can stack with
          fluids (in a <em>layered</em> combine) or send straight to an output:
        </p>
        <ul>
          <li>
            <strong>Backdrop</strong> — fills the whole frame with a solid <em>colour</em> (a swatch),
            output as a video layer. Wire it into the <strong>bottom</strong> input of a{" "}
            <em>layered</em> combine to get a non-black background behind everything above it (the
            render otherwise flattens onto black). Opacity is modulatable.
          </li>
          <li>
            <strong>Image</strong> — layers an uploaded picture into the frame.{" "}
            <strong>Drop a file</strong> on the card (or click it to browse, or pick from the{" "}
            <a href="#assets">📚 library</a>); drag the <em>placement box</em> to position it and
            pull a corner to size it, then choose how the picture fills the box: <em>cover</em>{" "}
            (fill + crop), <em>contain</em> (fit inside, transparent letterbox), or <em>stretch</em>.
            Opacity is modulatable — wire a signal to fade it with the music.
          </li>
          <li>
            <strong>Slideshow</strong> — a set of stills that <strong>switches</strong> to the
            next image every time its <em>trigger</em> signal rises past the <em>threshold</em>{" "}
            (wrapping back to the first). Images come from drops/uploads, the{" "}
            <a href="#assets">📚 library</a>, <em>and</em> anything wired into its{" "}
            <em>images</em> input (an Image gen card). The card shows a live counter — how many
            images it holds and how many times it will switch this segment. The{" "}
            <em>hysteresis</em> band stops a hovering signal from machine-gunning; you control
            exactly <em>when</em> it switches by shaping the trigger (e.g. through a{" "}
            <a href="#animation-modulators">gate</a>). Same box/fit placement as the image card;{" "}
            <em>opacity</em> is modulatable too.
          </li>
          <li>
            <strong>Image gen</strong> — a pure <strong>generator</strong>: write{" "}
            <em>one prompt per image</em> (the card shows how many it will make), set a seed, pick a{" "}
            <em>model</em>, and <strong>✨ generate</strong> runs it fully locally. While building,
            the ✨ makes <strong>fast, low-res drafts</strong> so the canvas stays responsive — the{" "}
            <em>model</em> dropdown chooses which model does that: <code>SD-Turbo</code> (~2 GB,
            near-instant) or <code>Z-Image-Turbo</code> (a ~33 GB HD model, minutes per image). The{" "}
            <a href="#export">final export</a> then <strong>regenerates every image fresh in HD</strong>{" "}
            (Z-Image) automatically, at your project's aspect and the export's{" "}
            <em>HD image size</em> — so drafts stay fast and the master stays crisp. Images generate
            at the <strong>project aspect</strong> (not a fixed square) and are seeded — the same
            prompts + seed + size reproduce the same image — and land in the{" "}
            <a href="#assets">library</a>. It makes no video itself: wire its <em>images</em>{" "}
            output into a Slideshow card to show them.
          </li>
          <li>
            <strong>Video</strong> — same box/fit/library as the image card, for a clip. Extra ways
            in: <strong>import from YouTube</strong> right on the card (paste a URL). Timing
            controls: <em>sync</em> (<em>song</em> keeps a background clip phase-continuous across
            segments; <em>segment</em> restarts it at each cut), a <em>start</em> offset into the
            source, and <em>loop</em> (off = the last frame holds). Both <em>opacity</em> and{" "}
            <em>speed</em> are modulatable — a signal on <em>speed</em>{" "}
            <strong>time-warps the clip</strong> (slow-motion in the quiet bars, whip-fast on the
            drop).
          </li>
          <li>
            <strong>Lyrics</strong> — burns this track's <strong>aligned lyrics</strong> into the
            frame, timed to the vocal (the same alignment the review screen uses). Pick a{" "}
            <em>font</em>, an <em>alignment</em> and <em>case</em>, and <em>line</em> vs <em>word</em>{" "}
            reveal (word fills the line in as it's sung). Drag the <em>text box</em> to place it and
            pull a corner to size it — the text word-wraps and fills the box (the box defines size +
            placement). A black <em>outline</em> keeps it readable over anything. Wire a{" "}
            <a href="#animation-fx">color card</a> into the <em>fill</em> or <em>outline</em> input to
            recolour the text (defaults: white fill, black outline) — the outline stays opaque so it
            keeps occluding the video. Opacity is modulatable. Needs lyrics on the track.
            <br />
            <strong>✎ edit lines</strong> (on the card) edits each line's <em>words</em> and its{" "}
            <em>start/end time</em> (as <code>m:ss.cc</code>). For covers and rewritten lyrics,
            upload the <em>original</em> lyrics first so the alignment locks to the vocal, then swap
            in your new words line by line (uploading different words directly won't align — the
            timing comes from matching what is actually sung). When the automatic timing is off — or
            there were no lyrics to align to — nudge each line's times by hand.
          </li>
        </ul>

        <h3 id="assets">The asset library — 📚</h3>
        <p>
          Every image or video you bring in lands in the project's <strong>asset library</strong>.
          Open it with the <strong>📚 assets</strong> button in the bar at the bottom of the Studio,
          or from any image/video card's <strong>📚 library</strong> button to pick an existing
          asset instead of re-uploading.
        </p>
        <ul>
          <li>
            <strong>One copy, many cards.</strong> Files are stored by content, so uploading the
            same file twice (even on different cards) keeps a single copy, and several cards can
            reference the same asset.
          </li>
          <li>
            <strong>Adding.</strong> Drop a file on an image/video card, browse from the card, or
            import a YouTube video from the video card — all of them register the asset in the
            library automatically.
          </li>
          <li>
            <strong>Deleting.</strong> Remove an asset from the library manager (🗑). Cards that
            still reference it will render an empty (transparent) layer, so delete freely — the
            worst case is a see-through spot where the picture was.
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

        <h3 id="animation-combine">Combining fluids</h3>
        <p>
          A <strong>combine</strong> card composes several fluids into one. Wire each fluid's video
          output into one of the combine's inputs (use <strong>+ input</strong>
          for more), then wire the combine's output into an output card. It has two modes:
        </p>
        <table>
          <tbody>
            <tr>
              <th>Mode</th>
              <th>What it does</th>
            </tr>
            <tr>
              <td>merge</td>
              <td>
                The inputs' sources are dropped into <strong>one shared simulation</strong>, so the
                fluids physically interact (their dye and flow mix). The combine card carries the
                shared <em>medium</em> (dissipation / viscosity / vorticity); each input fluid
                contributes only its emitter (colour, force, position, and any signal modulation).
              </td>
            </tr>
            <tr>
              <td>layered</td>
              <td>
                Each input is rendered separately and the clips are{" "}
                <strong>stacked with transparency</strong>. Every input has an <em>opacity</em>{" "}
                slider; a brighter upper layer covers what's beneath it, empty areas let lower
                layers show through. Input order = top → bottom, so the{" "}
                <strong>bottom input is your background</strong> — put a{" "}
                <a href="#animation-sources">Backdrop</a> card there for a solid colour.
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          Inputs can be a fluid, another combine, or an <strong>output</strong> (its pass-through
          port) — so you can preview a stream and also feed it into a combine. (A <em>layered</em>{" "}
          combine can't feed a <em>merge</em> — a stacked video has no single source to merge — the
          card will tell you.)
        </p>

        <h3>Rendering — it's automatic</h3>
        <p>
          There's no render button: the clip <strong>re-renders on its own</strong>
          (debounced) whenever you change the graph or a signal, and the result drops into the
          output card. The clip always spans the <strong>full segment</strong>. An incomplete graph
          (no output wired yet) just waits quietly; a real failure shows an error on the output
          card. Identical renders are cached, so repeats are instant.
        </p>
        <p>
          Use the <strong>transport</strong> at the top of the workspace (shared with the signals
          tab) to preview: <strong>▶ play segment</strong> plays the audio while the output video
          and every pulse pad animate off the same playhead; drag the <strong>timeline</strong> to
          scrub, set the
          <strong>🔊 volume</strong> (the simulation keeps running at any level), and toggle{" "}
          <strong>loop</strong>.
        </p>
        <p>
          Built a pipeline you like? The <strong>⧉ copy ‹prev│next›</strong> control (in the
          transport bar) copies the whole card layout onto the adjacent segment — and rewires its
          signal cards onto that segment's own signals (cloning any it's missing), so the copy reacts
          to the right audio, not the source segment's. Each side is disabled at the ends of the
          track (no segment on that side).
        </p>

        <h3 id="animation-output">Output settings</h3>
        <p>
          The <strong>⚙ output</strong> button opens project-wide render settings (they apply to
          every segment's animation):
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
      </section>

      <section id="export">
        <h2>
          <span className="num">7</span>Final export — the whole track in HD
        </h2>
        <p>
          When every segment's animation is ready, render the <strong>whole track</strong> as one
          continuous HD video (with the original audio muxed in). Two steps:
        </p>
        <ul>
          <li>
            <strong>Mark each segment's final output.</strong> On the animation tab, every output
            card carries a <strong>☆ mark final</strong> button — click it (it turns{" "}
            <strong>★ final</strong>) on the output you want exported for that segment. One per
            segment; the export screen shows a checklist of any segment still unmarked.
          </li>
          <li>
            <strong>Render.</strong> The <strong>Final export ▸</strong> button (top of the Studio)
            opens the export stage. Set the <em>size</em> — its <strong>aspect ratio is locked to
            your canvas</strong> (the editor's ⚙ output orientation), so you only pick the resolution
            and the export keeps the exact shape you built for; editing one side scales the other.
            Also set <em>fps</em>, <em>detail / grid</em> (simulation cells — higher is sharper and slower),
            and the <em>audio</em>: the <strong>original</strong> full mix, or{" "}
            <strong>instrumental</strong> — the separated stems minus the vocal, for covers and
            karaoke (the studio transport follows the same choice, so you build against the track
            you'll ship). Then generate: the render streams progressively — a growing preview plays
            while it works — and finishes with a <strong>download</strong> link.
          </li>
        </ul>
        <div className="note">
          The export is <strong>not</strong> the segment previews stitched together: the fluid
          simulation runs <strong>continuously across segment boundaries</strong> (each layer's
          velocity and dye carry through the cut; only the wiring rules swap), so transitions are
          seamless. Cards that share a <em>layer</em> number across segments continue into each
          other; a layer absent in a segment keeps drifting and fades. Like the previews, un-dyed
          pixels are black — backdrops are layers.
        </div>
      </section>

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
          At the heart of most pipelines is the <strong>fluid</strong> card — a real-time fluid
          simulation. A source injects coloured dye and pushes the fluid around; the result renders
          to a short looping video. Every control below is a port you can drive with a signal, and
          each carries a <strong>?</strong> in the card that links back here. The controls group into
          the <em>source</em> (the emitter) and the <em>medium</em> (how the fluid flows).
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
          The clip always spans the full segment and loops seamlessly. Identical settings are
          cached, so re-rendering the same look is instant.
        </p>
      </section>

      <section id="tips">
        <h2>
          <span className="num">9</span>Tips &amp; troubleshooting
        </h2>
        <ul>
          <li>
            <strong>First run is slow.</strong> The first separation downloads the Demucs weights
            and the first lyric alignment downloads a Whisper model. After that, models are cached
            and only the audio processing takes time.
          </li>
          <li>
            <strong>Lyrics give the best structure.</strong> If the proposed segments look off, the
            single biggest improvement is adding lyrics on upload — even rough plain text.
          </li>
          <li>
            <strong>No language model? No problem.</strong> Section labelling prefers a local LLM
            (Ollama), but if it isn't running the app falls back to a heuristic and still proposes a
            full structure. You can always relabel by hand in Review.
          </li>
          <li>
            <strong>GPU.</strong> On Apple Silicon, separation uses the Metal (MPS) GPU
            automatically; elsewhere it runs on CPU (slower but identical results).
          </li>
          <li>
            <strong>Nothing is lost.</strong> Edits autosave continuously. Close the tab whenever
            you like and reopen the project from the Projects screen to pick up where you stopped.
          </li>
          <li>
            <strong>Deleting is permanent.</strong> Deleting a project also removes its audio, stems
            and spectrograms from disk — there's no undo.
          </li>
        </ul>
      </section>

      <footer className="docs-foot">
        Kaika — local stem separation, LLM-assisted segmentation, and per-segment signal extraction.{" "}
        <a href="/">← back to the app</a>
      </footer>
    </div>
  );
}
