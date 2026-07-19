# Step 10 — Backend big-function surgery

**Goal.** Shrink the four functions that are either copy-paste or unreviewable. No behaviour
change anywhere in this step.

**Blocked by.** Step 04 (for `validate` — **hard**), step 07 (for `sources.py`).

> Line numbers are a snapshot — re-grep before relying on one.

---

## ⚠ The safety asymmetry — read this before picking an order

The two biggest items in this step sit at opposite ends of the risk scale, and it is not
intuitive which is which:

- **`SOURCE_PARAM_SPEC` is the largest line win in the entire plan (~590 lines) and the
  safest thing in it** — `tests/test_fluid_params_codegen.py` is a byte-exact no-diff guard
  on the generated output, so any mistake is instantly loud. **Land it as commit 1.**
- **`validate` is small and dangerous** — validation fails *open*. A rule dropped during the
  split doesn't throw; the graph just renders wrongly. Nothing goes red. **Unsafe before
  step 04's per-rule cases.**

---

## 1. `animation_params.py:218-894` — 80 copy-pasted dicts → a `_p()` helper

`SOURCE_PARAM_SPEC` contains **80** dicts of the identical shape
`{"key", "label", "min", "max", "step", "default", "fmt"}`, each spanning 9 lines. The file
already proves the pattern works — `_opacity_spec` (`:206`).

```python
def _p(key, lo, hi, default, step=0.01, fmt="dp2", label=None): ...
```

with `label` defaulting to `key.replace("_", " ")`. The table collapses from ~680 lines to
~90. Two literals are byte-identical duplicates — the `trigger` spec at `:229` and `:257`
(slideshow / montage) — which should become `_trigger_spec()`.

The codegen test makes this verifiable in a way almost nothing else here is: if the
generated `fluidParams.js` is byte-identical afterwards, the refactor is provably correct.

## 2. `graph_validate.validate:41-174` — one 130-line function, six rules

C901 **35**, 34 branches, 58 statements — the worst in the repo. It is already six
comment-delimited sections; split them **verbatim** into named checks and have `validate`
call them in order:

| `_check_outputs` | `:63-87` |
| `_check_bindings` | `:90-93` |
| `_check_combine_slots` | `:96-99` |
| `_check_montage_exclusivity` | `:107-151` |
| `_check_merge_sources` | `:155-164` |
| `_check_acyclic` | `:166-174` |

While here:

- `_video_producers()` (`:17`) is a one-line wrapper around the `VIDEO_PRODUCERS` constant,
  called 4×. Inline it — step 08 makes the constant generated anyway.
- `_nodes_of(graph, "combine")` is walked twice (`:96` and `:155`). One loop.

**Verbatim means verbatim.** Move the bodies without "improving" them. If a rule looks
wrong, note it and fix it in a *separate* commit where the diff shows the behaviour change.

## 3. `imagegen.stylize_frames:311` — 170 lines, 11 parameters

C901 16, 17 branches, 69 statements. Concrete split:

- `_stylize_defaults(model, short, control_scale, control)` — the default-resolution block
  at `:337-372`
- `_stylize_remote_or_none(...)` — `:352-372`
- `_zimage_control_run(...)` — the hand-rolled img2img on the Union pipeline
- `_diffusers_run(...)`

Leaves a ~40-line orchestrator. Note step 07 changes how stylize is *invoked*; this changes
what happens inside. Do them in that order, not together.

## 4. `sources.py` — the gen-sim scaffold and three `_apply_opacity` copies

`waves` (`:396`), `lightning` (`:567`), `aurora` (`:682`), `rain` (`:795`) and `clouds`
(`:927`) all repeat the same preamble/epilogue:

```
procgen.sim_dims → clocks = [_clock(lr["speed"], fps) …] → out = np.empty((nframes,h,w,4), np.uint8)
→ for i: idx = frame_offset + i → out[i] = _rgba(rgb, alpha)
```

A `_gen_frames(nframes, h, w, layers, fps, frame_offset, render_one)` scaffold removes ~40
lines and — the actual point — makes the `frame_offset` contract enforced in **one** place
instead of five. `frame_offset` is what keeps a streamed block aligned with the whole clip;
five hand-written copies of it is five chances to be subtly wrong.

**Do not over-unify: the physics bodies stay put.** They are the part that should differ.

Also: `_apply_opacity` (`:272-280`) and `apply_video_opacity` (`:1315-1319`) do the same
alpha scaling with different signatures, and `SlideshowClip.frames:1294-1295` inlines a
third copy. One helper.

Ruff complexity in this file for reference: `lyrics` C901 14 / 56 statements, `waves` 57
statements, `lightning` C901 14 / 58 statements.

---

## Acceptance criteria

1. **`_p()`**: `make gen-params` produces a byte-identical `fluidParams.js`, and
   `test_fluid_params_codegen.py` is green. This is the proof — do not accept "looks right".
2. **`validate`**: every one of step 04's per-rule cases stays green. Delete each extracted
   check in turn and confirm its case goes red.
3. **`sources.py`**: `test_card_impact.py::test_whole_clip_matches_the_block_stream` green
   for the five gen-sim cards — that is the test that would catch a `frame_offset` mistake.
4. **`stylize_frames`**: `test_imagegen.py` green, plus a real stylize render via `make dev`.

## Risks

- **The `_p()` positional-argument order.** 80 call sites, and `min`/`max`/`default`/`step`
  are all floats — a transposition type-checks fine. The codegen no-diff guard catches it,
  which is exactly why this lands first, while attention is fresh.
- **`_gen_frames` closing over the wrong `frame_offset`.** The block path is the only one
  that exercises a non-zero offset; make sure the parity test covers a streamed render of
  each gen-sim card, not just a whole-clip one.
