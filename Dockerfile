# syntax=docker/dockerfile:1
#
# Production image for the SEOSCRAPE backend (Fastify + Playwright + sharp + pg).
# Runs the TypeScript backend directly with tsx, so no separate build step is
# needed and the SQL migration files stay resolvable at runtime.

FROM node:20-bookworm-slim

# Bind to all interfaces (Railway requires this) and keep Playwright browsers
# in a stable, known location shared by the install step and the runtime.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# tini runs as PID 1 and reaps orphaned processes. Every Chromium session
# leaves helpers (zygote, crashpad handler, renderers) that are re-parented to
# PID 1 when the browser exits. npm/node never reap those, so without an init
# they pile up as zombies until the container hits its task limit (pids.max);
# from then on every chrome-headless-shell dies ~100ms into launch with a bare
# signal=SIGTRAP until the container restarts. Railway has no `docker run
# --init`, so the init has to live in the image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) Copy only the workspace manifests first for better layer caching.
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/worker/package.json apps/worker/package.json

# 2) Install all dependencies. We include dev deps because the backend runs via
#    tsx at runtime (--include=dev is required since NODE_ENV=production).
RUN npm ci --include=dev

# 3) Install Chromium plus the OS libraries Playwright needs. Using the locally
#    installed Playwright version keeps the browser build in sync automatically.
RUN npx playwright install --with-deps chromium

# 4) Copy the rest of the source.
COPY . .

# Railway injects PORT; this is only documentation/local default.
EXPOSE 3001

# Starts the API on 0.0.0.0 (HOST above) and applies DB migrations when
# DATABASE_URL is set. Same as `npm run start:host --workspace apps/backend`,
# but node runs directly under tini: no npm/sh/tsx-CLI wrapper processes, and
# signals reach the server. The working directory stays apps/backend, so .env
# lookup and the relative OUTPUT_DIR resolve exactly as before.
WORKDIR /app/apps/backend
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "--import", "tsx", "src/index.ts"]
