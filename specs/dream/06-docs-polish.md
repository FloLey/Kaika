# 06 — Docs & polish sweep

> **Status: BUILT.** `ARCHITECTURE.md` (the `/dream` route, `cut_schedule.py` as a leaf,
> `dream_cache` as a fourth cache layer, remote inference), `README.md` (route + storage +
> the `DREAM_FRAME_CACHE_*` caps), `DEVELOPMENT.md` (the extra rule for a card carrying a
> cut schedule), `CLAUDE.md`'s doc map, the `animation-dream` guide section, and the
> cross-reference in `specs/ai-stylize/README.md`.
>
> Most of the *in-app* half landed early, in step 04 — the `paramHelp` entries and the
> `Docs.tsx` section could not wait, because the coverage tests fail on a modulatable port
> without help and on a "?" pointing at a section id that does not exist. That is the
> guard doing its job: the docs are not a trailing chore here, they are a build gate.

**Goal:** the documentation half of the deliverable, done as its own step so it cannot be
the thing that gets dropped when the code works. Docs stay updated with every change is a
hard invariant in `CLAUDE.md`; this step is where the wave-level sweep lands.

**Prerequisites:** steps 01–05.

## The in-app guide (`frontend/src/components/docs/`)

- A **Dream** section in the animation docs (`animation/Fx.tsx` is where AI Stylize and
  Extract already live, so Dream belongs beside them), added to `DOC_SECTION_IDS` in
  `Docs.tsx`. The anchor-guard test keeps every "?" honest, so the section id must exist
  before the links do.
- Prose that answers the three questions a user will actually have: *why is my background
  not black any more* (pure txt2img — there is no source image to preserve, unlike AI
  Stylize), *why does the imagery flicker* (each frame is an independent generation; that
  is the look, and `fixed` seed mode plus a slower schedule is how you calm it), and *why
  did my 5-second fade become 1 second* (the clamp).
- `lib/paramHelp.ts` entries for `control_scale`, `trigger` and `reseed` — its test
  **fails** on a modulatable port without help, so this is not optional.
- `ui/Info.tsx` / `ArgInfo` "?" on every static control: `threshold`, `hysteresis`,
  `seedMode`, `seed`, `model`, and the per-prompt `fadeIn` / `fadeOut` / `span`.
- Update the Extract card's section to mention that its output now feeds two cards, and
  which one you want: AI Stylize to *restyle* footage that stays recognisable, Dream to
  *replace* it with invented imagery on the same skeleton.

## Repository docs

- **`ARCHITECTURE.md`** — the new modules and why they exist: `backend/cut_schedule.py`
  (the leaf that both scheduled cards share), `backend/dream_cache.py` (the per-frame
  cache and its relationship to `fluid_cache` / `render_cache.evict`),
  `backend/routes/dream.py` and `routes/_node_assets.py`, and `imagegen.dream_frames`
  beside `stylize_frames`. Record the invariant that the frontend `cutSchedule.ts` and the
  backend `cut_schedule.py` are mirrors held together by a shared fixture.
- **`README.md`** — the `/dream` route, the `/dream` route on `remote_app.py`, and
  `data/dream_cache/` in the storage section with its budget env vars.
- **`DEVELOPMENT.md`** — the add-a-node-type checklist gains a line for cards that carry a
  cut schedule: extend `ScheduledData`, reuse the shared mutations, do not fork the
  schedule. That is the mistake this wave exists to prevent someone repeating.
- **`CLAUDE.md`** — the `specs/dream/` row in the documentation map exists already (added
  when the folder was written, so the plan was findable); flip it from **NOT BUILT** to
  built and drop the "a plan only" clause.
- **`docs/render-versions.md`** — nothing to add. `RENDER_VERSION` was deliberately not
  bumped (step 04); that changelog records bumps, and a "we didn't bump" entry would be
  noise. The reasoning lives in step 04 where it belongs.

## Cross-references to keep honest

`specs/ai-stylize/README.md` lists "prompt crossfade" among the never-built parts of its
step 5. Dream builds a version of it — on a different card, with a different mechanism.
Add a pointer there so the next reader of that folder is not left thinking it is still
open. Do **not** mark the ai-stylize step as done: it isn't, and that folder's whole value
is that its status column is trustworthy.

## Flip this folder's status

Replace the README's **NOT BUILT** header with a **BUILT** one carrying the commit for
each step, the compositions-wave format. Each step file gets a status header. Any decision
that changed during implementation gets recorded in the step that changed it — including,
specifically, **the verdict on the Z-Image embedding lerp** from step 01's exit gate. That
is the open question this wave was built around; whichever way it fell, the answer belongs
written down where the next person will look.

## Verification

- vitest: the `Docs.tsx` anchor guard, the `paramHelp` coverage test.
- pytest: unchanged.
- `make lint`, `npx tsc --noEmit`.
- Read the guide section in the running app at `/?doc=<section>` and follow every "?" from
  the Dream card into it.
