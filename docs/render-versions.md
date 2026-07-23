# RENDER_VERSION history

`RENDER_VERSION` (`backend/graph_hash.py`) is folded into every clip's cache key, so
bumping it invalidates clips cached under an older meaning of the same graph. Bump it
whenever render SEMANTICS change — the same graph producing different pixels.

The full history lives here rather than in the source: it had grown to thirty lines of
comment introducing a one-line constant, and nothing older than a couple of versions has
diagnostic value (the clip cache ages out after 14 days, so no clip cached under an early
version can still exist). The last few entries stay inline in `graph_hash.py`, where they
are useful while working.

| Version | Change |
|---|---|
| v2 | Clip = the full segment (duration dropped) + per-frame medium params + r/g/b. |
| v3 | Combine nodes + the video DAG; background applied at the terminal (was per-sim). |
| v4 | Lyrics rasterised at a resolution-independent text size then downscaled — at the coarse sim grid they overflowed small boxes at low quality. |
| v5 | Transform mirror/kaleidoscope fills out-of-frame samples by MIRRORING the edge (was black), so no gaps on a non-square canvas or under rotation. |
| v6 | Slideshow accepts VIDEO items: a video slide plays from its per-item in-point while active. |
| v7 | The look-FX wave — the echo card (motion trails). A pure addition, bumped by house rule. |
| v8 | Generative cards rebuilt as physical simulations (pool caustics, spectral rain, DBM lightning, solver fire, Chapman aurora, lit clouds); new port sets; gen cards can feed a merge combine. |
| v9 | The montage card — a trigger-driven video switcher (slot k's input re-timed to start at cut k, last input holds). |
| v10 | The change card — a value modulator emitting its input's smoothed \|derivative\| (units/sec), for gating on musical change. |
| v11 | Sim-free graphs (pure video/image/montage layers, stack combines) render at the output's NATIVE resolution, short side capped at 540, instead of the coarse simulation grid. |
| v12 | A video card feeding a MONTAGE slot ignores the `sync="song"` pre-roll: the montage already re-times its inputs, and the pre-roll seeked past the end of any clip shorter than the segment's song offset — freezing a whole slot. |
| v13 | The last 8 hand-maintained whole-clip handlers now derive from their block handler (`_whole_from_block`): lyrics, slideshow, video, transform, stylize, extract, echo, colorgrade. Mostly identical restatements — but **stylize genuinely changed decoder**: the whole-clip path decoded via `sources.video` while the block path used `VideoClip(loop=True)`. The parity test's tolerance could not have proven those byte-identical, so cached clips are invalidated rather than assumed equivalent. |
| v14 | A video card out of material with `loop` off renders **blank** for the rest of its window (was: hold the last frame). A montage slot longer than its clip froze on a still for the whole cut; blank is unambiguous, and the card's shortfall warning already reports the deficit. New video cards also default to `loop: false`. ⚠ Split across commits: the backend half shipped in `6d532e5`, the version bump in `8cefeb7`, and the `factories.ts` `loop` default was swept into `66a842e` (a cleanup commit whose message does not mention it) by a careless `git add -A`. Look there, not at a commit named for this change. |
| v15 | The Transform card resamples through **`cv2.remap`** instead of four per-channel `scipy.map_coordinates` calls — 98 ms → 0.4 ms per 1080p RGBA frame, 8.3× on a whole block. OpenCV computes the bilinear weights in **fixed point** where scipy used float, so output differs by at most **1 level per channel** (verified across all three edge modes and both channel counts, zero values exceeding 1). Invisible, but not byte-identical, so cached clips are invalidated rather than assumed equivalent. |
| v16 | The montage rebuilt on **composition extracts** (specs/compositions step 03): slots-as-wired-ports became extracts referencing child compositions, each rendered in a private recursive `Dag` over the extract's window; cuts became the live union of gate rises and manual breakpoints minus per-cut disables; the v12 montage-slot pre-roll exemption is deleted (a child's window IS the extract's, so `sync="song"` pre-rolls correctly inside it, and leaf compositions are created `sync="segment"`). Old montage clips are meaningless under the new semantics. |
| v17 | A montage `disabledCuts` entry suppresses **any** cut within half a frame — gate or MANUAL (was: gate only). A manual breakpoint sharing a disabled gate cut's frame used to resurrect the cut the user had just clicked off, while the timeline (where the gate mark wins the collision pixel) showed it silenced — the render cut where the UI said it wouldn't. Editor gestures now keep such data rare (disabling sweeps same-frame manuals; placing/moving a manual clears a stale disable), but saved projects carry the collision, so clips rendered under the old union are invalidated. |
