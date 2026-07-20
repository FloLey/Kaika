# Step 09 — Backend shims and duplicates

**Goal.** Delete the compatibility layer and the verbatim copies, so the module surface
describes what is actually public.

**Blocked by.** Step 04 (export + jobs tests), step 07, step 08.

> Line numbers are a snapshot — re-grep before relying on one.

---

## ⚠ Sequencing

The `_Dag` rename is ~83 mechanical edits inside `graph_render.py` — the same file step 07
rewrites. **Land it after 07, never concurrently.** A rename colliding with a handler
rewrite produces a diff nobody can review and a bisect nobody can use.

---

## 1. Compatibility shims

- **`graph_render.py:2089-2090`** — `_Dag = Dag`, plus **83** internal `"_Dag"` string
  annotations. Rename to `Dag` throughout and drop the alias. Note two tests reach for the
  private name (`test_perf_budget.py:56`, `test_card_impact.py:49`) — update them, and take
  the opportunity to ask whether `Dag` should just be public.
- **`graph_render.py:1965`** — `_VIDEO_PRODUCERS = VIDEO_PRODUCERS  # back-compat name`.
  Step 08 makes the real thing generated; the alias has no reason to survive.
- **`graph.py`** bottom — `_encoder_error = fluid.encoder_error`.
- **`graph.py`** re-exports ~18 names nobody imports: `LEGACY_GRID`, `RENDER_BLOCK_SECONDS`,
  `_BLOCK_HANDLERS`, `_MERGE_MEDIUM_DEFAULTS`, `_PORT_SPECS`, `_SIGNAL_HASH_FIELDS`,
  `_fluid_cache_key`, `_fluid_for_output`, `_is_emitter_source`, `_node_for_hash`,
  `_output_params`, `_referenced_signal_defs`, `_resolve_node_color`, `_sample_gradient`,
  `_signal_curve`, `_sim_blocks`, `_sim_video`, `_source_statics`.

  `CLAUDE.md:52` calls `graph.py` a facade — "import from them, implement in
  `backend/graph_*.py`". A facade re-exporting 18 unused private names isn't describing a
  public surface, it's hoarding. `tests/test_graph_registry.py` guards the ones that matter;
  trim the rest.

- **`sources.py:833-836`** handles pre-v23 `assetUrls` legacy slideshow data, and
  `graph_render.py:811` `_slideshow_kind` exists only as its fallback. This one needs a
  **decision, not a deletion**: is the v23 migration complete for real projects in the wild?
  If yes, delete both. If unsure, leave them and add the comment saying when they can go.

## 2. Verbatim duplicates

- **`jobs.py:73-83` `_prune_locked` ≡ `render_jobs.py:34-42`.** The docstring even says
  "mirrors `render_jobs._prune_locked`". One `_prune(jobs, maximum)` in a shared module.
  *Covered by step 04's tests — do not do this before them.*
- **`routes/export.py` HD-slot admission** (`:76-89` ≡ `:139-151`) → `_start_hd_job(fn)`.
- **`routes/export.py` job teardown** (`:167/222-224` ≡ `:231/256-258`) — same extraction
  covers it.
- **`routes/export.py:184-185` ≡ `:241-242`** — a verbatim `def progress(done, total,
  preview_url=None)` wrapper.
- **`export = {**_EXPORT_DEFAULTS, **(data.get("export") or {})}`** at `:64` and `:117`.
- **`_regenerate_hd_images:286` / `_regenerate_hd_stylize:354`** share the whole shape:
  collect typed nodes across segments → content-hash key → `dest.exists()` skip →
  `db.add_asset({...})` → rewrite `n["data"]`. Extract
  `_hd_asset(job_id, key, name, kind, produce)`. Also `:366-367` import `tempfile`/`os`
  function-locally for no reason.
- **`export_status` / `export_cancel` (`:437-448`) are byte-identical to
  `routes/animation.py:211-227`** apart from the error string. A
  `register_job_routes(bp, prefix, label)` factory kills both pairs.

## 3. The lyric-line read — a duplicate with a real failure mode

`routes/export.py:65-66`, `:135` and `cache_gc.py:37-46` all read lyric lines from the
analysis cache. **Only `cache_gc`'s copy has the `try/except`.** A corrupt JSON 500s the
export route but is handled in the sweep.

Promote `cache_gc._lyric_lines` to a shared helper. Step 04 pins the behaviour first; this
step makes one implementation carry it.

## 4. One `cv2` import convention (currently four)

- `look_fx.py:104` — a `_cv2()` helper raising a "needs opencv" `RuntimeError`
- `graph_render.py:1461-1466` — an inline copy of the same guard, different message
- `imagegen.py:304` and `:333` — bare `import cv2`

Keep `look_fx`'s `_cv2()`, move it somewhere shared, use it everywhere.

## 5. Consistency nits worth doing while here

- `from __future__ import annotations` is in every `backend/*.py` but missing from
  `routes/{export,animation,projects,stylize,serving,settings}.py`.
- `segment.py:26` and `db.py:16` use `List`/`Optional`/`Sequence`/`Tuple` while the other
  35 modules use PEP 585/604 builtins.
- **`routes/animation.py`** has a good `_resolve_endpoint` (`:70`) factoring the 400/500
  mapping — but `/animate` (`:162-169`) and `/animate/stream` (`:187-195`) each re-hand-roll
  the missing-field check and the `except ValueError → 400` / `except Exception → 500` pair,
  and `routes/export.py` and `routes/assets.py` use two further shapes. Extend
  `_resolve_endpoint` or add a `@job_guarded` decorator so there is one error contract.
  Four broad excepts in `routes/animation.py` (`:64,87,137,167`) return
  `f"{type(e).__name__}: {e}"` straight to the client — worth narrowing while you are there.

---

## Acceptance criteria

1. `grep -rn "_Dag" backend/ tests/` returns nothing.
2. `graph.py`'s exports match what is actually imported elsewhere (grep each removed name).
3. Step 04's export tests stay green through the `_start_hd_job` extraction — a leaked HD
   slot is invisible otherwise.
4. A corrupt analysis-cache JSON behaves identically in the export route and the GC sweep.

## Risks

- **The `graph.py` trim breaks an import you didn't grep for** — including in `scripts/`,
  which is currently outside lint (see step 14). Grep the whole repo, not just `backend/`.
- **The legacy-slideshow decision is a product question, not a code question.** If nobody
  can answer it, that is a valid outcome: leave the shim, write down the condition for
  removing it, move on.
