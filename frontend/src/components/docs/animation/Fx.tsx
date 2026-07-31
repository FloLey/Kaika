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
        clips cut to a song's rhythm. Clicking its tile opens the <strong>montage editor</strong> —
        a full-screen surface of its own (a breadcrumb level: <em>segment ▸ montage</em>): the strip
        of extracts runs across the top (drag a tile to re-order; 🎬 swaps its clip), the live
        switched output plays large below, slaved to the transport — scrub and you see the extract
        under the playhead with the audio it will play under — and the trigger wiring + threshold
        sit on the right. It holds N ordered <strong>extracts</strong>, each playing a{" "}
        <strong>composition</strong> — a small animation of its own that ends in an output. The
        simplest composition is just a clip: <strong>+ video</strong> picks one from the{" "}
        <a href="#assets">asset library</a> and wraps it (video → output) for you. The cut schedule
        plays extract 1 from the window start; each cut switches to the next, its composition{" "}
        <strong>re-timed to start at the cut</strong> — a clip begins exactly at its in-point, on
        the beat. When the cuts outrun the extracts, the <strong>last one holds</strong> to the end.
        An extract's <strong>×N</strong> button makes it swallow N cuts, so one longer clip can
        cover two beats while the rest keep cutting fast. The same composition can appear in several
        extracts (or several montages) — edit it once and every reference follows.
      </p>
      <p>
        <strong>Where the cuts come from — two live sources.</strong> The <em>trigger</em> port is
        the musical one: add a <strong>signal</strong> card (beat, or a drum onset), feed it through
        a <a href="#animation-modulators">gate</a> — its <em>divide</em> keeps every Nth pulse, so{" "}
        <em>divide 4</em> cuts every fourth beat — and wire it into <em>trigger</em>; every rising
        edge past the threshold is a cut, recomputed live as you tune the signal. To cut on musical{" "}
        <em>transitions</em> instead of a steady beat, insert a <strong>change</strong> card before
        the gate. <strong>Manual breakpoints</strong> are the hand-placed ones; the montage cuts on
        the union of both, and any single gate cut can be <em>disabled</em> (it stays visible,
        greyed, so you can see where it came from — it just no longer cuts). Each extract row shows
        its <strong>start – end window</strong> in seconds, so you can read the timeline straight
        off the card.
      </p>
      <p>
        <strong>Two warnings per row, and a total on the card.</strong> <strong>⚠ −1.2s</strong>{" "}
        means the extract's clip is shorter than its window — from its in-point there isn't enough
        material. With <em>loop</em> on (on the video card inside the composition) it replays; with{" "}
        <em>loop</em> off <strong>it goes black</strong> for the missing seconds, which is
        deliberate: a frozen still reads as a broken render, black reads as "you are short here".
        The card's header totals it (<strong>⚠ 1.2s black</strong>) because a badge on one row out
        of thirty is not a warning anyone finds — a real export shipped with 1.2s of black in it for
        exactly that reason. <strong>⧉ 3</strong> means this extract plays footage extract 3 already
        used: from the same in-point the two play <em>identical frames</em>, which on screen looks
        like the video looping rather than cutting — the badge turns red for that case, and stays
        grey when the in-points differ (another moment of the same footage, often deliberate). Both
        are read-offs, not errors: nothing stops you.
      </p>

      <h3 id="animation-compositions">Compositions — opening an extract</h3>
      <p>
        Every extract plays a <strong>composition</strong>: a small animation graph of its own,
        ending in an output. Hit an extract's <strong>▸ open</strong> and the canvas descends into
        it — the header becomes a breadcrumb (<em>segment ▸ extract 3 · clip ▸ …</em>), and the
        transport plays <strong>just that extract's slice</strong> of the song, so what you hear
        while editing is exactly what plays under the cut. A picked clip opens as a single video
        card (edit its in-point, crop, loop there); an extract can also hold a full animation —
        fluids, lyrics, even <em>another montage</em>, any depth down. Click any crumb (or{" "}
        <strong>↩ up</strong>) to come back. Because extracts <em>reference</em> compositions, the
        same one can appear in several places — editing it inside one extract updates every other
        reference the moment you return.
      </p>
      <p>
        <strong>Sharing.</strong> The editor's <strong>⟳ reuse</strong> lists every composition in
        the project with a <em>used ×N</em> count; picking one adds an extract referencing it — one
        edit, N places updated. Anything that would make a composition contain itself (its
        ancestors, itself) is hidden from the list: cycles are refused at the source. Removing an
        extract never deletes a composition other references still reach; removing the <em>last</em>{" "}
        reference asks first, because the orphan is cleaned up on the next save. Double-click the
        breadcrumb's current name to rename the open composition.
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

      <h3 id="animation-dream">Dream — generate imagery that follows a control track</h3>
      <p>
        Where AI Stylize <em>repaints</em> a video you already have, <strong>Dream</strong>{" "}
        (Compositing) <em>invents</em> one. Every frame is generated from scratch and guided only by
        a <strong>control</strong> track — an <strong>Extract</strong> card's edges or depth, or a
        video that already is a control map. There's no source image underneath, so consecutive
        frames share nothing but the control's shapes: the imagery reinvents itself continuously
        while the motion stays locked to what you wired in.
      </p>
      <p>
        Because nothing is anchored to a source, the <strong>background will not stay black</strong>{" "}
        the way it does in AI Stylize — the model fills the whole frame. That's the trade for
        letting it invent freely. <strong>control</strong> (a modulatable port) decides how tightly
        the result traces the control map: wire a signal so it loosens on a beat and snaps back.
      </p>
      <p>
        <strong>
          Want the source back? Wire the optional <em>video</em> input.
        </strong>{" "}
        With a clip there, each frame no longer starts from noise — it starts from that clip's
        matching frame, so its layout, its colours and a fluid's black background all survive.{" "}
        <strong>strength</strong> (modulatable) is how far each frame then travels from that start:
        low keeps the source nearly intact, high reinvents it. With nothing wired to <em>video</em>{" "}
        there is no start image and strength does nothing.
      </p>
      <p>
        The two inputs are independent, and <strong>either one alone is enough</strong>. Control
        only = pure invention following your shapes. Video only = the card cannies that clip for its
        own control, so a single wire works. Both = your shapes, your start image, your prompts.
        With a video wired and one prompt, Dream does what AI Stylize does — plus the schedule, the
        fades and the frame cache.
      </p>
      <p>
        <strong>Prompts follow a schedule.</strong> Wire a signal into <strong>trigger</strong> and
        its rising edges split the window into <em>parts</em> — exactly the way the Montage card
        cuts — and each part generates under its own prompt, in order. With no trigger and one
        prompt, that prompt covers the whole clip, which is a perfectly good place to start. If
        there are more cuts than prompts the last prompt holds to the end; <strong>×</strong> makes
        one prompt swallow several cuts.
      </p>
      <p>
        Each prompt has an <strong>in</strong> and an <strong>out</strong> fade, in seconds, so a
        change can dissolve rather than cut. Leave both at 0 for a hard cut; set only{" "}
        <strong>in</strong> for a lead-in after the cut, only <strong>out</strong> to start changing
        before it, or both for a dissolve weighted to whichever side you like. If a part is too
        short for the fades you asked for, they're scaled down to fit — so what you see is always
        what renders.
      </p>
      <p>
        <strong>fade shape</strong> is worth knowing about. The two models blend prompts very
        differently: SD-Turbo morphs steadily, so the default of 1 (linear) is right for it. Z-Image
        (HD) packs nearly all of its change into a narrow band in the middle of a fade, so a linear
        ramp there looks like a soft cut rather than a dissolve — raise fade shape (try{" "}
        <strong>3</strong>) and the change spreads across the whole fade window instead.
      </p>
      <p>
        <strong>seed</strong> decides what makes consecutive frames differ. <em>New per part</em>{" "}
        (the default) re-rolls at every cut, giving each prompt its own family of imagery — wire the{" "}
        <strong>reseed</strong> port to re-roll <em>within</em> a part instead. <em>Fixed</em> holds
        one seed throughout, so frames change only because the control moved: the calmest option,
        and the one to reach for when the flicker is too much. <em>New every frame</em> is the
        opposite extreme — a hard strobe where no two frames relate.
      </p>
      <p>
        Like AI Stylize, generation runs on <strong>✨ generate</strong>, not on every render, and
        the card passes its control through until you do. Editing is cheap after the first run:
        frames are cached individually, so nudging a cut only regenerates the frames whose prompt
        actually changed, and pressing generate again after a small edit is fast.
      </p>
      <p>
        <strong>Exporting doesn't need you to have pressed ✨.</strong> The{" "}
        <a href="#export">export</a> (and the output card's <strong>⬛ HD</strong>) regenerates
        every Dream card from the graph, at the master's grid and the largest size the model handles
        for your aspect — so a card you never generated ships as imagery rather than as the bare
        control map, and a card you did generate is redrawn for the master instead of being blown up
        from the editor's small draft. This matters most when a segment reuses a composition several
        times: each copy carries its own clip, and the export covers all of them.
      </p>
      <p>
        It keeps the <strong>model you picked</strong> — the export changes the size, never the
        look, because your fades are tuned against the model you previewed with. Want Z-Image in the
        master? Set the card to <em>HD</em>, which also shows you what you'll get. Budget for it:
        one image per frame across a whole song is the longest part of an export by far, and the
        export shows a <em>generating Dream frames</em> phase with its own counter while it works.
      </p>
    </>
  );
}
