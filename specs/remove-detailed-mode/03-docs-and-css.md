# Step 03 — Compact-only prose in the in-app guide; drop the dead CSS

**Goal.** Make the user-facing guide describe one view, and remove the stylesheet rules only
the deleted detailed/toggle UI used. Satisfies the `CLAUDE.md` docs obligation — as a **pure
prose rewrite**, no anchors involved.

**Blocked by.** Nothing hard (can land with or after 00-02), but write it last so the prose
matches the shipped behaviour.

**Size.** S.

> Line numbers are a snapshot — re-grep before relying on one.

---

## Why the docs obligation is light here

`CLAUDE.md` requires that user-facing behaviour changes get prose in `Docs.tsx` and that every
help `section` resolves to a `DOC_SECTION_IDS` anchor (guarded by `paramHelp.test.tsx`).
**Verified:** the only view-mode docs live in `components/docs/animation/Cards.tsx`, and that
file has **no `id=` anchors** — its headings are plain. So no `DOC_SECTION_IDS` entry describes
the toggle, nothing is orphaned, and the anchor-guard test is untouched. This is prose only.

## `components/docs/animation/Cards.tsx`

Rewrite the "two views" paragraph (`:15-42`). Cut every detailed/toggle claim; keep everything
that's still true (categories, hover tips, ✨ arrange, the settings window, montage-reorder,
rename, ✕ delete, output-always-full).

Specifically remove/rewrite:
- `:15-18` "The canvas has **two views**, switched from the toolbar: **▦ detailed** … and
  **▤ compact** …" → one line: cards show as a compact tile (name, small live preview, one
  input + one output dot); **click a card's body to open its settings window** to edit it.
- `:18-20` "**Each view remembers its own card positions** … switching never scrambles either
  layout" → gone (one layout now).
- `:23` "(compact uses the same layout, just tighter)" → gone; ✨ arrange just "lays the cards
  out along the data flow".
- `:38-40` "The **▢/–** button in a card's title bar overrides the view for that one card
  (switching views clears the overrides)." → **delete entirely** (the button is gone).
- `:41-42` "The *output* card is the one exception — its body is the live render preview, so it
  always shows in full." → **keep** (still true and still worth saying).

Keep the settings-window description (`:27-37`) — that IS how you edit a card now, so it's more
central than before. The "In compact view," qualifier on `:27` becomes unconditional ("Click a
card's body to open its settings window").

⚠ Re-grep `components/docs/` for `compact` / `detailed` / `view` after editing — a stray
mention elsewhere (a cross-reference from another doc section) would read wrong. The map at
scan time found only `Cards.tsx`, but confirm at implementation time.

## `styles/animation.css`

Delete the rules the removed UI used:
- `.anim-node-min` (`:365-380`) and its `:hover` — the ▢/– button.
- `.anim-node.min` (`:382-390`) and `.anim-node.min .anim-node-head` — the collapsed-body state
  (no card collapses now; CompactCard uses `.anim-node.compact`, not `.min`).
- `.node-settings .anim-node-min` (`:1795`).
- `.anim-viewmode` and its children (`:2223+`) — the segmented toggle.
- The stray comment referencing "the `.anim-viewmode` segmented toggle" (`:1370`).

**Keep:**
- `.anim-min-anchor` (`:391`) — CompactCard's consolidated wire anchor still uses it.
- **all** `.anim-compact-*` (`:405-480`) — the compact card body, warning, swatch, thumb, count,
  hint, lyric. These are the live view.

⚠ Grep the class names against `.tsx` before deleting each — `.anim-node.min` in particular
must have no remaining `min`-toggling code after step 00 (`NodeFrame` no longer adds `" min"`
except via the `minimized` prop, which CompactCard passes as `false`). Confirm nothing still
renders `.min`.

## Verification

1. `npm run test` — `paramHelp.test.tsx` and the Docs anchor-guard stay green (no anchor
   touched); the docs render test (if any) passes.
2. `npm run lint`.
3. By hand (`make dev`): open `/?doc=animation-cards` (or the guide's cards section) → the prose
   describes one compact view and the settings window; no mention of a detailed/compact toggle
   or the ▢/– button. Visually diff a card and the settings modal against the CSS — nothing
   unstyled, the compact tiles and the consolidated anchor still look right.

## Acceptance

- No prose mentions the detailed view, the toolbar toggle, or the per-card ▢/– override.
- The output-always-full sentence survives.
- Dead CSS removed; `.anim-min-anchor` and `.anim-compact-*` kept; nothing renders `.anim-node.min`.
- Anchor-guard and param-help tests green (untouched).

## Risks

- **Deleting a CSS class still referenced.** Grep each class before removing it; `.anim-node.min`
  is the one to double-check (its `" min"` class was added by the button logic removed in 00).
- **A cross-reference in another doc file.** The re-grep of `components/docs/` guards it.
