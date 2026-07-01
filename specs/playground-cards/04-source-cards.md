# 04 — Audio-native source cards (`→ video`)

> Every `video` in the graph originates from a fluid. This card adds a non-fluid
> `video` **source** that you layer with fluids via a stack combine — and it's the most
> "on-brand" because it turns the app's *own* assets into visuals: **Lyrics/Text** (the
> segment's already-aligned lyrics). It adds a genuinely new render path, with a
> deliberately minimal v1.

## Locked decisions

1. **Sources emit the same `(T, H, W, 3)` uint8 dye-on-black frames** as `simulate`,
   so they compose through `composite`/`apply_background` unchanged. Coverage = max-channel
   brightness (so sparse Lyrics text stays transparent where there's no glyph).
2. **Sources register in `_VIDEO_HANDLERS` only** (no emitter handler) → they can feed
   an output or a **stack** combine, never a **merge** (same rule as FX, spec 03 §2).
3. **Modulatable params reuse the fluid port/binding model (PLAN P2).** Per-card param
   specs in the `FLUID_PARAM_SPEC` shape; `data.ports[key].binding` resolved by the
   shared `resolve_ports`.
4. **Category `sources`**, `outFlow: "video"`; added to frontend `VIDEO_PRODUCERS`
   (`graphModel.ts:152`).
5. **Lyrics reads the existing alignment, doesn't recompute it.** Segmentation already
   aligns lyric **lines** with `[t0, t1]` (`backend/segment.py` `LyricLine`), and
   word-level timings exist (`transcribe_words`). v1 uses **line** timings; per-word
   reveal is a stretch goal gated on word timings being available at render time.

## Architecture this builds on

- Backend: `graph.py` `_VIDEO_HANDLERS` (register here), `_fluid_video` (template: a
  handler that synthesises frames). `render_mp4` (encode), the grid sizing from
  `output` (`_output_params` / `fluid.grid_from_output`). `backend/segment.py`
  `LyricLine` / `parse_lyrics` / `parse_lrc` / `transcribe_words` for lyric data.
- Frontend: `FluidNode.tsx` (template for a source card with modulatable ports),
  `registry.ts`, `graphModel.ts` (`VIDEO_PRODUCERS`, fluid `connect`/`disconnect`
  reused for ports).
- P2 `resolve_ports`.

## Cards

### D2 — Lyrics / Text  (`id: lyrics`)  · heaviest (new render path + data plumbing)
1. **Purpose.** Render the segment's **aligned** lyrics as a timed `video` layer — the
   words appear over the visual in time with the vocal.
2. **Ports.** No input. Output `out` (`video`). Modulatable `value` ports: `size`,
   `r/g/b`, `opacity` (e.g. pulse text brightness on the beat).
3. **Static params.** `font` (bundled), `position` (`top | center | bottom`),
   `align`, `reveal`: `line | word` (word gated on word timings), `case`.
4. **Frontend.** `LyricsData { font; position; align; reveal; case; ports }`. Component
   shows the segment's lyric lines (read from `ctx.segment`) as a preview; no text
   entry (lyrics come from alignment).
5. **Backend.** `_VIDEO_HANDLERS["lyrics"]`: for each frame's time `t` (relative to the
   segment), pick the active `LyricLine` (`t0 ≤ t < t1`), rasterise to an RGB bitmap
   (a text-raster dependency — Pillow), composite onto dye-on-black at `position`.
   Per-word reveal advances within the line on beat phase (`raw_beat`) when word
   timings exist.
6. **Docs.** `animation-lyrics` — "Burn the aligned lyrics into the video, timed to the
   vocal."

## Open questions (resolve while drafting)

- **Lyric data at render time (blocking for D2).** The executor receives the `segment`
  dict; confirm aligned lyric **lines with `[t0,t1]`** are persisted into the
  segment/project data the render path sees. If only the raw lyrics file is on disk
  (`media.lyrics_path`) and timings live transiently in segmentation, **thread the
  aligned lines into the saved segment** as a small data-plumbing step *before* this
  card — call it out as a prerequisite, not an afterthought.
- **Text rasterisation dependency.** Confirm Pillow (or an existing rasteriser) is
  available in `requirements.txt`; if adding it, note it in the spec. Font must be
  bundled (no system-font assumption) for reproducible renders.
- **Determinism.** Any seeded drift seeds from `seed` only — never wall-clock — so
  `output_hash` stays stable and the render cache works.

## Verification

- `lyrics → output` (or stacked over a fluid) burns in the timed lyrics.
- The source fails to wire into a **merge** combine; succeeds into a **stack** or
  output.
- Lyrics: a segment with aligned lyrics shows the right line at the right time; a
  segment with no lyrics renders empty (transparent), not an error.
