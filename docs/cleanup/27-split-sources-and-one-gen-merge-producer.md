# Step 27 — Split `sources.py`; one gen-merge producer

**Status: item 2 and item 3 DONE** — `52604a4` (combine derives), `e3cfd60` (`/animate` deleted).

Item 2 needed no new abstraction in the end: `combine`'s per-kind state is created fresh
for a single-block scan (rain's `state` starts `None`, lightning's `bolt_cache` defaults
to `None`), so `_whole_from_block("combine")` just works and `CLAUDE.md`'s exception list
is one shorter. Only the `sources.py` split (item 1) remains. ⚠ Its Vite proxy
entry **stays**: it is a prefix and it is what routes `/animate/stream`.

**Items 1 and 2 not done, and item 1 should be reconsidered before anyone starts.** Wave 3
measured five perf claims in this backlog and four were wrong, all by reasoning from shape
instead of profiling. Splitting `sources.py` is a *readability* change with no measurement
behind it either way — it is not wrong, but it is 1,300 lines of import churn across a file
every card touches, and the `getattr(sources, kind)` dispatch it must replace is the kind of
detail that breaks quietly. Worth doing deliberately, not as a tidy-up.

Item 2 (one gen-merge producer) is the more defensible half: `_combine_video` and
`_combine_block` genuinely duplicate the dispatch, `produce_waves` is a character-for-
character copy of `_waves_block`'s `produce`, and `test_card_impact`'s whole-vs-streamed
assertion already covers `combine`, so the safety net exists.

**Tier.** Optional.

**Goal.** Finish the file split wave 1 proposed and never did, close the last whole-vs-block
drift hazard, and delete a route that can hang a worker.

**Blocked by.** Nothing. Backend-only, so it is collision-free with steps 21/24/25/26.

**Size.** M.

> Line numbers are a snapshot — re-grep before relying on one.

---

## 1. Split `sources.py` (1317 lines)

Wave-1 step 2 called this "the cheapest big win" and it never happened. The reasoning holds:
the file is three unrelated programs sharing a namespace.

| Lines | Group | Depends on |
|---|---|---|
| 1–30 | header + `SOURCE_PARAMS` | `animation_params` |
| 33–239 | **text**: `_load`/`_font`/`_wrap`/`_fit`/`_text_res`/`lyrics` | PIL, `fonts` |
| 241–313 | **placement**: `_place_box`, `_fit_rgba`, `_apply_opacity`, `backdrop` | numpy, PIL |
| 316–394 | shading helpers: `_rgba`, `_clock`, `_norm3`, `_spec_pos`, `_spec_gate`, `_specular` | numpy |
| 396–493 | `waves` | `procgen` |
| 495–663 | `lightning` | `procgen`, PIL, scipy |
| 666–747 | `aurora` | `procgen` |
| 748–866 | `rain` | `procgen` |
| 869–982 | `clouds` | `procgen`, scipy |
| 984–1011 | `image` | PIL |
| 1013–1311 | **decoders**: `_video_meta`, `_fit_vf`, `VideoClip`, `SlideshowClip` | subprocess/ffmpeg |
| 1313–1328 | `video_src_times`, `apply_video_opacity` | numpy |

Cross-coupling is almost nil. The only shared symbols are `_at` (`:92`, used by lyrics *and*
every sim card) and `_place_box`/`_fit_rgba`/`apply_video_opacity` (used by `image`, both clip
classes, and `graph_render`).

Proposed: `sources_text.py` (lyrics), `sources_sim.py` (316–982), `sources_clips.py`
(241–313 + 984–1328), with `_at` in a small `sources_common.py`.

### ⚠ The one real friction point

`graph_render.py:646` and `:1508` do `fn = getattr(sources, kind)` for gen-sim merges, where
`kind` comes from the graph.

Two options: keep `sources.py` as a re-export facade (the house pattern — `graph.py` and
`graphModel.ts` already work this way), or replace the `getattr` with an explicit
`{"waves": …, "rain": …}` dispatch dict.

**Prefer the dispatch dict.** `getattr(module, user_controlled_string)` is the one place in
this codebase where a graph value indexes into a module namespace, and it stops being merely
inelegant the moment the module's contents change — which is precisely what this step does. An
explicit table also fails loudly on an unknown kind instead of raising `AttributeError` from
somewhere confusing.

### What **not** to split

`graph_render.py` (1947 lines) looks like the bigger prize and is the trap. `Dag.video` /
`Dag.emitters` / `Dag._block_producer` read the module-level `_VIDEO_HANDLERS` /
`_EMITTER_HANDLERS` / `_BLOCK_HANDLERS` dicts, which are defined *after* the handlers, which
take a `dag` and call back into `dag.video()`. Moving `Dag` out produces
`graph_dag → registry → handlers → graph_dag`.

Moving only the leaf card helpers (`733–997` media, `999–1267` gen, `1269–1405` fx — ~675
lines, no cycles) is possible and cycle-free, but it is readability-only: the file is already
well-sectioned and heavily commented. **Recorded as considered and declined.** If it is ever
done, `_grid_dims` (`:713`) is the shared dependency and belongs in `graph_common.py`.

## 2. One gen-merge producer

The last surviving whole-vs-block duplication, and the exact hazard `_whole_from_block` was
built to eliminate.

`_combine_video` (`graph_render.py:630`) and `_combine_block` (`:1475`) each re-implement the
`_gen_merge_split` → per-kind dispatch, with the `rain`/`waves`/`lightning` special cases
spelled out in both. Worse: `_combine_block`'s `produce_waves` (`:1521`) is a
**character-for-character duplicate** of `_waves_block`'s `produce` (`:1079`), and its rain
closure duplicates `_rain_block`'s.

`CLAUDE.md` states the rule and names the exceptions: a new video card normally needs only a
block handler, with `_whole_from_block("xxx")` for the whole-clip entry, and only `fluid`,
`output`, `combine`, `montage` and `fire` genuinely carry cross-block state.

**`combine` is on that exception list — check whether it deserves to be.** If the merge branch
factors into one `_gen_merge_producer(dag, kind, layers, base_src, gh, gw)` used by both paths,
then `_combine_video` becomes `_whole_from_block("combine")` and the exception list in
`CLAUDE.md` gets one entry shorter. If it does not factor — if there is real cross-block state
— then say so in a comment, because the current code does not make that visible.

`test_card_impact`'s whole-vs-streamed assertion is the safety net here and it already covers
`combine`.

**Also worth folding in:** `_montage_video` (`:960`) and `_montage_block`'s `_slot_producer`
(`:1622`) implement the same slot-cache protocol — check by `_montage_slot_key`, validate shape
and length, else render and tee — in two shapes. One is the whole-clip degenerate case of the
other. Lower value than the combine fix; do it only if the combine work makes it obvious.

## 3. Delete the `/animate` route

`routes/animation.py:147`, calling `graphmod.render(...)` at `:164` — a render that can take
minutes, **in the Flask request thread, with no cancellation**.

The frontend does not use it. `lib/api.ts` only ever calls `/animate/stream` (`:306`), and the
sole mention of the one-shot endpoint is a comment at `:295` describing it in the past tense.
Only `tests/test_app_routes.py` and `test_studio_e2e.py` still hit it.

`graph_render.render()` itself **stays** — tests and `seed_card_demo.py:268` use it. This
deletes the HTTP route only.

⚠ `/fluid` (`routes/animation.py:126`) has the same shape (`fluid.simulate` + `render_mp4`
inline) but it is the FluidLab playground and may still be reachable from the UI. **Confirm
before touching it** — this step does not assume it is dead.

Removing a route means removing its Vite proxy entry if it has a dedicated one
(`frontend/vite.config.js`) — and `/animate/stream` must keep working, so check the prefix
carefully rather than deleting the whole `/animate` proxy rule.

---

## Verification

1. `make test` — `test_card_impact`'s whole-vs-streamed parity is the gate for item 2, and it
   covers every card.
2. `make lint` and `npx tsc --noEmit`.
3. Imports: `grep -rn "from backend import sources\|from .sources\|sources\." backend/ tests/`
   — every caller resolves after the split. Tests import submodules directly (a wave-2
   property), so they are the most likely breakage.
4. Item 3: confirm `/animate/stream` still works end-to-end via `make dev` — start a stream
   render in the editor. Deleting the sibling route must not touch the streaming one.
5. `make seed-playground` still succeeds (it calls `render()` via `seed_card_demo.py`).

## Acceptance criteria

- `sources.py` is split; no `getattr(sources, kind)` remains.
- `combine`'s whole and block paths share one producer, **or** a comment explains why they
  cannot — and `CLAUDE.md`'s exception list matches whichever is true.
- `/animate` gone; `/animate/stream` unaffected.
- `ARCHITECTURE.md`'s module map updated (`CLAUDE.md` requires it for structural changes).

## Risks

- **A behaviour change hiding in the combine dedupe.** The two paths are *supposed* to be
  identical; if `test_card_impact` goes red, the finding is that they had already drifted —
  investigate which one was right before "fixing" the test.
- **Circular imports** from the split. `_at` in a leaf module avoids the obvious one; watch
  for `sources_sim` needing something from `sources_clips`.
- **`RENDER_VERSION`**: none of this should change a pixel. If it does, that is a bug in the
  refactor, not a reason to bump.
