import type { FastifyInstance } from "fastify";

export function registerDashboardRoute(app: FastifyInstance): void {
  app.get("/", async (_request, reply) => reply.type("text/html").send(dashboardHtml()));
  app.get("/dashboard", async (_request, reply) => reply.type("text/html").send(dashboardHtml()));
}

function dashboardHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SEOSCRAPE Hosted API Dashboard</title>
  <style>
    :root { color-scheme: dark; --bg:#0b1020; --card:#121a33; --muted:#94a3b8; --text:#e5e7eb; --accent:#38bdf8; --border:#24304f; --bad:#fb7185; --good:#34d399; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:radial-gradient(circle at top,#172554 0,#0b1020 42%); color:var(--text); }
    main { width:min(1180px, calc(100% - 32px)); margin:0 auto; padding:40px 0; }
    h1 { margin:0 0 8px; font-size:clamp(2rem,5vw,4rem); letter-spacing:-.06em; }
    h2 { margin:0 0 16px; font-size:1.1rem; }
    p { color:var(--muted); line-height:1.6; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:16px; align-items:start; }
    .card { background:rgba(18,26,51,.9); border:1px solid var(--border); border-radius:20px; padding:20px; box-shadow:0 18px 50px rgba(0,0,0,.25); backdrop-filter:blur(12px); }
    label { display:block; margin:12px 0 6px; color:#cbd5e1; font-weight:700; font-size:.9rem; }
    input, select, textarea, button { width:100%; border:1px solid var(--border); border-radius:12px; background:#0f172a; color:var(--text); padding:12px 14px; font:inherit; }
    textarea { min-height:90px; resize:vertical; }
    button { margin-top:14px; cursor:pointer; background:linear-gradient(135deg,#0ea5e9,#2563eb); border:0; font-weight:800; }
    button.secondary { background:#1e293b; border:1px solid var(--border); }
    button:hover { filter:brightness(1.08); }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .status { display:inline-flex; align-items:center; gap:8px; border:1px solid var(--border); border-radius:999px; padding:8px 12px; color:var(--muted); }
    .dot { width:10px; height:10px; border-radius:50%; background:var(--bad); }
    .dot.ok { background:var(--good); }
    pre { overflow:auto; white-space:pre-wrap; word-break:break-word; background:#020617; border:1px solid var(--border); border-radius:16px; padding:16px; max-height:560px; }
    a { color:var(--accent); }
    .muted { color:var(--muted); font-size:.9rem; }
    .pill { display:inline-block; margin:4px 6px 0 0; padding:5px 9px; border:1px solid var(--border); border-radius:999px; color:#cbd5e1; font-size:.8rem; }
  </style>
</head>
<body>
  <main>
    <header class="card" style="margin-bottom:16px">
      <h1>SEOSCRAPE Hosted API</h1>
      <p>Use your API key as the dashboard password. The key is stored only in this browser's localStorage and sent as a Bearer token to protected API calls.</p>
      <div class="status"><span id="statusDot" class="dot"></span><span id="statusText">Checking health...</span></div>
    </header>

    <section class="grid">
      <div class="card">
        <h2>Login</h2>
        <label for="apiKey">API key / password</label>
        <input id="apiKey" type="password" placeholder="Paste API_KEY" autocomplete="current-password" />
        <button id="saveKey">Save API key</button>
        <button id="clearKey" class="secondary">Clear key</button>
        <p class="muted">Protected calls use <code>Authorization: Bearer &lt;key&gt;</code>.</p>
      </div>

      <div class="card">
        <h2>Product / Collection Check</h2>
        <label for="checkUrl">URL</label>
        <input id="checkUrl" placeholder="https://store.com/products/example" />
        <button id="runCheck">Run /api/check-product</button>
        <p class="muted">Full hosted mode renders with Playwright, downloads images, writes files, and serves them under <code>/files/runs/...</code>.</p>
      </div>

      <div class="card">
        <h2>Best-Seller Listing Track</h2>
        <label for="listingUrl">Listing URL</label>
        <input id="listingUrl" placeholder="https://store.com/collections/all?sort_by=best-selling" />
        <div class="row">
          <div>
            <label for="sourceStrategy">Source</label>
            <select id="sourceStrategy">
              <option value="auto">auto</option>
              <option value="html">html</option>
              <option value="shopify_json">shopify_json</option>
              <option value="both">both</option>
            </select>
          </div>
          <div>
            <label for="maxProducts">Max products</label>
            <input id="maxProducts" type="number" value="100" min="1" max="250" />
          </div>
        </div>
        <button id="trackListing">Run /api/listings/track</button>
        <div>
          <span class="pill">rank delta</span><span class="pill">new</span><span class="pill">missing</span><span class="pill">up/down</span>
        </div>
      </div>

      <div class="card">
        <h2>Listing History</h2>
        <label for="listingId">Tracked listing ID</label>
        <input id="listingId" placeholder="UUID returned by /api/listings/track" />
        <button id="getLatest">Get latest</button>
        <button id="getHistory" class="secondary">Get history</button>
      </div>
    </section>

    <section class="card" style="margin-top:16px">
      <h2>Response</h2>
      <pre id="output">Ready.</pre>
    </section>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);
    const output = $('output');
    const apiKeyInput = $('apiKey');
    apiKeyInput.value = localStorage.getItem('seoscrape_api_key') || '';

    function key() { return apiKeyInput.value.trim(); }
    function headers() {
      const h = { 'Content-Type': 'application/json' };
      if (key()) h.Authorization = 'Bearer ' + key();
      return h;
    }
    function show(value) { output.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
    async function request(path, options = {}) {
      show('Loading ' + path + ' ...');
      const response = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
      const text = await response.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      show({ status: response.status, ok: response.ok, body });
      return body;
    }

    $('saveKey').onclick = () => { localStorage.setItem('seoscrape_api_key', key()); show('API key saved in this browser.'); };
    $('clearKey').onclick = () => { localStorage.removeItem('seoscrape_api_key'); apiKeyInput.value = ''; show('API key cleared.'); };
    $('runCheck').onclick = () => request('/api/check-product', { method:'POST', body: JSON.stringify({ url: $('checkUrl').value }) });
    $('trackListing').onclick = () => request('/api/listings/track', { method:'POST', body: JSON.stringify({ url: $('listingUrl').value, sourceStrategy: $('sourceStrategy').value, maxProducts: Number($('maxProducts').value || 100) }) });
    $('getLatest').onclick = () => request('/api/listings/' + encodeURIComponent($('listingId').value.trim()) + '/latest');
    $('getHistory').onclick = () => request('/api/listings/' + encodeURIComponent($('listingId').value.trim()) + '/history');

    fetch('/health').then(r => r.json()).then(data => {
      $('statusDot').classList.add('ok');
      $('statusText').textContent = 'Healthy: ' + JSON.stringify(data);
    }).catch(err => { $('statusText').textContent = 'Health check failed: ' + err.message; });
  </script>
</body>
</html>`;
}
