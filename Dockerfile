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

# Applies DB migrations (when DATABASE_URL is set) then starts the API on 0.0.0.0.
CMD ["npm", "run", "start:host", "--workspace", "apps/backend"]
