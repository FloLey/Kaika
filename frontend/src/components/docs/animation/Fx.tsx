// Part of the guide's `animation` section (cleanup step 13 split an 842-line file).
// A fragment, not a <section>: the h3 anchor ids inside are deep-link targets that
// paramHelp.test.tsx checks against DOC_SECTION_IDS, so they must render unchanged.
export default function Fx() {
  return (
    <>
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
              slider; a brighter upper layer covers what's beneath it, empty areas let lower layers
              show through. Input order = top → bottom, so the{" "}
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

      <h3 id="animation-montage">Montage — cutting clips to the beat</h3>
      <p>
        The <strong>montage</strong> card (Compositing) is made for recap videos: a pile of little
        clips cut to a song's rhythm. It holds N ordered <strong>slots</strong>, each fed by a{" "}
        <a href="#animation-sources">Video</a> card (with any FX in between). The{" "}
        <strong>trigger</strong> port decides the cuts: each rising edge past the threshold switches
        to the next slot, and that slot's input is <strong>re-timed to start at the cut</strong> —
        so the clip begins exactly at its in-point, on the beat. Slot 1 plays from the segment
        start; when the cuts run out of inputs, the <strong>last input holds</strong> to the end of
        the segment. A slot's <strong>×N</strong> button makes it swallow N cuts — its video plays
        through N gate intervals before the montage moves on, so one longer clip can cover two beats
        while the rest keep cutting fast.
      </p>
      <p>
        The musical wiring: add a <strong>signal</strong> card (beat, or a drum onset), feed it
        through a <a href="#animation-modulators">gate</a> — its <em>divide</em> keeps every Nth
        pulse, so <em>divide 4</em> cuts every fourth beat — and wire the gate into the montage's{" "}
        <em>trigger</em>. To cut on musical <em>transitions</em> instead of a steady beat, insert a{" "}
        <strong>change</strong> card before the gate (signal → change → gate): the gate then fires
        when the music <em>shifts</em>, not when it's merely loud. Each slot row shows its{" "}
        <strong>start – end window</strong> in segment seconds (computed from the trigger), so you
        can read the timeline straight off the card. Pick <em>where</em> each clip starts with the
        🎞 in-point picker on its video card; the montage takes care of the length.
      </p>
      <p>
        <strong>Building the rig in one click — + fill.</strong> Once the trigger is wired, the card
        knows how many cuts the segment makes, so <strong>+ fill</strong> does the whole setup: it
        adds however many slots the cut count calls for, then drops an <em>empty video card</em> on
        every unwired slot, already wired in. All that's left is dropping a clip on each (or picking
        one with its 📚). The new cards land in a column beside the montage — ✨ arrange tidies them
        further. Without a trigger the cut count is unknown, so it only fills the slots you've added
        yourself. The reverse gesture exists too: from the <a href="#assets">asset library</a>,
        clicking a clip drops its card on the canvas.
      </p>
      <p>
        Each slot's clip always starts at <strong>its in-point</strong> when the cut lands — a video
        card's <em>sync</em> setting is ignored inside a montage, since the montage owns the timing
        (otherwise a clip shorter than the segment's position in the song would sit frozen on its
        last frame). Its preview on the card free-runs for the same reason.
      </p>
      <p>
        <strong>Two warnings per row, and a total on the card.</strong> <strong>⚠ −1.2s</strong>{" "}
        means the clip is shorter than its slot — from its in-point there isn't enough material.
        With <em>loop</em> on it replays from the in-point; with <em>loop</em> off{" "}
        <strong>the slot goes black</strong> for the missing seconds, which is deliberate: a frozen
        still reads as a broken render, black reads as "you are short here". The card's header
        totals it (<strong>⚠ 1 slot short — 1.2s black</strong>) because a badge on one row out of
        thirty is not a warning anyone finds — a real export shipped with 1.2s of black in it for
        exactly that reason. <strong>⧉ 3</strong> means this slot plays a clip slot 3 already used:
        from the same in-point the two play <em>identical frames</em>, which on screen looks like
        the video looping rather than cutting — the badge turns red for that case, and stays grey
        when the in-points differ (another moment of the same footage, often deliberate). Both are
        read-offs, not errors: nothing stops you.
      </p>
      <p>
        <strong>Reading the order off the canvas.</strong> Hit <strong>✨ arrange</strong> and the
        clips are stacked in slot order, slot 1 at the top, right of their montage — so the column
        reads exactly as the film plays and no wire crosses another. Arrange is layout only: it
        never re-orders the slots themselves.
      </p>
      <p>
        One rule: a card feeding a montage slot can't <em>also</em> feed something else (another
        slot, a combine, an output) — the montage restarts its inputs' clocks, so a shared card
        would be pulled two ways. Duplicate the card instead; the editor tells you when this
        happens.
      </p>

      <h3 id="animation-transform">Transform — warping the video</h3>
      <p>
        The <strong>transform</strong> card (Compositing) takes a video stream and warps it: drop it
        between any producer (a fluid, a combine) and whatever consumes it. Its{" "}
        <strong>zoom</strong>, <strong>rotate</strong>, <strong>pan x</strong> and{" "}
        <strong>pan y</strong> are modulatable ports — wire <em>rotate</em> to a signal and the
        whole frame spins on the beat, or wire <em>zoom</em> to a kick for a pulsing punch-in.
      </p>
      <p>
        Three <strong>modes</strong>: <em>transform</em> just pans/zooms/rotates; <em>mirror</em>{" "}
        reflects one half across the centre; <em>kaleidoscope</em> folds the frame into 2–12
        mirrored wedges (a classic music-video look — try it with a slow rotate). The two fold modes{" "}
        <strong>mirror the frame at its edges</strong>, so there are no black gaps at any rotation
        even on a tall or wide canvas. A plain <em>transform</em> is <strong>black</strong> outside
        the frame by default (which keeps the dye-on-black transparency intact for compositing);
        turn on <strong>wrap edges</strong> to tile the frame so it loops around seamlessly instead.
      </p>
      <p>
        A transform produces <em>frames</em>, not emitters, so it can feed an{" "}
        <strong>output</strong> or a <strong>layered</strong> combine — but not a <em>merge</em>{" "}
        (which needs the raw fluid sources to interact). Chain two transforms if you want, say, a
        kaleidoscope of a rotation.
      </p>

      <h3 id="animation-lookfx">Echo — motion trails</h3>
      <p>
        The <strong>echo</strong> card (Compositing) leaves fading trails behind anything that
        moves, with three kinds of memory. <strong>ghost</strong> (the default) mixes each frame
        with a fading afterimage of the recent past — every <em>change</em> lingers, whatever the
        contrast, so it works on real footage (a person running leaves translucent copies of
        themselves behind; the live frame always stays at least half visible).{" "}
        <strong>bright</strong> remembers only the <em>brightest</em> thing that passed through each
        pixel, at full brightness — comet tails for fluids and anything glowing on a dark background
        (black stays black, so compositing on top keeps working). <strong>dark</strong> is its
        mirror: a dark subject on a bright scene drags solid shadow trails while staying fully sharp
        itself — the pick for daylight footage.
      </p>
      <p>
        <strong>length</strong> is how long the trail lingers (its half-life, in seconds — 0
        switches the effect off); <strong>amount</strong> mixes between the untouched video and full
        trailing. Both are modulatable ports — wire <em>length</em> to a signal and the trails
        stretch on every hit, snapping back between them. Like the other FX cards it feeds an{" "}
        <strong>output</strong> or a <strong>layered</strong> combine, never a <em>merge</em>. In a
        whole-song export the trails start fresh at each segment cut. Try <em>bright</em> after a
        rotating kaleidoscope <strong>transform</strong> — it becomes a spirograph.
      </p>
      <p>
        The <strong>color grade</strong> card (Compositing) recolours the stream, three ways.{" "}
        <strong>thermal</strong> maps brightness through a heat-camera colormap (pick the{" "}
        <em>map</em>); <strong>duotone</strong> remaps everything onto a shadow→highlight two-colour
        ramp (the poster look); <strong>neon</strong> keeps only glowing edges on black. The grade
        colour can come from a wired <strong>color</strong> card on the <em>tint</em> input — a{" "}
        <em>gradient</em> colour card with its <em>position</em> bound to a signal makes the whole
        grade sweep colour with the music; unwired, the card's swatches apply.{" "}
        <strong>intensity</strong> fades the grade in and out and <strong>shift</strong> rolls the
        colormap / moves the duotone midpoint / rotates the neon hue — both are modulatable ports.
        Thermal (except <em>inferno</em>) and duotone recolour the black background too, so grade
        modes belong at the <strong>end</strong> of the chain (into the output, or the bottom layer
        of a stack).
      </p>

      <h3 id="animation-stylize">AI Stylize — restyle the fluid with diffusion</h3>
      <p>
        The <strong>AI Stylize</strong> card (Compositing) repaints the incoming fluid toward a text{" "}
        <strong>prompt</strong> using a local diffusion model — the fluid's motion drives the
        result, but its <em>look</em> becomes flowers, molten lava, storm clouds, whatever you type.{" "}
        <strong>strength</strong> is the img2img curseur (a modulatable port): near 0 keeps the
        fluid almost untouched, near 1 fully reinvents it; around 0.6–0.9 keeps the motion while
        changing the material. Turn on <strong>inpaint</strong> to confine the repaint to the
        fluid's shape (the black background stays untouched) instead of repainting the whole frame.
      </p>
      <p>
        Generation is expensive, so it doesn't run on every render: pick a <strong>model</strong>{" "}
        (SD-Turbo for fast drafts, Z-Image for slow HD) and hit <strong>✨ generate</strong>. The
        stylized clip is stored and played back; until you generate, the card simply passes the
        fluid through. Re-generate after changing the prompt, strength or inpaint to see the new
        take. HD is genuinely slow (~30&nbsp;s per frame): it has to generate at a higher resolution
        than the draft — below its floor the model paints blobs instead of subjects — so a whole
        clip takes tens of minutes. Iterate in draft, switch to HD when the look is right (the
        export regenerates in HD sharper still). You can safely close or reload the tab while it
        runs: the finished clip is saved onto the card server-side, so it's there when you come
        back.
      </p>
      <p>
        It works on <strong>any video</strong>, not just fluids — wire a Video card (an uploaded
        clip) in too. By default the output <strong>follows the input's shapes</strong> (a canny
        ControlNet is applied automatically on the draft model). To override that with a different
        control, drop an <strong>Extract</strong> card (Compositing) between the video and Stylize —{" "}
        <strong>canny</strong>, <strong>soft-edge</strong>, <strong>density</strong> (the input's
        brightness, best for fluids) or <strong>depth</strong> (a model, for real 3D footage) — and
        wire it into Stylize's <em>control</em> input. Wired control works on{" "}
        <strong>both models</strong>, and on both the <strong>strength</strong> slider still rules
        how far the result travels from the input.
      </p>
      <p>
        Worth knowing: a ControlNet <strong>guides</strong> the shapes but never{" "}
        <strong>confines</strong> the generation. On a wispy fluid — a control that's mostly black —
        guidance alone isn't enough, and the model happily fills the whole frame. What keeps the
        fluid's black background black is starting the generation <em>from the fluid</em>: that's
        exactly what <strong>strength</strong> does (lower = closer to the input). Turn on{" "}
        <strong>inpaint</strong> to pin it harder — only the fluid's own shape is repainted.
      </p>
    </>
  );
}
