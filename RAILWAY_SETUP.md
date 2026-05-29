# Deploying SEOSCRAPE to Railway

This guide gets the backend (Fastify + Playwright + sharp + Postgres) running on
[Railway](https://railway.com) with persistent image storage and the listing
rank tracker enabled.

The repo ships everything Railway needs:

- **`Dockerfile`** — Node 20 image that installs deps and Chromium (with all OS
  libraries via `playwright install --with-deps chromium`). Playwright "just
  works" — no fighting Nixpacks for browser dependencies.
- **`railway.json`** — tells Railway to build from the Dockerfile, run the
  health check on `/health`, and restart on failure.
- **`.dockerignore`** — keeps `node_modules`, `output/`, and secrets out of the
  build context.
- **`.env.example`** — the full list of variables (copy values into Railway).

On boot the server **auto-runs database migrations** when `DATABASE_URL` is set,
binds to `0.0.0.0`, and uses Railway's injected `PORT`.

---

## 1. Push the repo to GitHub

The remote is already `https://github.com/stijnswapped/seoscraper.git`. Commit
and push your latest changes:

```bash
git add -A
git commit -m "Add Railway deployment config"
git push origin main
```

---

## 2. Create the Railway project

1. Go to **railway.com → New Project → Deploy from GitHub repo**.
2. Pick the `seoscraper` repository.
3. Railway detects `railway.json` + `Dockerfile` and starts the first build.
   The initial build is slow (it downloads Chromium); later builds are cached.

> If Railway picked Nixpacks instead of Docker, open
> **Service → Settings → Build** and set the builder to **Dockerfile**.

---

## 3. Add a Postgres database (for the listing rank tracker)

The product/collection checker works without a database, but the
`/api/listings/*` endpoints need Postgres.

1. In the project: **New → Database → Add PostgreSQL**.
2. Open your **backend service → Variables** and add a reference variable:

   - **Name:** `DATABASE_URL`
   - **Value:** `${{ Postgres.DATABASE_URL }}`

   Using the reference keeps you on Railway's private network (no SSL needed).
   Migrations run automatically on the next deploy.

> Using an **external** Postgres URL instead? Append `?sslmode=require` to the
> connection string.

---

## 4. Add a volume for saved runs & images

Railway containers have an **ephemeral** filesystem — without a volume, every
deploy wipes downloaded images. Add one:

1. **Service → Variables/Settings → Volumes → New Volume.**
2. **Mount path:** `/data`
3. Add a variable: **`OUTPUT_DIR` = `/data/output`**

Saved runs (served at `/files/runs/...`) now persist across redeploys.

---

## 5. Set the environment variables

In **backend service → Variables**, add (see `.env.example` for descriptions):

| Variable                  | Recommended value                       | Notes |
| ------------------------- | --------------------------------------- | ----- |
| `API_KEY`                 | a long random string                    | Protects the API + dashboard password. Generate with `openssl rand -hex 32`. |
| `OUTPUT_DIR`              | `/data/output`                          | Must match the volume mount. |
| `DATABASE_URL`            | `${{ Postgres.DATABASE_URL }}`          | Only if you added Postgres. |
| `ALLOW_ALL_DOMAINS`       | `false` (production) / `true` (testing) | |
| `ALLOWED_DOMAINS`         | `yourshop.com,www.yourshop.com`         | Used when `ALLOW_ALL_DOMAINS=false`. |
| `MAX_COLLECTION_PRODUCTS` | `100`                                   | Optional. |

You do **not** need to set `PORT` or `HOST`:

- `PORT` is injected by Railway.
- `HOST` is already `0.0.0.0` (set in the Dockerfile) so the service is reachable.

---

## 6. Expose a public URL

1. **Service → Settings → Networking → Generate Domain.**
2. Railway gives you `https://<service>.up.railway.app`.

The health check (`/health`) must pass for the deploy to go live.

---

## 7. Verify the deployment

```bash
# Health
curl -s https://<service>.up.railway.app/health
# -> {"ok":true}

# Product check (omit the header if you didn't set API_KEY)
curl -s -X POST https://<service>.up.railway.app/api/check-product \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.yourshop.com/products/example"}'
```

Then open the dashboard in a browser:

1. Visit `https://<service>.up.railway.app/`.
2. Paste your `API_KEY` into **API key / password** and click **Save**.
3. Run a product/collection check or track a listing.

Downloaded images are visible under `https://<service>.up.railway.app/files/runs/...`.

---

## 8. Resource sizing

Chromium is memory-hungry. Recommended service size: **at least 1 GB RAM**
(2 GB if you scrape large collections). If checks fail intermittently with
crashes or timeouts, bump the memory in **Service → Settings → Resources**.

---

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| Build uses Nixpacks / Chromium errors at runtime | Set builder to **Dockerfile** (Step 2). The Dockerfile installs Chromium + OS libs. |
| `Healthcheck failed` | Ensure the service didn't crash on boot. Check **Deploy Logs**. Don't set `HOST` to `127.0.0.1`. |
| Images disappear after redeploy | You skipped the volume. Add it and set `OUTPUT_DIR=/data/output` (Step 4). |
| `DATABASE_URL is required for listing rank tracking` | Add Postgres and the `DATABASE_URL` reference (Step 3). Product checks still work without it. |
| `UNAUTHORIZED` on API calls | Send `Authorization: Bearer <API_KEY>` (or `x-api-key`). The dashboard does this once you save the key. |
| Page renders fail / timeouts | Increase memory; some sites are slow. Browser timeout is 30s by default. |
| SSL/connection errors to Postgres | If using an external DB URL, append `?sslmode=require`. |

---

## How the build works (reference)

```dockerfile
FROM node:20-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# ... copy manifests, npm ci --include=dev ...
RUN npx playwright install --with-deps chromium   # Chromium + OS libraries
# ... copy source ...
CMD ["npm", "run", "start:host", "--workspace", "apps/backend"]
```

`start:host` runs `HOST=0.0.0.0 tsx src/index.ts`, which:

1. loads env vars,
2. applies DB migrations when `DATABASE_URL` is set,
3. starts Fastify on `0.0.0.0:$PORT`.

See `API.md` for the full endpoint reference.
