// Docs: a clear getting-started guide + API reference, with a one-click "build
// with AI" prompt. Hand-authored (no markdown dep); content mirrors API.md.

import type { ReactNode } from "react";
import { API_BASE } from "../api.js";
import { PageHeader } from "../layout/PageHeader.js";
import { CopyButton } from "../components/CopyButton.js";
import { buildIntegrationPrompt } from "../lib/aiPrompt.js";

const BASE = API_BASE || "https://seoscrapebackend-production.up.railway.app";
const AI_PROMPT = buildIntegrationPrompt(BASE);

/** A fenced code block with a copy button in the corner. */
function CodeBlock({ code }: { code: string }) {
  return (
    <div className="code-wrap">
      <pre className="code-block">{code}</pre>
      <CopyButton text={code} className="code-copy" label="Copy" copiedLabel="Copied" />
    </div>
  );
}

function Endpoint({
  method,
  path,
  summary,
  children,
}: {
  method: string;
  path: string;
  summary: string;
  children?: ReactNode;
}) {
  return (
    <div className="doc-endpoint">
      <div className="doc-endpoint-head">
        <span className={`method ${method.toLowerCase()}`}>{method}</span>
        <code>{path}</code>
      </div>
      <p className="muted">{summary}</p>
      {children}
    </div>
  );
}

export function Docs() {
  return (
    <>
      <PageHeader title="Docs" subtitle="Track Shopify best-sellers and scrape product data — from the UI or the API." />

      <div className="docs">
        {/* Build with AI ------------------------------------------------- */}
        <section className="ai-card anim">
          <div className="ai-card-body">
            <span className="ai-badge">✦ Build with AI</span>
            <h2>Let an AI wire up the integration for you</h2>
            <p>
              Copy the prompt below and paste it into Claude, Cursor, ChatGPT or any coding agent. It contains
              everything the model needs — base URL, auth, endpoints, response shapes and the rules that matter — so it
              can build your integration in one shot. Just add your API key and describe what you want at the end.
            </p>
            <div className="ai-card-actions">
              <CopyButton
                text={AI_PROMPT}
                className="btn ai-copy"
                label="🪄  Copy AI prompt"
                copiedLabel="✓  Copied — paste into your AI"
              />
              <a className="btn btn-ghost" href="#reference">Read the reference</a>
            </div>
          </div>
          <details className="ai-preview">
            <summary>Preview the prompt</summary>
            <pre className="code-block">{AI_PROMPT}</pre>
          </details>
        </section>

        {/* Quickstart ---------------------------------------------------- */}
        <section className="panel doc-section anim">
          <span className="eyebrow">Quickstart</span>
          <h2>From zero to first run</h2>
          <ol className="steps">
            <li className="step">
              <span className="step-num">1</span>
              <div className="step-content">
                <h3>Add a proxy</h3>
                <p>
                  <b>Account → Your proxy</b>: paste a residential proxy URL (or the Smartproxy <code>curl</code>),
                  then <b>Test connection</b>. Stored encrypted, never logged.
                </p>
              </div>
            </li>
            <li className="step">
              <span className="step-num">2</span>
              <div className="step-content">
                <h3>Try it in the Playground</h3>
                <p>
                  <b>Playground → Best-sellers</b>, paste a collection URL ending in{" "}
                  <code>?sort_by=best-selling</code>, and run it. You'll get the ranked products and the day-over-day
                  changes. No code required.
                </p>
              </div>
            </li>
            <li className="step">
              <span className="step-num">3</span>
              <div className="step-content">
                <h3>Get an API key &amp; automate</h3>
                <p>
                  <b>API keys → Create key</b> (shown once). Send it as <code>x-api-key</code> on every request — or
                  skip the manual work and hand the AI prompt above to your coding agent.
                </p>
              </div>
            </li>
          </ol>
        </section>

        {/* Reference ----------------------------------------------------- */}
        <section className="panel doc-section anim" id="reference">
          <span className="eyebrow">Reference</span>
          <h2>API reference</h2>

          <h3 className="doc-subhead">Authentication</h3>
          <p className="muted">
            Base URL <code>{BASE}</code>. Send your key on every <code>/api/*</code> request (except the progress
            stream and <code>/health</code>). Bodies are JSON; timestamps are ISO-8601 UTC.
          </p>
          <CodeBlock code={`x-api-key: <API_KEY>
# or:  Authorization: Bearer <API_KEY>`} />

          <h3 className="doc-subhead">Response shape</h3>
          <CodeBlock code={`// success
{ "success": true, /* endpoint-specific fields */ }

// failure
{ "success": false, "error": { "code": ErrorCode, "message": string } }`} />
          <p className="muted">
            Retry only <code>500</code> / <code>502</code> / network timeouts (max 2×, backoff). Never retry{" "}
            <code>400</code> / <code>401</code> / <code>404</code>.
          </p>

          <h3 className="doc-subhead">Endpoints</h3>

          <Endpoint
            method="POST"
            path="/api/listings/track"
            summary="Best-seller rank tracking (primary). Captures rank, title, image and URL per product, stores a snapshot, and diffs it against the previous run."
          >
            <CodeBlock code={`POST ${BASE}/api/listings/track
x-api-key: <API_KEY>
content-type: application/json

{ "url": "https://yourshop.com/collections/all?sort_by=best-selling" }`} />
            <p className="muted">
              Optional: <code>sourceStrategy</code> (default <code>both</code>), <code>maxProducts</code> (1–250,
              default 150), <code>maxPages</code> (default 10), <code>runId</code>, <code>proxy</code>. Returns{" "}
              <code>items[]</code> (ranked) + <code>changes[]</code> (per-product <code>direction</code>:{" "}
              <code>up/down/same/new/missing</code>) + a <code>trackedListingId</code> to persist.
            </p>
          </Endpoint>

          <Endpoint
            method="POST"
            path="/api/check-product"
            summary="Full single-product/collection research (heavy). Renders the page, extracts SEO + product metadata, downloads & dedupes images, returns file URLs."
          >
            <CodeBlock code={`POST ${BASE}/api/check-product
x-api-key: <API_KEY>
content-type: application/json

{ "url": "https://yourshop.com/products/linen-dress", "responseMode": "full" }`} />
            <p className="muted">Hosted files are temporary (~7 days) — download anything you want to keep.</p>
          </Endpoint>

          <Endpoint
            method="GET"
            path="/api/listings/:listingId/latest"
            summary="The latest stored snapshot for a tracked listing. :listingId is the trackedListingId returned by track. /history returns baseline + latest only."
          />

          <Endpoint
            method="GET"
            path="/api/check-progress/:runId"
            summary="Live progress over Server-Sent Events. Pass the runId you sent to track / check-product and open an EventSource. No auth; terminal event is phase:'complete'."
          >
            <CodeBlock code={`const es = new EventSource("${BASE}/api/check-progress/" + runId);
es.onmessage = (e) => console.log(JSON.parse(e.data)); // { phase, message, current?, total? }`} />
          </Endpoint>

          <h3 className="doc-subhead">Core concepts</h3>
          <ul className="doc-notes">
            <li>
              <b>Identity:</b> match products on the stable <code>productKey</code> (<code>"handle:&lt;handle&gt;"</code>) — never on <code>title</code>.
            </li>
            <li>
              <b>First run:</b> a listing's first run has no baseline, so every change is <code>direction:"new"</code>. Real diffs begin on run 2.
            </li>
            <li>
              <b>Persist your own history:</b> the backend keeps only baseline + latest per listing. Store each run's{" "}
              <code>items</code>, <code>changes</code> and <code>checkedAt</code> for long-term graphs.
            </li>
            <li>
              <b>Be gentle:</b> no server-side scheduler/queue. Trigger runs yourself (e.g. daily), ≤ 3 concurrent, ~120s timeout.
            </li>
          </ul>

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
