# Dev workflow: Postgres in Docker, app native (keeps Apple-Silicon GPU + HMR).
.PHONY: dev db-up db-down install rerender-spectrograms \
	test test-backend test-frontend lint build clean-cache gen-params \
	format coverage

# One command: start Postgres, then Flask (:5000) + Vite (:5173), both hot-reloading.
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

# ---- quality gates (mirror CI) ---------------------------------------------
test: test-backend test-frontend

test-backend:
	.venv/bin/python -m pytest -q

test-frontend:
	cd frontend && npm run test

lint:
	.venv/bin/ruff check backend tests
	cd frontend && npm run lint

# One-time / occasional auto-format (Black for Python, Prettier for the frontend).
# Land the first bulk run as its OWN commit and add its SHA to .git-blame-ignore-revs.
format:
	.venv/bin/black backend tests
	cd frontend && npm run format

coverage:
	.venv/bin/python -m pytest --cov 2>/dev/null || .venv/bin/python -m pytest --cov=backend
	cd frontend && npm run coverage

build:
	cd frontend && npm run build

# Drop rendered animation clips (data/fluid/*.mp4). The cache rebuilds on demand.
clean-cache:
	rm -f data/fluid/*.mp4
	@echo "render cache cleared"

# Regenerate frontend/src/lib/fluidParams.js from animation_params.FLUID_PARAM_SPEC.
# Run after editing the spec; a pytest fails CI if the committed file is stale.
gen-params:
	.venv/bin/python -m backend.gen_fluid_params
