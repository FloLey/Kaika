# Step 28 — Test hygiene and stale numbers

**Status: DONE** — `66a842e`. jsdom noise 20 → **0** lines. ⚠ The `getContext` stub must be
UNCONDITIONAL: jsdom *defines* the method and throws inside it, so the obvious
`if (!prototype.getContext)` guard never fires — that took it 20 → 8, not 20 → 0.

`NOAUDIO` → `helpers.no_audio` across 15 files; `E731` in tests 15 → 4. Stale numbers
corrected (`graph.py` 87 → **66** lines; the coverage comment was wrong on four of five
figures) and `fail_under` raised 70 → **72** against a measured 79%.

⚠ **`torchcodec` is NOT dead, and this file's own warning is why we know.** Zero references
in `backend/`, `pip` `Required-by` empty — but torchaudio 2.11 imports it from its own
`__init__` as the decode backend and does not declare it. Deleting it would have broken
demucs stem separation at load time. Kept, and given the comment it was missing.

**Tier.** Optional. A grab-bag of small things, none of which blocks anything, all of which
cost more to keep explaining than to fix.

**Goal.** Make `npm test` output readable, delete a lambda copy-pasted into 14 files, and
correct four documented numbers that are no longer true.

**Blocked by.** Nothing.

**Size.** S.

> Numbers measured 2026-07-20 — re-measure before relying on one.

---

## 1. `npm test` prints ~40 lines of jsdom stack traces on a green run

Every frontend run dumps `Not implemented: HTMLMediaElement.prototype.play`,
`.pause`, and `HTMLCanvasElement.getContext` traces — from `BoxPad.tsx:171`, `:355`, `:365`.
The suite passes. It reads as broken.

Stub `HTMLMediaElement.prototype.play` / `pause` and `getContext` in
`frontend/src/__tests__/setup.ts`. About six lines.

**Why this is worth a step item and not just a nit:** noise trains you to ignore test output,
and this repo has direct experience of what that costs — wave 1 exists because a segment
rendering 79 frozen frames out of 80 shipped through a green suite. A test run whose output
you have learned to skim is a test run that cannot warn you.

⚠ Stub, do not silence. A `console.error` filter would also hide *real* errors from those
APIs. Provide no-op implementations so the calls succeed, and if any test actually depends on
playback behaviour, give it a spy rather than a no-op.

## 2. `NOAUDIO` is copy-pasted verbatim into 14 test files

```python
NOAUDIO = lambda j, s: None  # noqa: E731
```

Identical in: `test_resolve_points.py:7`, `test_gen_sim_cards.py:23`, `test_fluid_cache.py:20`,
`test_graph_transform.py:18`, `test_graph_points.py:12`, `test_song_render.py:20`,
`test_imagegen.py:21`, `test_stream_render.py:30`, `test_look_fx.py:18`, `test_montage.py:28`,
`test_sources_layers.py:26`, `test_graph_combine.py:21`, `test_dag_lifetime.py:30`,
`test_export_segment.py:25`.

`tests/helpers.py` already exists as the designated home for shared test vocabulary and
already holds `out()` / `graph_of()` / `assert_moves()`. Move it there as a plain function
(`def no_audio(job, stem): return None`) and the 14 duplicated lines and 14 `noqa: E731`
suppressions go with it.

That is 13 of the repo's 20 `E731` suppressions removed by one definition.

## 3. Four `eslint-disable exhaustive-deps` with no written reason

The repo has 16 `eslint-disable`s total, 14 of them `exhaustive-deps`, and **12 of the 14 carry
a specific justification** naming the intended dep and why — e.g. `useResolvedPoints.ts:55-57`
explains it refetches on the upstream signature rather than graph object identity, and the
refs keep the posted graph fresh. That is a well-managed suppression pattern.

Four are bare. Line numbers point at the `eslint-disable-next-line` comment; the dep array is
the line after it:

| Site | Deps kept | Note |
|---|---|---|
| `nodes/useStreamRender.ts:231` | `[renderKey, gate]` | **do this one first** |
| `nodes/ImagegenNode.tsx:83` | `[needed]` | |
| `nodes/ImagegenNode.tsx:89` | `[srcId]` | |
| `export/ExportStep.tsx:63` | `[canvasRatio]` | |

`useStreamRender.ts:231` is the highest-risk: its cleanup closure reads `lane`, `slotHeld`,
`myRender`, `releaseSlot` and `api`; the hook sits at 47% coverage; and
`docs/cleanup/README.md` already names `useStreamRender.ts:158` as *"the existing proof that a
bad cast reaches the wire."*

Writing the reason is not busywork here — it forces someone to confirm the omission is
actually safe. If it turns out one of the four is *not* safe, that is a bug found, and it
should become its own commit.

**Related, from the same file:** `useStreamRender.ts:231`'s effect closes over
`segment.signals`, which reaches the POST body at `:164`. A signal edit during an in-flight
render posts the stale value. Low probability, and the fix is a `signalsRef` — which
`useResolvedCurve.ts:32-33` already does for the same staleness problem. Two hooks solving one
problem two ways is a small drift worth collapsing while here.

## 4. Numbers that are no longer true

**`ARCHITECTURE.md:58`** — `graph.py ← 87-line facade`. It is **66** lines; wave-2 steps 09/10
shrank it.

**`pyproject.toml:29-32`** — the `fail_under` comment is wrong on four of five figures:

> *"Measured 75% on the full suite (2026-07-19) … the thin modules today are segment.py (13%),
> render_jobs.py (25%), llm.py (28%), imagegen.py (23%) and routes/export.py (30%)."*

| Claim | Measured 2026-07-20 |
|---|---|
| total 75% | **78%** |
| segment.py 13% | **43%** |
| render_jobs.py 25% | **99%** |
| llm.py 28% | 28% ✓ |
| imagegen.py 23% | 23% ✓ |
| routes/export.py 30% | **46%** |

`render_jobs.py` went 25% → 99% and the comment still calls it thin. (Step 23 raises the gate
itself to 75; this item fixes the prose.)

**`specs/cleanup/15-coverage-debt.md`** is stale twice: it calls `segment.py` "zero direct
tests" (now 43%, `tests/test_segment_helpers.py` exists) and lists `backend/config.py` as
zero-coverage (it is at 100% — absent from the term-missing report because `skip-covered`
drops it). Its `procgen.py` half is still correct and still undone → step 22.

**`requirements.txt:9`** — `torchcodec==0.14.0` has **zero references** in `backend/` or
`scripts/`, and is the only pin in the file with no explanatory comment while every neighbour
has one. Either it is a transitive of demucs/torchaudio that got promoted to a direct pin — in
which case say so — or it is dead. ⚠ Do not just delete it: try a clean install without it
first, because a transitive that something imports lazily will not show up in a grep.

**`frontend/package.json`** has no `engines` field. CI uses node 20; a contributor on node 18
gets a confusing vite failure instead of a clear one. One line.

---

## Verification

1. `npm test` → clean output, still green, same test count.
2. `make test` → 642 backend tests still pass after the `NOAUDIO` move.
3. `ruff check backend tests` → the `E731` count drops by 13.
4. `wc -l backend/graph.py` matches what `ARCHITECTURE.md` claims.
5. Coverage re-measured and the `pyproject.toml` comment matches it.
6. `torchcodec`: clean venv install without it, then `make test` — if anything fails, it stays
   and gets a comment.

## Acceptance criteria

- No jsdom "Not implemented" output on a green frontend run.
- One `NOAUDIO`/`no_audio` definition, in `tests/helpers.py`.
- All four `exhaustive-deps` disables carry a reason — or a bug is filed where one turned out
  not to be safe.
- Every number in items 4 is either corrected or re-verified.

## Risks

- **Over-broad jsdom stubs** hiding a real failure — stub the specific APIs, not the console.
- **`torchcodec` removed while lazily imported.** The clean-install check is the guard; do not
  rely on grep alone.
- This step touches many files shallowly. **Keep it as several small commits**, one per item,
  so a mistake in the jsdom stub does not have to be untangled from a docs correction.
