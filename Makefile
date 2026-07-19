# Dev workflow: Postgres in Docker, app native (keeps Apple-Silicon GPU + HMR).
.PHONY: dev restart db-up db-down install rerender-spectrograms seed-playground export-playground \
	test test-backend test-strict test-frontend lint typecheck build clean-cache \
	gc-cache gen-params format coverage

# One command: start Postgres, then Flask (:5000) + Vite (:5173), both hot-reloading.
# `make dev` runs flask + vite under one `trap 'kill 0'`, so killing the backend by
# hand kills VITE TOO (they share a process group). Use `make restart` to bounce both
# cleanly — reaching for pkill on the python process silently takes the UI down with it.
restart:
	-@pkill -f "backend.app" 2>/dev/null; pkill -f "node.*vite" 2>/dev/null; sleep 2
	@$(MAKE) dev

dev: db-up
	@echo "waiting for postgres…"
	@until docker compose exec -T db pg_isready -U demucs -d demucs >/dev/null 2>&1; do sleep 1; done
	@echo "starting flask (:5000) + vite (:5173) — Ctrl-C stops both"
	@trap 'kill 0' INT TERM EXIT; \
		.venv/bin/python -m backend.app & \
		(cd frontend && npm run dev) & \
		wait

db-up:
	docker compose up -d db

db-down:
	docker compose down

install:
	.venv/bin/python -m pip install -r requirements.txt
	cd frontend && npm install

# Re-render existing projects' spectrograms after a theme/colormap change.
rerender-spectrograms:
	.venv/bin/python -m backend.rerender_spectrograms

# Force-rebuild the Playground project from the committed pipeline fixture + pre-render
# each. The app also builds it lazily on first open, so this is only for dev/smoke.
seed-playground: db-up
	@until docker compose exec -T db pg_isready -U demucs -d demucs >/dev/null 2>&1; do sleep 1; done
	.venv/bin/python -m backend.seed_card_demo

# Capture the CURRENT live Playground (your reworked pipelines) into the committed
# fixture, so it becomes the default. Run after reworking cards in the UI.
export-playground:
	.venv/bin/python -m backend.seed_card_demo export

# ---- quality gates (mirror CI) ---------------------------------------------
# These really do mirror .github/workflows/ci.yml now. They did not before: `lint`
# ran ruff + eslint only, while CI also ran black --check, tsc and prettier --check,
# so a commit could pass `make lint` and fail CI on formatting or types.
test: test-backend test-frontend

test-backend:
	.venv/bin/python -m pytest -q

# What CI runs: no silent dependency skips. Use plain `test-backend` on a machine
# that is deliberately missing ffmpeg/torch/Postgres.
test-strict:
	.venv/bin/python -m pytest -q --strict-deps

test-frontend:
	cd frontend && npm run test

lint:
	.venv/bin/ruff check backend tests
	.venv/bin/black --check backend tests
	cd frontend && npm run lint
	cd frontend && npm run typecheck
	cd frontend && npm run format:check

# Types only — the fast inner-loop check while editing .ts/.tsx.
typecheck:
	cd frontend && npm run typecheck

# One-time / occasional auto-format (Black for Python, Prettier for the frontend).
# Land the first bulk run as its OWN commit and add its SHA to .git-blame-ignore-revs.
format:
	.venv/bin/black backend tests
	cd frontend && npm run format

# `--cov` alone is enough: pyproject's [tool.coverage.run] already sets source=["backend"].
# This used to carry a `|| pytest --cov=backend` fallback, which was dead for its stated
# purpose and actively harmful: any FAILING TEST tripped the `||` and re-ran the whole
# suite, with the first run's output (the actual failure) sent to /dev/null.
coverage:
	.venv/bin/python -m pytest --cov
	cd frontend && npm run coverage

build:
	cd frontend && npm run build

# Drop rendered animation clips (data/fluid/*.mp4). The cache rebuilds on demand.
clean-cache:
	rm -f data/fluid/*.mp4
	rm -rf data/fluid/stream
	rm -f data/fluid_cache/*.npy
	@echo "render + fluid-frame cache cleared"

# Reachability sweep: drop cached clips no saved project points to (keeps recent ones).
gc-cache:
	.venv/bin/python -m backend.cache_gc

# Where a render's time actually goes (decode / flatten / opacity / cache / encode),
# plus peak ffmpeg processes and RSS. Run this BEFORE optimising a render path — it is
# what showed that two numpy conversions, not decode or H.264, were 73% of a 4K export.
#   make measure-render JOB=e883da29 SEGMENT=chorus
measure-render:
	.venv/bin/python scripts/measure_render.py

# Regenerate the frontend's generated files from the backend:
#   src/lib/fluidParams.js        <- animation_params.{FLUID,COLOR,SOURCE}_PARAM_SPEC
#   src/lib/graph/generated.ts    <- graph_common.VIDEO_PRODUCERS,
#                                    graph_hash.{_SIGNAL_HASH_FIELDS,_SLOT_CARDS}
# Run after editing any of them; a pytest (and CI's --check) fails if either is stale.
gen-params:
	.venv/bin/python -m backend.gen_fluid_params
