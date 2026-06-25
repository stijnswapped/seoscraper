# `/api/check-product` — async + polling change (for the client)

## Why this changed

Railway's edge proxy hard-closes any HTTP request at **300 seconds**, returning
499/502. A product check can take longer than that, so it can no longer be served
on a single blocking request. The work now runs **detached** on the server and the
client **polls** for the result when a check is slow.

**Fast checks are unchanged.** If a check finishes within ~250s, the POST returns
the exact same `200` body as before. You only need to handle the new "pending"
path for slow checks.

---

## The contract

### 1. Start a check — `POST /api/check-product`

Request body is **unchanged**:

```jsonc
{
  "url": "https://example.com/product",   // required
  "runId": "optional-id",                  // optional; if omitted the server returns one
  "responseMode": "full" | "url",          // optional, unchanged
  "proxy": "optional",                     // optional, unchanged
  "maxPages": 1                            // optional, unchanged
}
```

Headers unchanged (`Authorization: Bearer <apiKey>`, `content-type: application/json`).

**Two possible responses:**

**A) Finished in time → `200`** (identical to today):

```jsonc
// responseMode omitted / "full"
{ "success": true, "result": { /* full check result */ }, "fileBaseUrl": "...", "dataUrl": "..." }

// responseMode: "url"
{ "success": true, "kind": "product" | "collection", "fileBaseUrl": "...", "dataUrl": "...", "summary": { /* collection only */ } }
```

**B) Still running → `202`** (NEW):

```jsonc
{
  "success": true,
  "status": "pending",
  "runId": "job_...",   // use this to poll. Echoes your runId if you sent one.
  "retryAfter": 5        // suggested seconds between polls
}
```

### 2. Poll for the result — `GET /api/check-product/:runId` (NEW)

Use the `runId` from the `202`. Same `Authorization` header.

- **Still running → `202`**: `{ "success": true, "status": "pending", "runId": "...", "retryAfter": 5 }`
- **Finished → `200`**: the **exact same body** as the synchronous `200` above
  (respects the `responseMode` you used on the POST).
- **Failed → `4xx/5xx`**: same error body as before — `{ "success": false, "error": { "code": "...", "message": "..." } }`.
- **Unknown/expired runId → `404`**: `{ "success": false, "error": { "code": "JOB_NOT_FOUND", "message": "..." } }`.
  Finished jobs are retained for **10 minutes** — poll to completion within that window.

---

## Client logic to implement

```ts
async function checkProduct(url, opts) {
  const res = await fetch("/api/check-product", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ url, ...opts }),
  });
  let data = await res.json();

  // Fast path: already done (200). Slow path: 202 pending → poll.
  if (res.status === 202 && data.status === "pending") {
    data = await pollUntilDone(data.runId, opts?.responseMode);
  }
  return data; // same shape the caller already expects
}

async function pollUntilDone(runId, responseMode) {
  // Hard stop well under the 10-min server retention.
  const deadline = Date.now() + 9 * 60_000;
  let delay = 5_000;
  while (Date.now() < deadline) {
    await sleep(delay);
    const res = await fetch(`/api/check-product/${encodeURIComponent(runId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 202) {
      delay = 5_000; // still running, keep polling
      continue;
    }
    return res.json(); // 200 success body, or 4xx/5xx error body — return as-is
  }
  throw new Error("check timed out while polling");
}
```

### Notes
- **Poll cadence:** honor `retryAfter` (default 5s). Don't poll faster than ~3s.
- **`runId` reuse / idempotency:** POSTing the same `runId` again attaches to the
  in-flight job instead of starting a new scrape, and you're billed once. Handy if
  the POST connection drops — re-POST with the same `runId` to reattach, or just
  poll the `GET`.
- **Progress (optional, unchanged):** the existing SSE stream
  `GET /api/check-progress/:runId` still works and emits live phase updates. With a
  generated `runId` (returned in the `202`) you can subscribe for a progress bar
  while polling.
- **Billing:** a check is billed **once**, when the job completes — not per poll.
- **Errors are terminal:** a `4xx/5xx` from the POST or the GET means the job is
  done and failed; stop polling.
