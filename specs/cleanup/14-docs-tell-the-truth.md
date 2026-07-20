# Step 14 — Docs tell the truth; every control has a "?"

**Goal.** Reconcile the documentation with the post-refactor reality, in one pass, once —
and close the help-badge gap on the screens that have none.

**Blocked by.** Steps 07, 08, 09, 12, 13. Docs must describe the end state, not a moving one.

> Line numbers are a snapshot — re-grep before relying on one.

> **Later note (2026-07-20).** §4 of this step asked for a decision on `docs/generative-cards/`
> and never got one; it has since been made. Shipped waves moved to `specs/` —
> `specs/generative-cards/` (cards 01–06), `specs/cleanup/` (waves 1–2, including this file)
> and `specs/ai-stylize/` — while `docs/` kept only living things: the 21-card backlog, the
> open cleanup wave 3, `render-versions.md` and `history/`. **The paths quoted below are the
> ones that existed when this audit was written**, and are left as-is: rewriting them would
> falsify the record of what the tree looked like.

---

## Why this is one late step, when the rule says otherwise

`CLAUDE.md:57` requires docs to ship with the change. Steps 02–13 follow that: each fixes
the doc lines *it* falsifies (step 07 in particular fixes `DEVELOPMENT.md:118-122` inline,
because that line actively instructs the next contributor to write the code step 07
deletes).

This step is for the drift that already existed before this plan started — statements that
are wrong today and would be wrong whichever refactor landed.

## 1. Counts and lists that are simply wrong

| Location | Says | Actually |
|---|---|---|
| `ARCHITECTURE.md:81-90` | "ten blueprints" (`:57`), table lists **8** | missing `settings.py` (`/settings` GET/PUT/POST, `/settings/test-remote`) and `stylize.py` (`/stylize/<job_id>`). The `projects.py` row also omits `POST /playground/export` |
| `DEVELOPMENT.md:47-49` | names 5 blueprints | missing `assets`, `imagegen`, `jobs_routes`, `settings`, `stylize` |
| `DEVELOPMENT.md:79` | "22 cards behind `nodes/registry.ts`" | **34** (`registry.ts:133` `NODE_TYPES`; `card_demo.CARD_LABELS` agrees) |
| `DEVELOPMENT.md:88` | `SOURCE_PARAM_SPEC` "(per source card: lyrics / image / video / backdrop)" | **16** card types (`animation_params.py:218-810`). A newcomer following this checklist cannot find where a `waves` port goes |
| `DEVELOPMENT.md:58` | `sources.py` = "lyrics/image/video/backdrop" | omits `slideshow` and the six generative sim cards. `ARCHITECTURE.md:164-176` has it right |
| `ARCHITECTURE.md:433` | spec waves "(create-animation → hardening → polish → playground-cards)" | omits `improvement-batch` and `look-fx`, both shipped |
| `ARCHITECTURE.md:59` | "87-line facade" for `graph.py` | 89 lines — and step 09 changes it again. Drop the count rather than maintaining it |

Also `ARCHITECTURE.md:213-215`: the `render_jobs.py` bullet is orphaned. The "Jobs" section
(`:192`) opens "Two deliberately separate in-memory managers", lists `jobs.py`, then a
"Remote inference (optional)" `###` heading interrupts at `:202`, and the second manager's
bullet lands at `:213` **inside** the remote-inference section. Move the remote block after
the Jobs bullets.

## 2. `README.md` is missing nine live routes

`CLAUDE.md:71` requires new routes to be documented. Undocumented today:
`GET/PUT/POST /settings`, `POST /settings/test-remote`, `POST /stylize/<job>`,
`POST /generate-image/<job>`, `POST /resolve-points`, `GET /logs`, `GET /fonts`,
`GET /asset-proxy/<job>/<id>`, `GET /asset-clip/<job>/<id>`, `POST /playground/export`.

*(The Vite-proxy invariant itself is intact — all 24 local prefixes are present in
`vite.config.js:12-38`. `/health`, `/generate`, `/depth` belong to `remote_app.py` (the
rented GPU box, correctly not proxied) and `/x` is `web.py`'s test-only route.)*

## 3. Three broken cross-references

`frontend/src/lib/graph/factories.ts:149` and `backend/fluid.py:142` point at
`specs/generative-cards`; `backend/procgen.py:5` points at `specs/generative-cards-v2`,
which never existed. The directory is `docs/generative-cards`. `specs/` contains only
`create-animation`, `hardening`, `improvement-batch`, `look-fx`, `playground-cards`, `polish`.

## 4. `docs/` is half-unmapped, and one directory is a roadmap in disguise

`CLAUDE.md:9-19` and `ARCHITECTURE.md:424-434` map only `specs/` and `docs/history/`.
Unmapped: `docs/generative-cards/` (28 files, ~2.6k lines), `docs/ai-stylize/` (7),
`docs/cleanup/` (this series), `docs/render-versions.md`,
`docs/AI_stylize_cards_proposal.md`, `docs/Image_video_gen.md`. `ARCHITECTURE.md:55-72`'s
repo layout also omits `scripts/`.

**The substantive one:** `docs/generative-cards/` holds cards 01–06 (shipped) *and* 07–27 —
21 **unbuilt proposals** (cymatics, vectorscope, spectrum-bars, warp-tunnel, starfield,
plasma, metaballs, pulse-rings, moire, spirograph, reaction-diffusion, boids, lsystem,
lenia, taquin, rain-refraction, mosaic, pixel-sort, shatter, voronoi, video-feedback).
`CLAUDE.md:17` says design records are "the *why*, not a roadmap".

Pick one and commit to it: move 07–27 to an explicitly-labelled `docs/proposals/`, or amend
the doc map to say `docs/generative-cards/` **is** the card backlog. Either is fine; the
current silent mixture is not.

Same treatment for `docs/history/TODO.md:12-40`, which lists as *unchecked* work that
shipped long ago (the in-project sim, the signal contract, combine multiply/mix/max, the
derivative shaper, per-signal range remap — all delivered by the node graph, the `math` card,
the `change` card, and `[lo,hi]` bindings). `docs/history/README.md:7` calls it "the early
signal-feature checklist (shipped)", which is only true of its first section. Tick the boxes
or add a header saying the rest was superseded.

## 5. The help-badge gap — orphaned prose

`CLAUDE.md:63`: every user-facing control gets a "?" deep-linking into the guide. Five
screens have **zero** `Info` badges — while `Docs.tsx` carries prose for every one of them.
The sections exist and are unreachable from the screens they describe.

- `components/export/ExportStep.tsx` — 5 controls: size (`:108`), fps (`:146`),
  detail/grid (`:161`), HD image size (`:179`), audio (`:200`). `Docs.tsx` has both `export`
  and `animation-output-hd` to link to.
- `components/assets/AssetLibrary.tsx` (8 controls), `components/review/ReviewStep.tsx` (7),
  `components/upload/UploadStep.tsx` (7), `components/LogsPanel.tsx`, `components/ProjectList.tsx`

## 6. The guard ships in the same commit as the badges

No test asserts a step screen has *any* "?" — `paramHelp.test.tsx:145` covers palette
**cards** only. That is exactly why this gap went unnoticed, and why fixing the badges
without the guard means reopening it on the next screen.

Minimal version: render each step component and assert ≥1 `role="note"`. Use the
registry-derived shape from step 03 — an explicit allowlist to opt out, never silence by
omission.

*(Verified during the audit and needing no action: `DOC_SECTION_IDS` is fully
bidirectionally guarded, all 27 ids resolve, and all 34 card types have prose. The card-side
story is in good shape — it is the step screens that were missed.)*

---

## Acceptance criteria

1. `make dev`, click through upload → review → studio → export, and confirm **every** "?"
   deep-links to a section that exists.
2. Every route in `README.md`'s API section responds; every live route is listed. Diff the
   blueprint registrations against the doc rather than reading for it.
3. `grep -rn "specs/generative-cards" .` returns nothing.
4. The new step-screen guard goes red when an `Info` badge is removed from `ExportStep`.

## Risks

- **A doc sweep is where accuracy quietly decays** — it is long, mechanical, and unrewarding.
  Verify each claim against the code as you rewrite it; do not transcribe.
- **The `docs/generative-cards/` decision affects 21 files.** Make the call first, in one
  commit, before touching the doc map that describes it.
