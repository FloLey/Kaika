# Step 02 — CI runs the tests it claims to run

**Goal.** Make "every commit ends green" mean something. Today CI is green on a suite it
never executes: ~9 backend test files and the entire HTTP layer skip silently on every push.

**Non-goals.** No refactoring, no behaviour changes. This step only makes the existing suite
actually run. Every later step's green-commit claim is unverifiable until it lands.

> Line numbers are a snapshot from the audit that produced this file — re-grep before
> relying on one.

---

## The hole

`.github/workflows/ci.yml:27` installs:

```
numpy scipy librosa matplotlib soundfile flask "psycopg[binary]"
```

No `torch`. No Postgres service. So everything gated on those skips:

| Gate | Files that never run in CI |
|---|---|
| `pytest.importorskip("torch")` (module level, or via `conftest.py:114`'s `client` fixture) | `test_app_routes.py`, `test_assets.py`, `test_imagegen_route.py`, `test_remote_infer.py`, `test_seed_export.py`, `test_lyrics_edit.py`, `test_stylize_route.py`, `test_studio_e2e.py`, `test_export_segment.py`, `test_settings.py` |
| `live_db` (`conftest.py:121`) | `test_db.py` + 6 others |

The whole HTTP layer, the asset library, settings, stylize, imagegen routes and both e2e
tests are unexecuted. That is the seam `01-safety-net.md` identified as the one where both
of that week's shipped bugs lived.

**The bitter part:** `tests/conftest.py:138-174` already implements `--strict-deps`,
written precisely to turn these silent skips into a failure. CI does not pass it. The
machinery to catch this exists and is switched off.

---

## Commits

### 1. `ci.yml` — install what the suite needs

- Add a `services: postgres` block to the backend job.
- Install CPU torch: `pip install torch --index-url https://download.pytorch.org/whl/cpu`.
  It is a heavy install; if job time becomes a problem, split a second job rather than
  dropping back to skipping — a slow honest CI beats a fast dishonest one.
- Run `pytest --cov=backend --strict-deps -m "not perf"`.

**Expect fallout.** Tests that have never executed on a clean machine will fail. That
fallout *is* the deliverable of this step — fix it here, and do not let it leak into a
refactor commit where it will be mistaken for regression.

### 2. Honour the `perf` opt-out that is documented but unimplemented

`pyproject.toml:9-12` documents `-m "not perf"` as the way to deselect wall-clock budgets
on a busy machine, but sets no `addopts`, and both `Makefile:52` (`pytest -q`) and
`ci.yml:32` (`pytest --cov=backend`) run them anyway. Nothing actually deselects them.

Decide one way and make the code match the comment: either add the marker filter to the
default `addopts` and give `make test-perf` as the opt-in, or delete the sentence. Note
`test_perf_budget.py:56` and `test_card_impact.py:49` reach into `graph._Dag` — a private
name that step 09 renames, so leave a comment pointing there.

### 3. `make lint` / `make test` mirror CI — for real this time

`Makefile:48` carries the comment `# ---- quality gates (mirror CI)`. They do not mirror
CI. CI additionally runs `black --check` (`ci.yml:22`), `npm run typecheck` (`:45`) and
`npm run format:check` (`:47`).

```make
lint:
	.venv/bin/ruff check backend tests
	.venv/bin/black --check backend tests
	cd frontend && npm run lint && npm run typecheck && npm run format:check
```

Add a `typecheck` target too — `package.json` already has the script, and `CLAUDE.md:25`
currently tells the reader to run `npx tsc --noEmit` by hand while `CLAUDE.md:75` demands
every commit be green including it. Then `DEVELOPMENT.md:16` ("Quality gates (mirror CI)")
and `README.md:184-190` become true statements rather than aspirations.

### 4. Fix the `coverage` target, and decide whether coverage is a gate

`Makefile:67`:

```make
.venv/bin/python -m pytest --cov 2>/dev/null || .venv/bin/python -m pytest --cov=backend
```

`--cov` already works (`pyproject.toml:22` sets `source = ["backend"]`), so the fallback is
dead — but if any *test* fails, the non-zero exit triggers the `||` and the entire suite
re-runs with the first run's output sent to `/dev/null`. Collapse to one line.

Separately, `pyproject.toml:26-29` ends with a dangling comment describing an
`include`/`fail_under` setting that was never written. Either write it or delete the
comment; a config that describes a gate it does not implement is worse than no gate.

### 5. Reconcile `00-backlog.md`

It mixes finished and open work, which makes this whole series hard to read from commit
one. Steps 0, 3 and 4a are done (`helpers.py`, `--strict-deps`, `_whole_from_block`,
`VIDEO_PRODUCERS` → `graph_common`). Still open and still true: Step 2's split (it names
`graph_render.py` at 2047 lines — it is now **2090**), and Step 4's codegen. Its "`OUT`
dict redefined in 12 files" is now **15**.

Move the completed sections to `docs/history/` and leave `00-backlog.md` as open items with
a pointer to this series.

---

## Acceptance criteria

1. The Actions log shows the previously-skipped files **executing** — check for named tests
   from `test_app_routes.py` and `test_db.py` in the output, not just a green tick.
2. `--strict-deps` fails the run if a dependency goes missing. Verify by temporarily
   removing torch from the install step and confirming CI goes red rather than green-with-skips.
3. `make lint` locally catches a deliberately mis-formatted Python file and a deliberate
   type error in a `.tsx` file.
4. `make coverage` with one failing test reports that failure instead of silently re-running.

## Risks

- **Job time balloons** with torch + Postgres. Acceptable; split jobs if it becomes painful.
- **A wave of newly-red tests** that were never true. Resist the urge to fix them inside
  later steps — triage them here, and if any is genuinely obsolete, delete it with a note
  rather than leaving it skipped.
