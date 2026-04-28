# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS frontend-builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig*.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
COPY server/node ./server/node

RUN npm run build

FROM node:20-bookworm-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:${PATH}" \
    OPENWPS_HEADLESS_RENDERER_URL="http://127.0.0.1:5174/"

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      python3 \
      python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY server/requirements.txt ./server/requirements.txt
RUN python3 -m venv /opt/venv \
    && pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r server/requirements.txt

COPY package.json package-lock.json ./
RUN npm ci \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force

COPY server ./server
COPY --from=frontend-builder /app/dist ./dist
COPY --from=frontend-builder /app/server/node/.generated ./server/node/.generated

RUN mkdir -p /app/server/data /app/server/config \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin openwps \
    && chown -R openwps:openwps /app

USER openwps

EXPOSE 5174

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:5174/api/health || exit 1

CMD ["python3", "server/main.py"]
