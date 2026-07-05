# Deploying SEOSCRAPE to Railway

This guide gets the backend (Fastify + Playwright + sharp + Postgres) running on [Railway](https://railway.com) with persistent image storage and the listing-rank tracker enabled.

The repo ships everything Railway needs:

-   **`Dockerfile`** — Node 20 image that installs deps and Chromium (with all OS libraries via `playwright install --with-deps chromium`). Playwright "just works" — no fighting Nixpacks for browser dependencies.
-   **`railway.json`** — tells Railway to build from the Dockerfile, run the health check on `/health`, and restart on failure.
-   **`.dockerignore`** — keeps `node_modules`, `output/`, and secrets out of the build context.
-   **`.env.example`** — the full list of variables (copy values into Railway).

On boot the server **auto-runs database migrations** when `DATABASE_URL` is set, binds to `0.0.0.0`, and uses Railway's injected `PORT`.

---

## 1. Push the repo to GitHub

The remote is already `https://github.com/stijnswapped/seoscraper.git`. Commitand push your latest changes:

```bash
git add -Agit commit -m "Add Railway deployment config"git push origin main
```

---

## 2. Create the Railway project

1.  Go to **railway.com → New Project → Deploy from GitHub repo**.
2.  Pick the `seoscraper` repository.
3.  Railway detects `railway.json` + `Dockerfile` and starts the first build.The initial build is slow (it downloads Chromium); later builds are cached.

> If Railway picked Nixpacks instead of Docker, open**Service → Settings → Build** and set the builder to **Dockerfile**.

---

## 3. Add a Postgres database (for the listing rank tracker)

The product/collection checker works without a database, but the`/api/listings/*` endpoints need Postgres.

1.  In the project: **New → Database → Add PostgreSQL**.
    
2.  Open your **backend service → Variables** and add a reference variable:
    
    -   **Name:**`DATABASE_URL`
    -   **Value:**`${{ Postgres.DATABASE_URL }}`
    
    Using the reference keeps you on Railway's private network (no SSL needed).Migrations run automatically on the next deploy.
    

> Using an **external** Postgres URL instead? Append `?sslmode=require` to theconnection string.

---

## 4. Add a volume for saved runs & images

Railway containers have an **ephemeral** filesystem — without a volume, everydeploy wipes downloaded images. Add one:

1.  **Service → Variables/Settings → Volumes → New Volume.**
2.  **Mount path:**`/data`
3.  Add a variable: **`OUTPUT_DIR` = `/data/output`**

Saved runs (served at `/files/runs/...`) now persist across redeploys.

---

## 5. Set the environment variables

In **backend service → Variables**, add (see `.env.example` for descriptions):

Variable

Recommended value

Notes

`API_KEY`

a long random string

Protects the API + dashboard password. Generate with `openssl rand -hex 32`.

`OUTPUT_DIR`

`/data/output`

Must match the volume mount.

`DATABASE_URL`

`${{ Postgres.DATABASE_URL }}`

Only if you added Postgres.

`ALLOW_ALL_DOMAINS`

`false` (production) / `true` (testing)

`ALLOWED_DOMAINS`

`yourshop.com,www.yourshop.com`

Used when `ALLOW_ALL_DOMAINS=false`.

`MAX_COLLECTION_PRODUCTS`

`100`

Optional.

`SCRAPE_CONCURRENCY`

`4`

Set this to match the machine size: roughly 1 concurrent page per vCPU.

`IMAGE_CONCURRENCY`

`6`

Per-product image download parallelism.

`PRODUCT_SCROLL_TIMEOUT_MS`

`5000`

Short scroll budget for product pages.

`LISTING_SCROLL_TIMEOUT_MS`

`15000`

Long scroll budget for collection/listing pages.

### Reliability / anti-wedge (recommended)

These bound how long the shared headless browser can be held so a single slow or
blocked store can never park every later check in permanent `pending`:

Variable

Recommended value

Notes

`BROWSER_MAX_CONCURRENCY`

`1` (small box) / `2` (2+ GB RAM)

Live Chromium processes across all checks. `1` serializes everything — raise it if the box has RAM so one slow store doesn't block the queue.

`BROWSER_SESSION_DEADLINE_MS`

`180000`

Hard cap on one browser session. On timeout the browser is force-closed and the concurrency slot is released.

`BROWSER_ACQUIRE_TIMEOUT_MS`

`120000`

Max wait for a free browser slot before a check fails fast (instead of hanging) when the pool is saturated.

`SCRAPE_PROXY_URL`

`http://user:pass@host:port`

Residential/rotating proxy — the only reliable defense against Cloudflare IP blocking (needed for stores that never scrape successfully).

`PROXY_ROTATING`

`true`

Set when `SCRAPE_PROXY_URL` is a rotating pool (fresh exit IP per request); enables retry-on-block instead of a cooldown.

You do **not** need to set `PORT` or `HOST`:

-   `PORT` is injected by Railway.
-   `HOST` is already `0.0.0.0` (set in the Dockerfile) so the service is reachable.

---

## 6. Expose a public URL

1.  **Service → Settings → Networking → Generate Domain.**
2.  Railway gives you `https://<service>.up.railway.app`.

The health check (`/health`) must pass for the deploy to go live.

---

## 7. Verify the deployment

```bash
# Healthcurl -s https://<service>.up.railway.app/health# -> {"ok":true}# Product check (omit the header if you didn't set API_KEY)curl -s -X POST https://<service>.up.railway.app/api/check-product   -H "Authorization: Bearer $API_KEY"   -H "Content-Type: application/json"   -d '{"url":"https://www.yourshop.com/products/example"}'
```

Then open the dashboard in a browser:

1.  Visit `https://<service>.up.railway.app/`.
2.  Paste your `API_KEY` into **API key / password** and click **Save**.
3.  Run a product/collection check or track a listing.

Downloaded images are visible under `https://<service>.up.railway.app/files/runs/...`.

---

## 8. Resource sizing

Chromium is memory-hungry. Recommended service size: **about 2 vCPU / 2-4 GB RAM** with `SCRAPE_CONCURRENCY=4`. Rule of thumb: keep concurrency matched to the box at about 1 page per vCPU and ~250-350 MB per page.

---

## Troubleshooting

Symptom

Fix

Build uses Nixpacks / Chromium errors at runtime

Set builder to **Dockerfile** (Step 2). The Dockerfile installs Chromium + OS libs.

`Healthcheck failed`

Ensure the service didn't crash on boot. Check **Deploy Logs**. Don't set `HOST` to `127.0.0.1`.

Images disappear after redeploy

You skipped the volume. Add it and set `OUTPUT_DIR=/data/output` (Step 4).

`DATABASE_URL is required for listing rank tracking`

Add Postgres and the `DATABASE_URL` reference (Step 3). Product checks still work without it.

`UNAUTHORIZED` on API calls

Send `Authorization: Bearer <API_KEY>` (or `x-api-key`). The dashboard does this once you save the key.

Page renders fail / timeouts

Increase memory; some sites are slow. Browser timeout is 30s by default.

Checks stuck on `pending`, never resolve

The shared browser wedged/overloaded. **Restart/redeploy the service** to clear it. To prevent recurrence, set `BROWSER_SESSION_DEADLINE_MS` + `BROWSER_ACQUIRE_TIMEOUT_MS` (above) and consider `BROWSER_MAX_CONCURRENCY=2` on a 2+ GB box.

A specific store never scrapes (others work)

Cloudflare/anti-bot is blocking the scraper's IP. Configure `SCRAPE_PROXY_URL` (residential/rotating) + `PROXY_ROTATING=true`. Without a working proxy those stores keep failing.

SSL/connection errors to Postgres

If using an external DB URL, append `?sslmode=require`.

---

## How the build works (reference)

```dockerfile
FROM node:20-bookworm-slimENV NODE_ENV=production HOST=0.0.0.0 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright# ... copy manifests, npm ci --include=dev ...RUN npx playwright install --with-deps chromium   # Chromium + OS libraries# ... copy source ...CMD ["npm", "run", "start:host", "--workspace", "apps/backend"]
```

`start:host` runs `HOST=0.0.0.0 tsx src/index.ts`, which:

1.  loads env vars,
2.  applies DB migrations when `DATABASE_URL` is set,
3.  starts Fastify on `0.0.0.0:$PORT`.

See `API.md` for the full endpoint reference.