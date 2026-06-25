# `/animate` fixtures

Template request bodies for the graph executor (spec `03`). Each is a full
`POST /animate` body — `{ job_id, segment: { start, end, signals }, graph }` — so
you can `curl --data @<fixture>` once you fill in a real project. The graph object
lives under the `graph` key (matching `01` §3.4).

These are **templates**: they ship with `REPLACE_ME_*` placeholders and an inline
`_TODO` field. They parse as valid JSON as-is (the agent check below passes), but
will not render a meaningful clip until you embed a real `job_id` / segment /
signal. The `_TODO` and `_*` keys are ignored by the executor (it reads only
`job_id`, `segment`, `graph`).

## Files

- **`graph-min.json`** — minimal graph: one `fluid` node (all params constant) +
  one `output`. `segment.signals` is `[]`. Renders a steady plume. Use this to
  smoke-test `/animate` + caching with no audio dependency on the signal path.
- **`graph-modulated.json`** — drives the fluid `force` port from a `signal` node
  mapped to `[0, 45]` (binding `{ kind: "node", lo: 0, hi: 45 }`). The signal's
  full definition rides in `segment.signals` (Issue 1A — defs travel in the
  request). Renders a clip whose jet pulses with the chosen drum signal.

## How to fill in a real `job_id` / segment / signal

The fixtures assume a real project with separated stems and at least one segment:

1. Run the app (`make dev`) and upload a short track (or resume an existing one).
2. `GET /projects` → copy a project's `job_id` into the fixture's `job_id`.
3. `GET /projects/<job_id>` → pick a segment; copy its `start` / `end` into
   `segment.start` / `segment.end`.
4. For `graph-modulated.json`: pick one of that segment's `signals[]` entries.
   - Copy its `id` into **both** `segment.signals[0].id` **and**
     the signal node's `data.signalId` (they must match).
   - Copy its defining fields (`stemKey`, `minHz`, `maxHz`, `feature`, `attack`,
     `release`, `invert`, `gamma`, `gain`, `offset`, `threshold`) into
     `segment.signals[0]`. These are render inputs and are folded into the cache
     hash (`01` §3.6), so they must be present and accurate.

A drum/kick band (`stemKey: "drums"`, ~40–120 Hz, `feature: "energy"`) gives the
clearest pulsing motion.

## Verification

**Parse (agent check):**

```bash
python -c "import json,glob;[json.load(open(f)) for f in glob.glob('specs/create-animation/fixtures/*.json')]"
```

**Render (after filling in a real project):**

```bash
curl -s localhost:5000/animate -H 'content-type: application/json' \
  --data @specs/create-animation/fixtures/graph-modulated.json | tee /tmp/anim.json
# -> {"url":"/fluid/<hash>.mp4"}
curl -s -o /tmp/anim.mp4 "localhost:5000$(jq -r .url /tmp/anim.json)"
ffprobe /tmp/anim.mp4   # valid h264 512x512 clip
# Re-run the same curl: same url returned instantly (cache hit, file exists).
```

## Runnable example (this machine)

`graph-modulated.local.json` is a **real, working** request body captured against a
live local project (`job_id` `dbce4ed1`, segment 0, driving the fluid `force` from
its `drums energy` signal over `[0, 45]`). Verified end-to-end:

```bash
curl -s localhost:5000/animate -H 'content-type: application/json' \
  --data @specs/create-animation/fixtures/graph-modulated.local.json   # -> {"url":"/fluid/<hash>.mp4"}
```

It is machine-specific (that `job_id` must exist in your DB). If you don't have it,
regenerate one for any of your projects with the "How to fill in" steps above.
