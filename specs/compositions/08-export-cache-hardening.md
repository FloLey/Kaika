# 08 — Export + cache hardening

The whole-song export exercised end-to-end over the DAG, and the GC's safety
made provable.

## Pinned by test

- **The export unrolls a montage root** (`test_song_export_unrolls_a_montage_root`):
  a segment whose root is a montage of leaf compositions cut by a manual
  breakpoint streams gapless (sim-free root → RGBA blocks) with each child on
  its own side of the cut, mixed with a fluid segment in the same song.
- **The `layer` continuity rule** (`test_layer_continuity_stops_at_the_root_composition`):
  persistent-field continuity applies ONLY to fluids in a segment's ROOT
  composition graph. A fluid inside a montage child starts from a BLANK field —
  segment 1's dye does not carry into it (the exact counterpart of
  `test_field_carries_across_boundary`, where the same emit-0 fluid in the ROOT
  inherits the dye).
- **GC keep-sets walk the closure** (`test_reachable_walks_the_composition_closure`):
  a root referencing children keys WITH the pool — the pool-less hash is
  provably different and NOT in the keep-set, so an incomplete closure can never
  masquerade as "these clips are junk". The keep-set-incomplete suspension and
  the recorded-export stems keep their existing tests.
- **Segment-HD invalidation reaches children**
  (`test_cached_lookup_misses_after_a_child_composition_edit`): the stateless
  `/export/segment/cached` answer goes stale on a CHILD edit, exactly like a
  root edit — never a false hit.

## Memory

The 4.9/5.7 GB failure modes are covered structurally: a played-out extract's
child Dag closes early (step 03's decoder-release test), `drop_stale_blocks`
forwards into the active child, and `set_fits` still gates the extract cache
SET up front. No RSS assertion — it was flaky by nature; the mechanism tests
are the guard.

## Accepted trade-off (documented in ARCHITECTURE)

Child-composition PREVIEW clips (streamed over a breadcrumb window) have keys
the sweep cannot recompute from saved state; they live on recency and age out,
rebuilding fast from the never-swept raw-frame cache. Every ROOT clip is
protected exactly.
