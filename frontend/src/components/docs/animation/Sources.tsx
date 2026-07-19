// Part of the guide's `animation` section (cleanup step 13 split an 842-line file).
// A fragment, not a <section>: the h3 anchor ids inside are deep-link targets that
// paramHelp.test.tsx checks against DOC_SECTION_IDS, so they must render unchanged.
export default function Sources() {
  return (
    <>
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
          <a href="#assets">📚 library</a>); drag the <em>placement box</em> to position it and pull
          a corner to size it, then choose how the picture fills the box: <em>cover</em> (fill +
          crop), <em>contain</em> (fit inside, transparent letterbox), or <em>stretch</em>. Opacity
          is modulatable — wire a signal to fade it with the music.
        </li>
        <li>
          <strong>Slideshow</strong> — an ordered set of <strong>images and video clips</strong>{" "}
          that <strong>switches</strong> to the next item every time its <em>trigger</em> signal
          rises past the <em>threshold</em> (wrapping back to the first). Items come from
          drops/uploads (images <em>or</em> videos), the <a href="#assets">📚 library</a>,{" "}
          <em>and</em> any images wired into its <em>images</em> input (an Image gen card).{" "}
          <strong>Drag the thumbnails</strong> to reorder your own picks. A{" "}
          <strong>video item plays</strong> from its <strong>in-point</strong> for as long as the
          trigger keeps it visible (looping past the clip end);{" "}
          <strong>click a video thumbnail</strong> to open a small scrubbable preview and set where
          its extract starts — since the display duration is driven by the signal, the start-cut is
          the only per-video choice. The card shows a live counter — how many items it holds and how
          many times it will switch this segment. The <em>hysteresis</em> band stops a hovering
          signal from machine-gunning; you control exactly <em>when</em> it switches by shaping the
          trigger (e.g. through a <a href="#animation-modulators">gate</a>
          ). Same box/fit placement as the image card; <em>opacity</em> is modulatable too.
        </li>
        <li>
          <strong>Image gen</strong> — a pure <strong>generator</strong>: write{" "}
          <em>one prompt per image</em> (the card shows how many it will make), set a seed, pick a{" "}
          <em>model</em>, and <strong>✨ generate</strong> runs it fully locally. While building,
          the ✨ makes <strong>fast, low-res drafts</strong> so the canvas stays responsive — the{" "}
          <em>model</em> dropdown chooses which model does that: <code>SD-Turbo</code> (~2 GB,
          near-instant) or <code>Z-Image-Turbo</code> (a ~33 GB HD model, minutes per image). The{" "}
          <a href="#export">final export</a> then{" "}
          <strong>regenerates every image fresh in HD</strong> (Z-Image) automatically, at your
          project's aspect and the export's <em>HD image size</em> — so drafts stay fast and the
          master stays crisp. Images generate at the <strong>project aspect</strong> (not a fixed
          square) and are seeded — the same prompts + seed + size reproduce the same image — and
          land in the <a href="#assets">library</a>. It makes no video itself: wire its{" "}
          <em>images</em> output into a Slideshow card to show them.
        </li>
        <li>
          <strong>Video</strong> — same box/fit/library as the image card, for a clip. Extra ways
          in: <strong>import from YouTube</strong> right on the card (paste a URL; optional
          start/end timestamps fetch only that section of the video, not the whole file). A{" "}
          <strong>crop</strong> pad below the placement box selects{" "}
          <em>which part of the source frame is used</em>: drag a corner to cut a region out of the
          clip (drag the rectangle to move it) and only that region gets fitted into the box — so
          when a clip is too wide or tall for the project format, you choose what survives instead
          of a centre crop. The clip plays live inside the placement box, showing exactly what will
          render. Timing controls: <em>sync</em> (<em>song</em> keeps a background clip
          phase-continuous across segments; <em>segment</em> restarts it at each cut), a{" "}
          <em>start</em> offset into the source, and <em>loop</em> (off = the last frame holds).
          Both <em>opacity</em> and <em>speed</em> are modulatable — a signal on <em>speed</em>{" "}
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
          <em>start/end time</em> (as <code>m:ss.cc</code>). For covers and rewritten lyrics, upload
          the <em>original</em> lyrics first so the alignment locks to the vocal, then swap in your
          new words line by line (uploading different words directly won't align — the timing comes
          from matching what is actually sung). When the automatic timing is off — or there were no
          lyrics to align to — nudge each line's times by hand.
        </li>
      </ul>

      <h3 id="assets">The asset library — 📚</h3>
      <p>
        Every image or video you bring in lands in the project's <strong>asset library</strong>.
        Open it with the <strong>📚 assets</strong> button in the bar at the bottom of the Studio,
        or from any image/video card's <strong>📚 library</strong> button to pick an existing asset
        instead of re-uploading.
      </p>
      <ul>
        <li>
          <strong>One copy, many cards.</strong> Files are stored by content, so uploading the same
          file twice (even on different cards) keeps a single copy, and several cards can reference
          the same asset.
        </li>
        <li>
          <strong>Click to drop a card.</strong> Opened from the bottom bar, clicking any asset adds
          its card — <em>video</em> or <em>image</em> — straight onto the canvas, already pointing
          at that file. The library stays open, so building a montage is one click per clip; the new
          cards stack in a column under your existing graph.
        </li>
        <li>
          <strong>Adding.</strong> Drop a file on an image/video card, browse from the card, or
          import a YouTube video from the video card — all of them register the asset in the library
          automatically.
        </li>
        <li>
          <strong>Whole folders.</strong> The library's <strong>📁 upload folder</strong> button
          imports every image/video inside a folder you pick (subfolders included) and{" "}
          <strong>keeps the folder structure</strong>: the grid groups assets under their relative
          path (e.g. <em>May 2026/venise</em>). Perfect for a month of clips headed into a{" "}
          <a href="#animation-montage">Montage</a>. Non-media files are skipped; files upload one by
          one with a progress count.
        </li>
        <li>
          <strong>Deleting.</strong> Remove an asset from the library manager (🗑). Cards that still
          reference it will render an empty (transparent) layer, so delete freely — the worst case
          is a see-through spot where the picture was.
        </li>
      </ul>
    </>
  );
}
