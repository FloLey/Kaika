# Kaika — one container, one command: the server + embedded frontend.
#   docker build -t kaika .
#   docker run -p 8400:8400 -v $(pwd)/data:/data kaika
# Open http://localhost:8400

# ---- stage 1: build the frontend into the Python package ----
FROM node:22-slim AS web
WORKDIR /build
COPY webapp/package.json webapp/package-lock.json webapp/
RUN npm --prefix webapp ci --no-audit --no-fund
COPY webapp webapp
# vite emits into ../src/kaika/webapp_dist (relative to webapp/)
RUN mkdir -p src/kaika && npm --prefix webapp run build

# ---- stage 2: the app ----
FROM python:3.12-slim
# ffmpeg: imageio-ffmpeg bundles its own binary for muxing, but a system
# ffmpeg lets librosa/audioread decode exotic uploads (mp3/m4a) reliably.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src src
COPY recipes recipes
COPY --from=web /build/src/kaika/webapp_dist src/kaika/webapp_dist
RUN pip install --no-cache-dir .

# Runs land in /data/runs; uploads + settings (LLM keys) in /data/.kaika.
VOLUME /data
EXPOSE 8400
CMD ["kaika", "serve", "--host", "0.0.0.0", "--port", "8400", \
     "--no-browser", "--out", "/data/runs"]
