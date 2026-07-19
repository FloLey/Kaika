# Step 23 — CI tests what you actually run

**Tier.** Core.

**Goal.** Close the gap between the dependency set CI validates and the one the app runs on,
and finish the gating work wave-2 step 02 started.

**Blocked by.** Nothing.

**Size.** M.

> Line numbers are a snapshot — re-grep before relying on one.

---

## 1. CI installs unpinned versions of the packages `requirements.txt` pins deliberately

`.github/workflows/ci.yml:51`:

```yaml
run: pip install numpy scipy librosa matplotlib soundfile flask "psycopg[binary]" pillow
```

Not one version constraint. Meanwhile `requirements.txt:5-15` pins every one of those —
`numpy==2.4.6`, `scipy==1.18.0`, `librosa==0.11.0`, … — under a header that says exactly why:

> *"Pinned to a known-good environment (torch/librosa/demucs combos are brittle across
> versions)."*

So CI validates a combination that is never run in production, and an upstream minor release
can turn a green PR red for reasons unrelated to the change. It also fails the other way,
which is worse: a bug that only appears on the pinned versions passes CI.

Wave-2 step 02 made CI *run* the suite. This makes it run the suite against the right thing.

**The change:** install from `requirements.txt` (or a constraints file derived from it) rather
than a hand-listed set. ⚠ Check first *why* the list is hand-written — it is probably to avoid
installing torch/demucs on a CI runner. If so, a constraints file (`pip install -c
requirements.txt numpy scipy …`) keeps the narrow install set while inheriting every pin,
which is the better fix than expanding what CI downloads.

## 2. Tool versions pinned in three places, with nothing keeping them equal

ruff `0.15.19` and black `26.5.1` each appear in:

- `.github/workflows/ci.yml:36`
- `requirements-dev.txt:5,8`
- `.pre-commit-config.yaml:6,11`

They agree today. Bump one and the pre-commit hook silently formats differently than CI
checks — a class of problem that presents as "CI fails on formatting I already ran".

`pip install -r requirements-dev.txt` at `ci.yml:36` collapses two of the three. The
pre-commit config is harder to deduplicate; at minimum add a comment at each site naming the
others.

## 3. `scripts/` is linted by nothing

`ci.yml:38,40` and the Makefile's `lint` target both scope to `backend tests`. Result:

- `ruff check scripts` → **22 errors** (11× E401, 7× E702, 1× F401 — a dead `sys` import at
  `scripts/_zimage_matrix.py:5`)
- `black --check scripts` → **7 files would be reformatted**

There is also a stale `scripts/__pycache__/_zimage_test.cpython-312-pytest-9.1.1.pyc` for a
test file that no longer exists.

All seven files landed in one batch on 2026-07-18 and read as one-off exploration
(`_build_hd_matrix.py`, `_diffdiff.py`, `_matrix3.py`, `_zimage_matrix.py`, …).

**Decide, and act on the decision:**

- If they are keepers → add `scripts` to the lint scope in both `ci.yml` and the Makefile, and
  fix the 22 errors.
- If they were exploration → move them to `docs/history/` or delete them.

Leaving them half-in is the worst of the three options: they look like project code, they are
held to no standard, and the next person cannot tell which.

## 4. The frontend has no coverage floor

`pyproject.toml:34` sets `fail_under = 70` for the backend. `frontend/vite.config.js` has no
`coverage.thresholds` at all — so frontend coverage can slide from its current 72% to 40%
with CI fully green.

Add a threshold. **And exclude `components/docs/`** while doing it: 17 static-JSX doc
components sit at 100% and inflate the headline number, so today's 72% overstates how much
*logic* is covered. Set the floor from the post-exclusion number, not the current one.

While here: `pyproject.toml`'s `fail_under = 70` is now 8 points below the measured 78%. Its
own comment says to raise it "when a coverage step banks real ground". Wave 2 banked it —
raise to 75. (The same comment is factually stale; step 28 fixes the prose.)

## 5. Cheap hygiene

- **No `concurrency` block** — superseded pushes burn a full Postgres-backed run.
  `concurrency: { group: ..., cancel-in-progress: true }`.
- **No `timeout-minutes`** on either job — a hung test wedges a runner for the default 6 hours.
- No coverage artifact upload, so a coverage regression is invisible unless you read the log.

**Not worth doing:** splitting lint into a third job to fail faster. The comment at `ci.yml:34`
shows the current ordering was deliberate, and the gain is marginal.

---

## Verification

1. **The pinning fix proves itself**: check the CI log shows the pinned versions, and that
   `pip` does not resolve a newer numpy.
2. Deliberately bump ruff in one of the three files → confirm the mismatch is now either
   impossible or loudly visible.
3. `make lint` and CI still agree — run both, compare. The Makefile↔CI mirror is a wave-2
   property worth not breaking.
4. Drop a frontend test file → the coverage threshold fails CI.

## Acceptance criteria

- CI installs versions that match `requirements.txt`.
- ruff/black versions come from one file wherever mechanically possible; comments where not.
- `scripts/` is either linted and clean, or gone from the working tree.
- `frontend/vite.config.js` has a coverage threshold, with `components/docs/` excluded.
- `pyproject.toml` `fail_under` raised to 75.
- `concurrency` and `timeout-minutes` set.

## Risks

- **Pinning surfaces a pre-existing break.** If CI has been passing *because* of a newer
  package version, pinning turns that into a red build. That is the finding working as
  intended — fix the incompatibility, do not unpin.
- **A coverage floor set at exactly the current number** turns every unrelated PR into a
  coverage negotiation. Set it a few points below and raise it deliberately, which is what
  the backend gate already does.
