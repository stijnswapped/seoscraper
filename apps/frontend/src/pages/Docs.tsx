// Docs: a getting-started guide + an API reference. Hand-authored (no markdown
// dependency); content mirrors API.md, the source of truth for the backend.

import type { ReactNode } from "react";
import { API_BASE } from "../api.js";
import { PageHeader } from "../layout/PageHeader.js";

const BASE = API_BASE || "https://seoscrapebackend-production.up.railway.app";

function Endpoint({
  method,
  path,
  children,
}: {
  method: string;
  path: string;
  children: ReactNode;
}) {
  return (
    <div className="doc-endpoint">
      <div className="doc-endpoint-head">
        <span className={`method ${method.toLowerCase()}`}>{method}</span>
        <code>{path}</code>
      </div>
      {children}
    </div>
  );
}

export function Docs() {
  return (
    <>
      <PageHeader title="Docs" subtitle="Get started in minutes, then automate with the API." />

      <div className="docs">
        {/* Getting started ---------------------------------------------- */}
        <section className="panel doc-section anim">
          <span className="eyebrow">Guide</span>
          <h2>Getting started</h2>
          <ol className="steps">
            <li className="step">
              <span className="step-num">1</span>
              <div className="step-content">
                <h3>Set up your proxy</h3>
                <p>
                  Go to <b>Account → Your proxy</b> and paste a residential proxy URL (or the Smartproxy{" "}
                  <code>curl</code> command). Hit <b>Test connection</b> to confirm it works and rotates. Stored
                  encrypted; never logged.
                </p>
              </div>
            </li>
            <li className="step">
              <span className="step-num">2</span>
              <div className="step-content">
                <h3>Run a scrape in the Playground</h3>
                <p>
                  Open <b>Playground</b>. Use <b>Scrape page</b> for a single product/collection (full SEO + images),
                  or <b>Best-sellers</b> to capture a collection's best-selling rank order. For ranking, the URL must
                  include <code>?sort_by=best-selling</code>.
                </p>
              </div>
            </li>
            <li className="step">
              <span className="step-num">3</span>
              <div className="step-content">
                <h3>Create an API key</h3>
                <p>
                  Go to <b>API keys</b> and create one (shown once — copy it). Send it on every request as the{" "}
                  <code>x-api-key</code> header to automate scraping from your own app.
                </p>
              </div>
            </li>
            <li className="step">
              <span className="step-num">4</span>
              <div className="step-content">
                <h3>Persist your history</h3>
                <p>
                  The backend keeps only the baseline and latest snapshot per listing. To build long-term graphs,
                  store each run's <code>items</code>, <code>changes</code> and <code>checkedAt</code> in your own
                  database.
                </p>
              </div>
            </li>
          </ol>
        </section>

        {/* API reference ------------------------------------------------ */}
        <section className="panel doc-section anim">
          <span className="eyebrow">Reference</span>
          <h2>API reference</h2>

          <h3 className="doc-subhead">Connection &amp; auth</h3>
          <p className="muted">
            Base URL <code>{BASE}</code>. Send your key on every <code>/api/*</code> request (except the progress
            stream and <code>/health</code>). All POST bodies are JSON; timestamps are ISO-8601 UTC.
          </p>
          <pre className="code-block">{`x-api-key: <API_KEY>
# equivalently:
Authorization: Bearer <API_KEY>`}</pre>

          <h3 className="doc-subhead">Response envelope</h3>
          <pre className="code-block">{`// success
{ "success": true, /* endpoint-specific fields */ }

// failure
{ "success": false, "error": { "code": ErrorCode, "message": string } }`}</pre>
          <p className="muted">
            Retry only <code>500</code>/<code>502</code>/network timeouts (max 2× with backoff). Never retry{" "}
            <code>400</code>/<code>401</code>/<code>404</code>.
          </p>

          <h3 className="doc-subhead">Endpoints</h3>

          <Endpoint method="POST" path="/api/listings/track">
            <p className="muted">
              Best-seller rank tracking (primary). Captures rank, title, image and URL per product, stores a snapshot,
              and diffs it against the previous one.
            </p>
            <pre className="code-block">{`POST ${BASE}/api/listings/track
x-api-key: <API_KEY>
content-type: application/json

{ "url": "https://yourshop.com/collections/all?sort_by=best-selling" }`}</pre>
            <p className="muted">
              Optional: <code>sourceStrategy</code> (<code>both</code>|<code>auto</code>|<code>html</code>|
              <code>shopify_json</code>, default <code>both</code>), <code>maxProducts</code> (1–250, default 150),{" "}
              <code>maxPages</code> (default 10), <code>runId</code>, <code>proxy</code>. Key products on the stable{" "}
              <code>productKey</code> — never on <code>title</code>.
            </p>
          </Endpoint>

          <Endpoint method="POST" path="/api/check-product">
            <p className="muted">
              Full single-product/collection research (heavy). Renders the page, extracts SEO + product metadata,
              downloads &amp; dedupes images, returns file URLs. Files are temporary (~7 days).
            </p>
            <pre className="code-block">{`POST ${BASE}/api/check-product
x-api-key: <API_KEY>
content-type: application/json

{ "url": "https://yourshop.com/products/linen-dress", "responseMode": "full" }`}</pre>
          </Endpoint>

          <Endpoint method="GET" path="/api/listings/:listingId/latest">
            <p className="muted">
              Latest stored snapshot for a tracked listing (<code>:listingId</code> = the <code>trackedListingId</code>{" "}
              returned by <code>track</code>). See also <code>/history</code> (baseline + latest only).
            </p>
          </Endpoint>

          <Endpoint method="GET" path="/api/check-progress/:runId">
            <p className="muted">
              Live progress over Server-Sent Events. Pass the same <code>runId</code> you sent to <code>track</code> /
              <code>check-product</code>, then open an <code>EventSource</code>. No auth. A terminal{" "}
              <code>phase:"complete"</code> event marks the end.
            </p>
            <pre className="code-block">{`const es = new EventSource("${BASE}/api/check-progress/" + runId);
es.onmessage = (e) => console.log(JSON.parse(e.data)); // { phase, message, current?, total? }`}</pre>
          </Endpoint>

          <h3 className="doc-subhead">Error codes</h3>
          <p className="muted">
            <code>INVALID_URL</code>, <code>DOMAIN_NOT_ALLOWED</code>, <code>PAGE_LOAD_FAILED</code>,{" "}
            <code>NO_PRODUCT_DATA_FOUND</code>, <code>IMAGE_DOWNLOAD_FAILED</code>, <code>OUTPUT_WRITE_FAILED</code>,{" "}
            <code>UNAUTHORIZED</code>, <code>NOT_FOUND</code>, <code>UNKNOWN_ERROR</code>.
          </p>
        </section>
      </div>
    </>
  );
}
