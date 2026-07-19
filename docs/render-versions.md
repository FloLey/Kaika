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
