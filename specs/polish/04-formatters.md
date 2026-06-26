# 04 — One-time Black + Prettier reformat + turn on the gate

> Black (Python) and Prettier (frontend) are **configured but never applied** — the
> one-time repo-wide reformat was deferred so it wouldn't be thrown away by the TS
> migration. After **spec 01** the frontend is `.tsx`, so Prettier formats the final
> files. This applies the reformat as a single isolated commit, records it for
> `git blame`, and flips on the CI `format:check` gate. **Formatter-only — zero logic
> change.** Do this **after spec 01**.

## Locked decisions

1. **One isolated reformat commit.** Run `make format` (Black + Prettier) and commit
   the result on its own — no logic edits mixed in — so `git blame` can skip it.
2. **After spec 01.** Prettier should reflow the `.tsx`, not throwaway `.jsx` (running
   it now would be redone). Black (backend) has no such dependency, but bundle both in
   the one commit for a single blame-ignore entry.
3. **Then gate it.** Enable the CI `format:check` (frontend, already present but
   commented) + a `black --check` step (backend), and document `pre-commit install`.
   After this, unformatted code fails CI.

## Architecture this builds on (all configured in the tooling batch)

- `pyproject.toml` `[tool.black]`: `line-length = 100`, `target py312`,
  `extend-exclude = .venv|data|frontend`.
- `frontend/.prettierrc.json` (printWidth 100, double quotes, es5 trailing commas) +
  `frontend/.prettierignore` (skips `dist`, `node_modules`, and the **generated**
  `src/lib/fluidParams.js`).
- `Makefile` `format` target: `black backend tests` + `cd frontend && npm run format`
  (`prettier --write "src/**/*.{js,jsx,css}"`).
- `frontend/package.json`: `format` + `format:check` scripts.
- `.git-blame-ignore-revs`: a placeholder file with instructions, awaiting the SHA.
- `.github/workflows/ci.yml`: a **commented** `format:check` step in the frontend job
  ("enable once the tree is formatted") + no backend `black --check` yet.
- `.pre-commit-config.yaml`: ruff + black + prettier hooks, ready for `pre-commit
  install`.

---

## Step 1 — Update the Prettier glob for `.tsx`, then run `make format`

**Goal.** Format the whole tree in one shot.

**Files.** `frontend/package.json` (broaden the `format`/`format:check` globs from
`{js,jsx,css}` to `{js,jsx,ts,tsx,css}`); then the reformat touches most of
`backend/`, `tests/`, `frontend/src/`.

**Design.**
- Ensure dev tools are installed (`pip install -r requirements-dev.txt`;
  `cd frontend && npm install`).
- Widen the Prettier globs to include `.ts`/`.tsx` (post-spec-01 the code is there).
- Run `make format`. Review the diff is **whitespace/format only** (no token changes):
  `git diff --stat` should be broad but `git diff -G'[A-Za-z]'` should show no logic.

**Reuse.** The existing `[tool.black]` + `.prettierrc.json` (don't re-tune; accept the
configured style).

**Acceptance.** `make format` runs clean; re-running it is a no-op (idempotent).

**Verification (two-audience).** *Agent:* after `make format`, `npm run format:check`
+ `.venv/bin/black --check backend tests` both report "all formatted"; the **full
suite stays green** (`pytest`, `npm run test`, `tsc`, `build`, `ruff`) — proving no
behaviour changed. *User:* skim the diff — only spacing/quotes/line-wraps.

**Risks.** Black may reflow the aligned `FLUID_PARAM_SPEC` / comment columns and
Prettier may explode compact one-line objects — that's expected and fine. Confirm
`fluidParams.js` is **not** reformatted (it's in `.prettierignore`; it's regenerated
by `make gen-params`).

---

## Step 2 — Commit the reformat alone + record the SHA

**Goal.** An isolated, blame-skippable commit.

**Files.** the reformat (many) in **one** commit; then `.git-blame-ignore-revs`.

**Design.** Commit the `make format` output by itself with a clear message
("Reformat: Black + Prettier (no logic change)"). Then add that commit's SHA to
`.git-blame-ignore-revs` (in a tiny follow-up commit) and tell users to enable it:
`git config blame.ignoreRevsFile .git-blame-ignore-revs`.

**Acceptance.** Two commits: the reformat, then the blame-ignore entry. `git blame`
with the config set skips the reformat.

**Verification (two-audience).** *Agent:* `git show --stat <reformat>` is format-only;
`git log` shows the isolated commit. *User:* `git blame` a reformatted line points at
the real author, not the reformat.

**Risks.** Don't squash logic into the reformat commit. If a pre-commit hook is
already installed it may re-touch files — run with `--no-verify` for this one commit
if needed.

---

## Step 3 — Turn on the CI gates

**Goal.** Unformatted code now fails CI.

**Files.** `.github/workflows/ci.yml`.

**Design.**
- Frontend job: uncomment the `format:check` step (`npm run format:check`) after
  `lint`.
- Backend job: add `pip install black` to the lint tooling install + a step
  `black --check backend tests` after Ruff.
- Add `npm run typecheck` is already gated; nothing else needed.

**Reuse.** The commented step + the existing `requirements-dev.txt` pin.

**Acceptance.** CI runs format checks; a deliberately mis-formatted file fails the run.

**Verification (two-audience).** *Agent:* push → CI green; (optionally) a throwaway
mis-format makes it red, then revert. *User:* none.

**Risks.** Black/Prettier versions must match local (pin `black` in
`requirements-dev.txt`; Prettier is in `package-lock`). Mismatched versions = CI flags
files local says are clean — pin both.

---

## Step 4 — Document pre-commit (optional, recommended)

**Goal.** Catch formatting before push.

**Files.** `DEVELOPMENT.md` (a line under "Formatting").

**Design.** Note: `pip install pre-commit && pre-commit install` enables the
ruff+black+prettier hooks (`.pre-commit-config.yaml` already exists). Update the
"Formatting" section to say the one-time reformat is **done** and the gate is on.

**Acceptance / Verification.** *Agent:* docs build/read; `pre-commit run --all-files`
is clean (everything already formatted). *User:* a commit with a stray format gets
auto-fixed by the hook.

**Risks.** Keep `.pre-commit-config.yaml` rev pins in sync with CI/`requirements-dev`.

---

## v1 boundary & extension points

**This spec:** the tree is uniformly Black/Prettier-formatted, the reformat is
blame-skipped, and CI + pre-commit enforce it. **Designed-for:** future diffs are
logic-only (no whitespace churn); a new contributor's editor + the pre-commit hook
keep it that way with zero manual effort.
