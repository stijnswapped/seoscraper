# syntax=docker/dockerfile:1
#
# Frontend (Vite/React SPA) image. Build context = repo ROOT.
# On Railway, point the frontend service at this file with the service variable:
#   RAILWAY_DOCKERFILE_PATH=apps/frontend/Dockerfile
#
# The backend's public URL must be provided at BUILD time so Vite can inline it:
#   VITE_API_BASE_URL=https://<backend>.up.railway.app   (a Railway service variable)

# ---- Build stage ----------------------------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Workspace manifests first (better layer caching).
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm ci --include=dev

COPY . .

# Vite inlines VITE_* at build time. Railway passes service variables as build args.
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build --workspace apps/frontend

# ---- Serve stage (tiny static server) -------------------------------------
FROM node:20-bookworm-slim AS serve
WORKDIR /app
RUN npm install -g serve@14
COPY --from=build /app/apps/frontend/dist ./dist
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 8080) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# -s = SPA fallback (any path -> index.html), so Railway's /health check also gets 200.
CMD ["sh", "-c", "serve -s dist -l tcp://0.0.0.0:${PORT:-8080}"]
