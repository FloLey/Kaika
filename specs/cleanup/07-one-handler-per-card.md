# Step 07 — One handler per card, round two

**Goal.** Collapse the last 8 hand-maintained whole-clip handlers onto their block handlers,
and delete the 11 functions that are already dead.

**Blocked by.** Step 06 (**hard** — see below), step 02.

**⚠ Requires a `RENDER_VERSION` bump** (`backend/graph_hash.py`).

> Line numbers are a snapshot — re-grep before relying on one.

---

## Why now

`CLAUDE.md:82-85` already states the rule: a new video card normally needs only a
`_xxx_block` handler, with the whole-clip entry registered as `_whole_from_block("xxx")`.
Seven cards follow it (`image`, `backdrop`, `waves`, `lightning`, `aurora`, `rain`,
`clouds` — `graph_render.py:1573-1588`). Eight do not, and are maintained as parallel
restatements kept in sync only by `test_card_impact`.

## ⚠ Do not start before step 06

The three block handlers for `slideshow` (`:1723`), `video` (`:1817`) and `stylize`
(`:1862`) register `clip.close` on `dag._closers`, which — until step 06 — is drained only
by `stream_blocks`. Converting these cards to `_whole_from_block` routes those registrations
onto `render()`, which never drains them, and **`test_card_impact` will stay green through
the leak** because it constructs a fresh `Dag` and never calls `render()`.

---

## 1. Convert the eight

| Card | whole-clip | block | Notes |
|---|---|---|---|
| `lyrics` | `:711` | `:1674` | pure restatement |
| `transform` | `:1414` | `:1837` | pure restatement |
| `extract` | `:1485` | `:1874` | pure restatement |
| `colorgrade` | `:1541` | `:1913` | pure restatement |
| `video` | `:999` | `:1799` | decoder is per-call |
| `slideshow` | `:883` | `:1712` | registers a closer |
| `stylize` | `:1422` | `:1853` | **see below** |
| `echo` | `:1502` | `:1890` | carries state, but one `produce(0, n)` call *is* the whole scan |

**`stylize` is the one with a live bug in it.** `_stylize_video:1429` decodes via
`sources.video(...)`; `_stylize_block:1861` uses `VideoClip(loop=True)`. Two different
decoders for one card, held in agreement only by a parity test with a `< 2.0` mean-delta
tolerance. This is precisely the drift class the docstring at `:1551` warns about, and it
is the strongest single argument for this step.

Converting makes `sources.video` (`sources.py:1322-1376`, ~55 lines) dead — its only callers
are `_video_video` and `_stylize_video`. Delete it here.

`echo` deserves a moment's thought rather than mechanical conversion: confirm that a single
`produce(0, n)` really is equivalent to the whole scan for its cross-block state before
converting. If it is not, leave it and say so in a comment — a documented exception beats a
silent behaviour change.

## 2. Delete the dead (verified: zero callers)

`graph_render.py` — these seven have `_whole_from_block` entries already, so the functions
are orphaned:

`_image_video:798`, `_backdrop_video:1022`, `_waves_video:1116`, `_lightning_video:1220`,
`_aurora_video:1240`, `_rain_video:1256`, `_clouds_video:1290`

Deleting them also orphans `_gen_base:1108` (its only callers are `_waves_video` and
`_rain_video`). ~70 lines.

Elsewhere, also zero-reference: `look_fx.py:17 rng_for_frame`, `imagegen.py:76 model_label`,
`logbus.py:65 head_seq`.

## 3. Fix the doc that tells you to do the wrong thing

`DEVELOPMENT.md:118-122` currently says:

> "**Executor** (`backend/graph_render.py`): a `_xxx_video` handler (+ a `_xxx_block`
> streaming handler…). `_VIDEO_PRODUCERS` and the output-wiring check pick it up
> automatically."

Both halves are false. A new card normally needs **only** `_xxx_block` (`CLAUDE.md:82`),
and `VIDEO_PRODUCERS` moved to `graph_common.py:75` — you must add the type there by hand
or the import-time assert at `graph_render.py:1961` blows up. `graph_render.py:526`'s
comment repeats the same stale claim.

This lands **here**, not in step 14's doc sweep: it is a line that actively instructs the
next contributor to write the code this step is deleting.

---

## RENDER_VERSION

Bump it. The stylize decoder swap changes which decode path produces the frames, and the
parity test's tolerance will not prove byte-identity. Bumping costs a cache rebuild;
not bumping risks serving frames from a cache keyed on the old semantics. Do not argue the
frames are "probably identical" — that is the argument that makes cache bugs.

## Acceptance criteria

1. `test_card_impact.py::test_whole_clip_matches_the_block_stream` green for all 34 cards.
2. Step 06's drain test green — the converted cards now exercise it.
3. Render a **stylize** segment in the real app (`make dev`) and compare against a capture
   taken before this step. The parity tolerance is not tight enough to do this for you.
4. `grep -rn "_video\b" backend/graph_render.py` shows only the `_whole_from_block`
   registrations and any documented exception.

## Risks

- **`echo`'s cross-block state.** The likeliest place this step is wrong. Verify, don't assume.
- **A converted card's block handler assumes block-sized inputs** and misbehaves when handed
  the whole clip. `_whole_from_block` calls `produce(0, n)`; check each handler's use of the
  block bounds before converting.
- **Large diff in one file.** Land the deletions (§2) as their own commit first — they are
  provably inert — then convert cards in small groups so a bisect lands on one card.
