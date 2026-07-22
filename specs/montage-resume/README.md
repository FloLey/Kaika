# Montage — resume a repeated clip instead of restarting it

> **Status: SUBSUMED by `specs/compositions/` (the extracts rework, 2026-07-23).**
> The montage no longer has slots — it has extracts referencing child
> compositions — and the two parts of this spec landed as different shapes:
> **Part 1** (detect and warn) became the duplicate roll-up reading through the
> extracts' LEAF compositions (same clip in two extracts is flagged whether they
> are two pool entries or one shared composition — `useMontageShortfall`'s
> `repeats`). **Part 2** (the "align it" offset) became `extract.inPoint` —
> seconds into the child's local clock at the cut, byte-exact-equivalent to the
> leaf's video `start` (pinned by `test_extract_in_point_offsets_the_child`);
> "resume where the previous occurrence left off" = set the in-point there. The
> per-slot local-time cache this spec had to design around is gone; the prose
> below describes the pre-extracts world and is kept as the historical record.

## The problem

A montage slot re-times its input to **local** time: the slot's frame 0 lands on its cut,
and the input clip starts from its own frame 0 (or its `start` in-point). The montage has no
memory of what played before — not across a cut, and not across a segment boundary.

So when the **same clip** feeds two adjacent slots — most visibly the last slot of one
segment and slot 0 of the next — the second occurrence restarts from the top. On screen it
reads as a glitch: the clip jumps back to its beginning mid-shot.

Observed in the "Toujours un gamin - BEN PLG" project (`e883da29`) at **1:58.8** — the exact
`seg-a610d7` → `seg-49815073` boundary. `5f7786d7a4fb8d3b.mp4` is the last slot of segment 2
*and* slot 0 of segment 3; `503ba34e…` and `4b878fd7…` repeat the same way. Measured across
the whole project: **zero adjacent repeats inside a segment; the only repeats are at the
boundary.** So the cross-segment case is where all the value is.

## Why this is two features, not one

### Part 1 — detect and warn (small, no render change)

Pure graph data. Compare slot 0's wired asset against the last slot of the previous segment
(and, generally, any slot against its predecessor). On a match, show a `⚠` on the montage
card: *"slot 0 repeats the clip that ends the previous segment — it will restart, not
continue."*

- No backend, no cache-key change, no render-path change → cannot cause preview/export
  drift, the failure class most of the codebase guards against.
- Needs the **previous segment** reachable from the card. Studio already holds all segments
  (`segments: Segment[]`); this threads one more value (`prevSegment`) through the ctx the
  same way the other nine flow (the "nine-prop drill" of `specs/cleanup/26`).
- Docs obligation (`CLAUDE.md`): a new user-facing control gets a `⚠`/help affordance —
  `ui/Info.tsx` (or `ArgInfo`) with a `section` in `Docs.tsx`, plus prose describing the new
  behavior. The anchor-guard test keeps the link honest.

### Part 2 — the "align it" button (a real feature)

Next to the warning, a button that sets the repeated slot's video card `start` so the clip
**resumes where the previous occurrence left off** instead of restarting.

The correct `start` is `prevOccurrenceEnd − prevOccurrenceStart` in seconds — how long the
clip already played. That "how long" depends on the **previous segment's trigger curve**,
resolved over the **previous segment's window**. `useResolvedCurve` today reads everything
from `ctx.segment` (the *current* segment), so this needs a second resolution against a
different segment — the part that makes it non-trivial.

**Why reuse `start` and not a new field.** The video card already has a `start` in-point
(`data.start`, seconds), already folded into `output_hash`, so writing to it needs **no
`GRAPH_VERSION` migration and no new cache key**. The button computes the offset and writes
`start` through a `lib/graph/mutations.ts` helper (never mutating the graph inside the
component — the binding↔edge invariant). Preview and export both read the same `start` from
the graph, so there is no preview/export divergence: the button is a one-shot *edit*, not a
runtime "carry state across segments", which is the design that would have broken the
invariant.

⚠ `start` past the clip's end + `loop=false` renders **blank** (v14 semantics). The button
must clamp to the clip duration and, if the computed resume point exceeds it, either leave
`start` at the clamped value or surface that the clip is too short to cover the gap.

- `RENDER_VERSION`: the button changes `start`, which already re-keys the cache on its own —
  so **no bump for the mechanism**. A bump is needed only if part 2 ever changes montage
  *timing* semantics, which this design deliberately avoids.
- The rejected alternative — carrying playback state across segments in the renderer — is
  what the local-time `_montage_slot_key` and the self-rendering segment preview forbid:
  `_montage_slot_key` documents that a slot's frames depend "ONLY on its own upstream chain,
  not on where its cut falls nor how long the slot lasts", which is exactly what makes
  re-timing the trigger reuse every cached slot. A resume-from-state slot would break that.

## What is NOT in scope

- Auto-applying the offset. The button is explicit; a montage that silently retimed clips
  would surprise. Detection warns; the user chooses to align.
- Cross-segment repeats that are *not* adjacent (a clip in segment 1 and again in segment 3
  with something between). Not a restart glitch, so out of scope.
- Changing the default `loop`. Unrelated; v14 already moved new cards to `loop:false`.

## Acceptance

- Part 1: a montage whose slot 0 repeats the previous segment's last clip shows the warning;
  one that doesn't, doesn't. A test builds both and asserts the flag.
- Part 2: clicking align sets `start` to the measured resume offset (clamped to clip
  duration), via a `mutations.ts` helper; the resulting render continues the clip rather than
  restarting it. Verified against the `e883da29` boundary at 1:58.8.
- Docs: the `⚠` deep-links into a `Docs.tsx` section; behavior prose added; anchor-guard
  green.
