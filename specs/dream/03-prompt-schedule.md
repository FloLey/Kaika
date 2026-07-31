# 03 — The schedule → per-frame plan, mirrored front and back

> **Status: BUILT.** `backend/cut_schedule.py` (`effective_cuts`, `part_starts`,
> `dream_plan`, `_clamped_fades`, `_weight`), `frontend/src/lib/cutSchedule.ts` (renamed
> from `montageCuts.ts`; `dreamPlan`, `clampedFades`, `blendWeight`, `partStarts`),
> `tests/fixtures/cut_schedule_cases.json` read by both `tests/test_cut_schedule.py` (24)
> and `frontend/src/__tests__/cutSchedule.test.ts` (21). `_montage_cut_frames` →
> `_cut_frames`; the montage suites pass unmodified except for the renames.
>
> One thing the fixture forced into the open: a plan entry carries **`prompt_b: null`
> whenever `w == 0`**, even on a frame that sits at the very start of a transition. That
> matches `dream_cache.canonical_prompts` (at w=0 the second prompt cannot touch a pixel,
> so it must not touch the key) and it is what makes a cut nudge invalidate only the ramp.

**Goal:** turn `(cuts, prompts, seed mode, control-scale curve)` into the length-`T` plan
step 01 consumes. Pure functions on both sides, no card yet. The frontend twin exists
because step 05's timeline draws the parts and their fade ramps — and if the two
implementations disagree, the timeline lies about what the render will do.

**Prerequisites:** steps 01–02.

## Extracting the shared schedule

The montage's cut machinery is already card-agnostic; only its names say otherwise.

- **Backend.** `_effective_cuts(trigger, d, fps, nframes)` reads `threshold`,
  `hysteresis`, `disabledCuts` and `manualBreakpoints` off a plain data dict and cares
  about nothing else — it works on `DreamData` unchanged. Move it, plus
  `_montage_starts(cuts, spans)` → `_part_starts`, out of `graph_render.py` into a new
  leaf module **`backend/cut_schedule.py`**, joined by this step's `dream_plan`. Leaf so
  the schedule can be imported and tested without dragging in the render DAG — the
  `graph_common` precedent ("the producer set lives in the leaf so validate needn't import
  this module"). `graph_render.py` is 2269 lines; it does not need to own pure arithmetic.
- **`_montage_cut_frames` stays in `graph_render.py`**, renamed `_cut_frames`, because it
  is genuinely dag-aware: it re-resolves the trigger at the project's editing fps when an
  HD export runs at a different one. Dream must inherit this, not re-discover it — a
  30 fps export once found one gate rise that the 24 fps editor timeline had not, and
  every later montage extract played a slot early. Dream would fail the same way, one
  prompt out of step for the rest of the song, and it would look like a prompt bug.
- **Frontend.** `lib/montageCuts.ts` → **`lib/cutSchedule.ts`**; `montageStarts` →
  `partStarts`; `cutMarks` and `effectiveCuts` keep their names. Add `dreamPlan`, the twin
  of the backend function. Update the montage imports in the same commit — no re-export
  shim, per the cleanup mandate.

Renaming shipped montage internals is deliberate. Two cards now depend on this code, and a
name that says "montage" invites the next person to fork it rather than share it.

## `dream_plan`

```python
def dream_plan(cuts, prompts, fps, nframes, *, seed, seed_mode,
               reseed_frames=None, scale=None) -> list[dict]
```

Returns one `{prompt_a, prompt_b, w, seed, scale}` per frame.

**Parts.** `_part_starts(cuts, spans)` gives each prompt's start frame, span-consumption
and hold-last unchanged from montage: more cuts than prompts and the last prompt holds to
the window end; more prompts than cuts and the surplus never plays. Part `k` runs
`[start_k, start_{k+1})`.

**The fade clamp, first.** For each part of duration `D`, cap `fadeIn + fadeOut` at `D`,
scaling both down proportionally on overflow. Do this before anything else, because it is
what guarantees adjacent transitions cannot overlap: transition *k−1*→*k* ends at
`c_k + i_k`, transition *k*→*k+1* begins at `c_k + D_k − o_k`, and they stay disjoint
exactly when `i_k + o_k ≤ D_k`. So the clamp is not tidiness — it is the invariant that
keeps at most two prompts blending, which in turn is what lets the embedding lerp take a
pair and the cache key take a pair.

**The weight.** At cut `c` between parts `k` and `k+1`, with `o = fadeOut(k)`,
`i = fadeIn(k+1)`, and `t = f / fps`:

```
w = 0                          t ≤ c − o
  = (t − (c − o)) / (o + i)    inside
  = 1                          t ≥ c + i
o + i == 0  →  0 before c, 1 at and after c
```

Frames outside every transition get `w = 0` and `prompt_b = None`, which is what step 02's
key canonicalization keys on.

**Seeds.** Deterministic in all three modes — non-determinism would poison the cache:

| mode | per-frame seed |
|---|---|
| `fixed` | `seed` |
| `frame` | `seed + f` |
| `gate` | `seed + (number of reseed events at or before f)` |

`reseed_frames` comes from the `reseed` port's gate rises, resolved through the same
hysteresis path as the trigger. **Unwired, it falls back to the cut frames** — so the
natural default of `gate` mode is "a fresh image family per prompt", which is what you
want without wiring anything. Wire a separate signal and you re-roll *within* a part.

**Scale.** `scale` is the resolved `control_scale` curve, sampled per frame, defaulted per
model when absent (0.65 for the Z-Image Union — alibaba-pai's own sweet spot, stronger
flattens texture; 0.8 for SD).

## Risks

- **Front/back drift** is the failure mode of this step, and it is silent: the timeline
  shows one thing and the render does another. Mitigation is a shared fixture — a JSON
  file of `(schedule input → expected plan)` cases read by *both* pytest and vitest, so
  neither side can be "fixed" alone. `montageCuts.ts` carries the same warning in prose;
  this makes it enforceable.
- **The rename touches montage.** It is a mechanical rename with a green test suite on
  both sides, but it is the one part of this wave that can break a shipped card. Land it
  as its own commit within the step, tests first.
- **Off-by-one at cut frames.** `_effective_cuts` returns the frame the cut *lands on*
  (`rises + 1`), and the hard-cut branch flips at `t ≥ c`. Fence-post errors here shift
  every prompt by a frame — cheap to test, expensive to eyeball.

## Deliberately not done

- **No per-prompt seed override.** Three modes cover the ground; a fourth "this part has
  its own seed" field is speculative until someone wants it.
- **No easing on the fade.** `w` ramps linearly. A smoothstep would be one line, but the
  ramp feeds an *embedding lerp* whose perceptual midpoint is already unknown (step 01) —
  adding a second unmeasured curve on top would make the first one unmeasurable.

## Exit gate

`dream_plan` and `dreamPlan` agree on the shared fixture, including the clamped cases.

## Verification

- pytest: part assignment (span, hold-last, surplus prompts, manual-only schedules); the
  clamp (overflowing fades scale proportionally; a zero-length part degenerates safely);
  weight at and around each boundary, both the ramped and `o+i==0` branches; all three
  seed modes deterministic; `gate` with no `reseed_frames` falls back to cuts; the shared
  fixture.
- vitest: the same fixture through `dreamPlan`; `cutSchedule.ts` re-exports still serve
  the montage suites unchanged.
- `make lint`, `npx tsc --noEmit`.
