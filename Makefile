# Dev workflow: Postgres in Docker, app native (keeps Apple-Silicon GPU + HMR).
.PHONY: dev db-up db-down install rerender-spectrograms

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
