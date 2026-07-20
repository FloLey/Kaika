# Generative cards — the shipped wave (waves · lightning · fire · aurora · rain · clouds)

Design records for the six generative source cards that **are built**. They live here,
not in `docs/`, because `specs/` is where a finished wave's *why* goes — the design
catalog they were picked from is still a backlog and stays at
[`docs/generative-cards/`](../../docs/generative-cards/README.md).

| # | Card | Spec |
|---|---|---|
| 01 | Waves / shoreline | [01-waves-shoreline.md](01-waves-shoreline.md) |
| 02 | Lightning | [02-lightning.md](02-lightning.md) |
| 03 | Fire | [03-fire.md](03-fire.md) |
| 04 | Aurora | [04-aurora.md](04-aurora.md) |
| 05 | Rain / storm | [05-rain-storm.md](05-rain-storm.md) |
| 06 | Clouds / nebula | [06-clouds-nebula.md](06-clouds-nebula.md) |

## What the code actually does today

The specs describe the design; these are the landing points, so a reader can tell the
record from the product:

- **Cards** — all six in `backend/card_demo.py` `CARD_LABELS`, each with a Playground
  pipeline (a hard invariant: every card has one).
- **Ports** — `backend/animation_params.py` `SOURCE_PARAM_SPEC`; the frontend tables
  derive from it via `make gen-params`.
- **Render** — `backend/sources.py` (the per-card frame functions) over the shared
  kit in `backend/procgen.py` (wave spectra, caustics, DBM, spectral ripple…).
- **Tests** — `tests/test_gen_sim_cards.py`.

**These specs were written before the rewrite and were not all followed to the letter.**
The wave shipped, then the cards were rebuilt as *physical* simulations — pool caustics,
spectral rain, DBM lightning, a solver-driven fire, Chapman aurora, lit clouds — with new
port sets, and gen cards gained the ability to feed a merge combine. That rewrite is
`RENDER_VERSION` **v8** (`docs/render-versions.md`) and `GRAPH_VERSION` **v26**
(`frontend/src/lib/graph/factories.ts`). Where a spec and the code disagree, **the code
is right and the spec is the earlier intent** — which is what a design record is for.

For the engine and the add-a-card checklist see [`ARCHITECTURE.md`](../../ARCHITECTURE.md)
and [`DEVELOPMENT.md`](../../DEVELOPMENT.md).
