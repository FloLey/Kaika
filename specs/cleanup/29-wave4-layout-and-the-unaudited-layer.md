# Wave 4 — layout, the unaudited layer, and the honest tails (done)

Audited 2026-07-25 against the post-wave-3 tree. One file, not thirteen, because the wave
is small: wave 3 had already taken the code-quality backlog to the point where a generic
refactor pass would have been churn.

## The finding that shaped the wave

**Wave 3 was not open.** Its README's summary table said "steps 16, 18 and 19a have landed;
17 and 20–28 have not" — stale by a dozen commits. Reading each step file's own status
header against the tree gave a completely different picture: 16, 18, 19, 20, 21, 23, 24 and
28 were **done**, 17 was resolved by a different fix than the one proposed, and **26 and
25-item-2 had been closed on measurement** with an explicit "do not do this".

That is the same failure the wave-3 README documents in its own *Corrections* section — *a
claim written down without being run, then inherited by the next reader* — except one level
up: not a claim inside a step, but the index over all of them. **A summary table is a claim
too.** It is now the thing this file exists to prevent recurring: the wave-3 steps have
moved here, and `docs/cleanup/` is gone rather than left holding a table that will drift
again.

So the work went where the value actually was:

1. **The UI had never been audited by any wave** — and it had real grouping problems.
2. **`animation.css` (3,416 lines) was the largest file in the frontend** and the one layer
   no wave had ever looked at.
3. Three code tails, chosen deliberately rather than reflexively.

## What landed

| | Commit | |
|---|---|---|
| A1+A2 | `fbb873e` | Studio: view tabs + segment actions + step nav in one bar under the title |
| A3 | `0d716ce` | Editor toolbar grouped by what each button acts on |
| A4 | `3ad34a8` | Export settings: FORMAT vs QUALITY |
| A5 | `0cdac63` | A labelled field's "?" sits beside its label |
| B | `2342587` | `animation.css` → nine ordered parts |
| C1 | `66175d9` | The HD export job bodies, 56% → 80% |
| C2 | `7608377` + `1ca2bfa` | `sources.py` → four modules behind a facade |
| C3 | `dc5b9db` | `<EdgeLayer>` extracted (step 25 item 1) |
| D | `6dfad27` | The cache-hit benchmark, unrunnable since the compositions wave |

### A — the UI, regrouped in place

Three real mismatches, all of the same kind: **controls that belong together were not
together.**

- The **mode tabs sat at the bottom** of the workspace, sticky to the page edge, while the
  header at the top carried the title naming the active one. Two halves of one idea, a full
  stage height apart. `📚 assets` was a third tab in that group and **never was a mode** —
  it opens a modal.
- The **header row carried four scopes side by side**: step nav (edit split, Final export),
  a segment action (⧉ copy), and the transport. The code already knew: a comment said the
  actions were "kept visually distinct from the transport cluster", and a divider rule with
  a media query dropped it when the row wrapped. A divider papering over a grouping.
- The **editor toolbar was six concerns in a flat row**. Two gave it away: undo/redo and
  copy/paste already shared `.anim-history-btns` while rendering as two sibling divs.

The bar is sticky to the **top** now rather than the bottom — the tabs stay reachable while
scrolling a long signals tab, which was the only property of the old sticky-bottom bar
worth keeping.

⚠ **A5 was found by opening a browser, and nothing else would have found it.** `.out-field`
was a column flex, so every labelled field rendered as three stacked rows: label, then the
"?" badge explaining it, then the control pushed down past both. 376 DOM tests were green
over it. The fix is CSS-only (two grid columns on the first row) so all five call sites
across three components stayed untouched — and the **first attempt was wrong on screen
while looking right in the markup**: two `max-content` tracks let the full-width children
below bleed their width into column 1, parking the badge further from its label than it had
been stacked underneath.

### B — the CSS split, and why it is contiguous

Nine parts, cut at the file's own section banners and nowhere else.

The constraint that shaped it: **this stylesheet is not a set of disjoint modules.** Card
rules recur in three separate places (`02` / `06` / `08`) and modal rules in three (`05` /
`07` / `08`), and the later ones land on the earlier ones deliberately. Grouping "all the
card styles" into one file would have silently reordered the cascade — a visual regression
with no test to catch it. So the parts are numeric, **the numbers are the cascade**, and
`animation.css` is a barrel of `@import`s in that order.

Proven at both ends rather than asserted: the nine parts rejoin **byte-for-byte** into the
original lines 6–3416, and `vite build` emits a **byte-identical** CSS bundle (78,825 bytes)
before and after.

### C — the three tails

**C1 (step 22's remainder).** Took step 22's own way out — its procgen half succeeded by
asserting properties rather than chasing lines. Nothing mocks a renderer and checks the
mock. Every test was **mutation-checked**: the deep-copy bug, a dropped seed offset and a
prompt-blind key were each injected into `routes/export.py` and confirmed to turn a test
red.

⚠ **One test did not survive that check on the first pass** — it compared the test file's
own key helper against itself, so a formula change made every case miss the cache and the
whole thing passed for exactly the wrong reason. It now asserts the baseline **hit** first.
That is the concrete argument for mutation-checking a test you wrote to avoid theatre:
it was written *specifically* to have teeth, and it did not.

**C2 (step 27 item 1).** Split by where a card's pixels come from — text / generated /
file-backed — which is the seam the dependency graph actually has. All 37 top-level symbols
moved with byte-identical bodies (AST-compared against HEAD).

⚠ **The facade missed a name**, caught by a separate session in `1ca2bfa`. The verification
grepped for `sources.X` attribute access; `routes/assets.py:173` uses a **lazy
`from ..sources import _video_meta` inside a function**, which that grep never saw and which
719 passing tests never executed. The completeness check is now an AST walk over both import
forms — the lesson being that a grep shaped like the pattern you expect will not find the
pattern you did not.

**C3 (step 25 item 1).** JSX-only extraction. The rect read and the `.map` stay in the
parent: `2f7bb48` hoisted that read to once per pass, taking forced layouts per pointermove
from scaling with edge count to flat. Moving it into the child would have re-opened that
invisibly.

### D — measure, then decide

The stance was: profile, report, and change only what the numbers support. **The numbers
supported nothing, and no performance change was made.** All five baselines are within
budget.

What running them *did* find is that `make bench` had been failing outright since the
compositions wave (`9ed15ff`) — `_export_hash` and `render_song` both gained a
`compositions` argument and the benchmark never learned. It went unnoticed because the fix
for a real problem hid it: `bench` is deselected by `addopts`, correctly, since these are
seconds-long machine-specific baselines that would flake in CI.

Wave 3 found the inverse — `-m "not perf"` documented everywhere and implemented nowhere, a
deselect that was not real. **This is the other failure of the same pair: a deselect that IS
real still needs something to run it.** Neither is caught by reading; both are caught by
running.

## Deliberately NOT done

- **Perf work.** See D. Wave 3 profiled five claims in its own backlog and four were wrong.
  Reasoning from shape is what produced them; nothing here repeats it.
- **`_regenerate_hd_stylize`'s body, the `imagegen.generate` arm, the ffmpeg mux arm.** Each
  needs a diffusion model or a real render. Listed with a reason in
  `tests/test_export_hd_jobs.py`'s docstring rather than faked.
- **Restructuring the screens** (assets as a docked panel, output settings inline, merging
  the rail and breadcrumb). Considered and scoped out in favour of regrouping in place —
  the payoff is real but it is a redesign, not a cleanup.
- **Splitting `registry.ts` / `factories.ts` / `normalize.ts` / `mutations.ts`.** Wave 3
  checked these and found them pure line-moving. Unchanged.

## What is open after this

Nothing in the cleanup series. That is why `docs/cleanup/` no longer exists — under
`CLAUDE.md`'s rule that `docs/` holds only living things, an empty backlog is not one.
A wave 5 starts by auditing the tree, not by reading a table here.
