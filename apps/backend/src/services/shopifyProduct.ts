/**
 * Plain-HTTP relay for ONE Shopify product URL (`POST /api/shopify-product`).
 *
 * Why: Shopify answers HTTP 429 to some callers' networks for the three public
 * product URLs — `/products/<handle>.json`, `/products/<handle>.js` and the
 * product page — while the very same requests from this service are answered
 * normally (the tracker reads `products.json` from those shops all day). So a
 * caller can ask this service to fetch exactly one such URL and gets the
 * upstream status and body back, untouched.
 *
 * Deliberately narrow, because it must never cost the tracker its standing with
 * a shop: https product URLs on public hosts only, no headless browser, one
 * deadline for the whole exchange, a body cap, and one request at a time per
 * target host with a pause between starts.
 */
import { CheckError } from "../types/productCheck.js";
import { assertDomainAllowed, validateAndNormalizeUrl } from "../utils/url.js";
import {
  buildRealisticHeaders,
  fetchDirect,
  getProxyConfig,
  isBlockedResponse,
  isProxyHealthy,
  proxyFetch,
} from "./antiBlock.js";

export type ShopifyProductKind = "js" | "json" | "page";

export interface ShopifyProductResult {
  /** The validated request URL as fetched (fragment dropped). */
  url: string;
  kind: ShopifyProductKind;
  /** Upstream HTTP status of the final hop. */
  status: number;
  /** The URL that produced the final answer (differs from `url` after redirects). */
  finalUrl: string;
  /** Upstream `Retry-After` in seconds; null when absent or unparseable. */
  retryAfter: number | null;
  /** Upstream `Content-Type`, or "". */
  contentType: string;
  /** The upstream body, unmodified, when `status` is 2xx; "" otherwise. */
  body: string;
  /** Bytes read from the upstream body (0 when it was not read). */
  bytes: number;
  /** Whether the final answer came through the proxy or from this server's own IP. */
  via: "proxy" | "direct";
  /** Redirect hops followed. */
  redirects: number;
  /** Wall time of the whole exchange, the wait for the host's turn included. */
  ms: number;
}

/** One deadline for the WHOLE exchange: the wait for the host's turn, every hop, and reading the body. */
const SHOPIFY_PRODUCT_TIMEOUT_MS =
  Number(process.env.SHOPIFY_PRODUCT_TIMEOUT_MS) > 0 ? Number(process.env.SHOPIFY_PRODUCT_TIMEOUT_MS) : 12_000;

/** Largest upstream body handed back. A product page is ~1 MB; nothing legitimate comes near this. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const MAX_REDIRECTS = 5;

/** Minimum time between two request starts for the same target hostname. */
const HOST_MIN_GAP_MS = 300;

/** `/products/<handle>` with an optional Shopify market/locale prefix (`/en-de/products/x.js`). */
const PRODUCT_PATH_RE = /^(?:\/[a-z]{2}(?:-[a-z0-9]{2,4})?)?\/products\/[^/]+$/i;

/** Statuses that are a redirect when they carry a `Location` (what fetch itself follows). */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type Via = ShopifyProductResult["via"];

interface ProductTarget {
  url: string;
  hostname: string;
  kind: ShopifyProductKind;
}

/** The final hop of an exchange: it answered, its body is still unread. */
interface Answer {
  response: Response;
  via: Via;
  finalUrl: string;
  redirects: number;
}

type HopFetcher = (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<{ response: Response; via: Via }>;

/**
 * Fetch one Shopify product URL and report what the shop answered. ANY upstream
 * HTTP status is a result (the caller decides what a 404 or a 429 means); only
 * a refused URL, a network failure or the deadline throws a {@link CheckError}.
 */
export async function fetchShopifyProduct(inputUrl: string): Promise<ShopifyProductResult> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + SHOPIFY_PRODUCT_TIMEOUT_MS;
  const target = parseProductUrl(inputUrl);

  let started = false;
  const exchange = runInHostLane(target.hostname, deadlineAt, () => {
    started = true;
    return runExchange(target, deadlineAt);
  });

  // The caller is answered at the deadline whatever is still under way: the
  // wait for the host's turn, or a proxied attempt that keeps its own timer
  // (see fetchThroughProxy).
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(started ? timedOut(target.hostname) : queuedTooLong(target.hostname)),
      SHOPIFY_PRODUCT_TIMEOUT_MS,
    );
  });
  const answer = await Promise.race([exchange, deadline]).finally(() => clearTimeout(timer));

  return {
    url: target.url,
    kind: target.kind,
    status: answer.status,
    finalUrl: answer.finalUrl,
    retryAfter: answer.retryAfter,
    contentType: answer.contentType,
    body: answer.body,
    bytes: answer.bytes,
    via: answer.via,
    redirects: answer.redirects,
    ms: Date.now() - startedAt,
  };
}

/**
 * Validate the request URL: https, no credentials, default port, a public host
 * and a product path. The query string is kept; the fragment is dropped.
 * Throws INVALID_URL / DOMAIN_NOT_ALLOWED.
 */
function parseProductUrl(input: string): ProductTarget {
  const { url } = validateAndNormalizeUrl(input);
  const hostname = assertPublicHttps(url);
  if (url.port) throw new CheckError("INVALID_URL", "URLs with an explicit port are not supported.");
  if (!PRODUCT_PATH_RE.test(url.pathname)) {
    throw new CheckError(
      "INVALID_URL",
      "The URL must be a Shopify product URL: /products/<handle>, optionally ending in .js or .json.",
    );
  }
  url.hash = "";
  const kind: ShopifyProductKind = /\.json$/i.test(url.pathname) ? "json" : /\.js$/i.test(url.pathname) ? "js" : "page";
  return { url: url.toString(), hostname, kind };
}

/**
 * The rules every URL we send a request to must pass — the request URL and each
 * redirect target alike. Returns the hostname the domain policy was checked on.
 */
function assertPublicHttps(url: URL): string {
  if (url.protocol !== "https:") throw new CheckError("INVALID_URL", "Only https URLs are supported.");
  if (url.username || url.password) throw new CheckError("INVALID_URL", "URLs with credentials are not supported.");
  // A shop is never addressed by an IPv6 literal, and `hostname` keeps its
  // brackets ("[::1]"), which the private-host check does not recognise.
  if (url.hostname.startsWith("[")) throw new CheckError("INVALID_URL", "IP-literal hosts are not supported.");
  // "localhost." is localhost: check the name without its root dot.
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  assertDomainAllowed(hostname);
  return hostname;
}

/** Per target hostname: the promise that settles when the host's lane is free again. */
const hostLanes = new Map<string, Promise<void>>();

/**
 * Per-host pacing: requests for the same target hostname run one at a time, with
 * at least HOST_MIN_GAP_MS between two starts. The lane stays taken until `task`
 * has really settled — also when the caller was already answered at its deadline
 * — so a slow host is never sent a second request on top of the first. A caller
 * whose deadline passed while it waited gives up its turn without touching the
 * host. Lanes are removed as soon as they are idle.
 */
function runInHostLane<T>(hostname: string, deadlineAt: number, task: () => Promise<T>): Promise<T> {
  const previous = hostLanes.get(hostname) ?? Promise.resolve();
  let taskStartedAt: number | null = null;
  const result = previous.then(() => {
    if (remainingMs(deadlineAt) <= 0) throw queuedTooLong(hostname);
    taskStartedAt = Date.now();
    return task();
  });
  const lane: Promise<void> = result
    .then(
      () => undefined,
      () => undefined,
    )
    .then(() => (taskStartedAt === null ? undefined : restOfGap(taskStartedAt)))
    .then(() => {
      if (hostLanes.get(hostname) === lane) hostLanes.delete(hostname);
    });
  hostLanes.set(hostname, lane);
  return result;
}

/** Wait out what is left of the gap since `startedAt` — never longer than the gap, whatever the clock does. */
function restOfGap(startedAt: number): Promise<void> | undefined {
  const wait = Math.min(HOST_MIN_GAP_MS, startedAt + HOST_MIN_GAP_MS - Date.now());
  return wait > 0 ? new Promise((resolve) => setTimeout(resolve, wait)) : undefined;
}

/** Budget left before `deadlineAt` — never more than the whole budget, should the wall clock step back. */
function remainingMs(deadlineAt: number): number {
  return Math.min(SHOPIFY_PRODUCT_TIMEOUT_MS, deadlineAt - Date.now());
}

/** Everything after the host's turn came up: the hops, the direct retry, the body. */
async function runExchange(
  target: ProductTarget,
  deadlineAt: number,
): Promise<Omit<ShopifyProductResult, "url" | "kind" | "ms">> {
  let answer = await followRedirects(target, fetchThroughProxy, deadlineAt);

  // Same idea as the tracker's fetchCollectionPageHtml: a shared proxy exit IP is
  // challenged far more readily than this server's own IP, so a BLOCKED answer is
  // retried once direct — but only when it really came through the proxy,
  // otherwise the retry would just hit the same wall from the same IP. The body
  // is not passed in, so its heuristics cannot misfire on product JSON.
  if (answer.via === "proxy" && isBlocked(answer.response)) {
    try {
      const direct = await followRedirects(target, fetchWithoutProxy, deadlineAt);
      discardBody(answer.response);
      answer = direct;
    } catch (err) {
      // The retry did not get an answer; the blocked one is still the truth.
      if (remainingMs(deadlineAt) <= 0) {
        discardBody(answer.response);
        throw err;
      }
    }
  }

  const { response, via, finalUrl, redirects } = answer;
  let body = "";
  let bytes = 0;
  if (response.status >= 200 && response.status < 300) {
    ({ body, bytes } = await readBody(response, target.hostname, deadlineAt));
  } else {
    discardBody(response);
  }
  return {
    status: response.status,
    finalUrl,
    retryAfter: parseRetryAfter(response.headers.get("retry-after")),
    contentType: response.headers.get("content-type") ?? "",
    body,
    bytes,
    via,
    redirects,
  };
}

/**
 * First choice, like every other fetch in this service: through the proxy when
 * one is configured and healthy, else direct. Says which of the two it was.
 */
const fetchThroughProxy: HopFetcher = async (url, headers, timeoutMs) => {
  const proxied = isProxyHealthy();
  // Through a proxy the attempt keeps proxyFetch's own timer. An attempt that
  // proxyFetch times out is taken as proof that the PROXY is broken, and switches
  // it off for every scrape in this process — the tracker and the browser
  // included. A relay call that merely ran out of its own, shorter budget must
  // not cause that; the deadline in fetchShopifyProduct answers the caller instead.
  const response = await proxyFetch(url, { headers, redirect: "manual" }, proxied ? undefined : timeoutMs);
  // proxyFetch goes direct by itself when the proxy turns out to be broken (and
  // marks it so): that answer came from this server's own IP.
  return { response, via: proxied && isProxyHealthy() ? "proxy" : "direct" };
};

const fetchWithoutProxy: HopFetcher = async (url, headers, timeoutMs) => ({
  response: await fetchDirect(url, { headers, redirect: "manual" }, timeoutMs),
  via: "direct",
});

/**
 * Request `target` and follow its redirects by hand, at most MAX_REDIRECTS hops.
 * Cross-host hops are fine (myshopify.com → the shop's own domain, www → apex),
 * as long as every hop stays on https and on a public host.
 */
async function followRedirects(target: ProductTarget, fetcher: HopFetcher, deadlineAt: number): Promise<Answer> {
  let currentUrl = target.url;
  for (let redirects = 0; ; redirects++) {
    const timeoutMs = remainingMs(deadlineAt);
    if (timeoutMs <= 0) throw timedOut(target.hostname);

    let hop: Awaited<ReturnType<HopFetcher>>;
    try {
      hop = await fetcher(currentUrl, requestHeaders(target.kind, currentUrl), timeoutMs);
    } catch (err) {
      // An abort is the fetch helper's timer going off, i.e. the deadline.
      const aborted = (err as Error | null)?.name === "AbortError";
      if (aborted || remainingMs(deadlineAt) <= 0) throw timedOut(target.hostname);
      throw new CheckError(
        "PAGE_LOAD_FAILED",
        `The request to ${new URL(currentUrl).hostname} failed: ${describeFetchError(err)}`,
      );
    }
    if (remainingMs(deadlineAt) <= 0) {
      discardBody(hop.response);
      throw timedOut(target.hostname);
    }

    const location = REDIRECT_STATUSES.has(hop.response.status) ? hop.response.headers.get("location") : null;
    if (location === null) return { response: hop.response, via: hop.via, finalUrl: currentUrl, redirects };

    discardBody(hop.response);
    if (redirects >= MAX_REDIRECTS) {
      throw new CheckError("PAGE_LOAD_FAILED", `${target.hostname} redirected more than ${MAX_REDIRECTS} times.`);
    }
    currentUrl = resolveRedirect(currentUrl, location);
  }
}

/** The next URL of a redirect, or PAGE_LOAD_FAILED when it must not be followed. */
function resolveRedirect(currentUrl: string, location: string): string {
  const from = new URL(currentUrl).hostname;
  let next: URL;
  try {
    if (!location.trim()) throw new Error("empty Location");
    next = new URL(location, currentUrl);
  } catch {
    throw new CheckError("PAGE_LOAD_FAILED", `${from} answered with a redirect to a malformed URL.`);
  }
  try {
    assertPublicHttps(next);
  } catch (err) {
    // Never echo the target beyond its scheme and host: it is upstream input.
    throw new CheckError(
      "PAGE_LOAD_FAILED",
      `Refused the redirect from ${from} to ${next.protocol}//${next.host}: ${(err as Error).message}`,
    );
  }
  next.hash = "";
  return next.toString();
}

function requestHeaders(kind: ShopifyProductKind, url: string): Record<string, string> {
  // The product page is a top-level navigation.
  if (kind === "page") return buildRealisticHeaders();
  return {
    ...buildRealisticHeaders(new URL(url).origin),
    // .js / .json are XHR-style requests, not navigations — the same overrides
    // the tracker sends for products.json (extractShopifyListingItems).
    accept: "application/json,text/plain,*/*;q=0.8",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
  };
}

function isBlocked(response: Response): boolean {
  return isBlockedResponse(response.status, "", response.headers.get("server"), response.headers.get("cf-mitigated"));
}

/**
 * Read the body as text, exactly as sent (no re-serialisation), counting bytes
 * as they arrive. The fetch helpers stop their timer once the headers are in,
 * so the deadline is enforced here: on timeout, and over the cap, the stream is
 * cancelled rather than read to the end.
 */
async function readBody(
  response: Response,
  hostname: string,
  deadlineAt: number,
): Promise<{ body: string; bytes: number }> {
  if (!response.body) return { body: "", bytes: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  let expired = false;
  // Cancelling ends a pending read() as "done", hence the flag.
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, Math.max(0, remainingMs(deadlineAt)));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new CheckError(
          "PAGE_LOAD_FAILED",
          `The response from ${hostname} is larger than ${MAX_BODY_BYTES / (1024 * 1024)} MB.`,
        );
      }
      body += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    if (err instanceof CheckError) throw err;
    if (!expired) {
      throw new CheckError("PAGE_LOAD_FAILED", `Reading the response from ${hostname} failed: ${describeFetchError(err)}`);
    }
  } finally {
    clearTimeout(timer);
  }
  if (expired) throw timedOut(hostname);
  return { body: body + decoder.decode(), bytes };
}

/** Let go of a response we will not read, so its connection is freed. */
function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

/** `Retry-After` as seconds from now: integer seconds or an HTTP date; null when absent or unparseable. */
function parseRetryAfter(header: string | null): number | null {
  const value = header?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value);
  // An HTTP date starts with a weekday name; Date.parse alone accepts far more.
  if (!/^[a-z]{3,9},?\s/i.test(value)) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function timedOut(hostname: string): CheckError {
  return new CheckError(
    "PAGE_LOAD_FAILED",
    `No complete answer from ${hostname} within ${SHOPIFY_PRODUCT_TIMEOUT_MS} ms.`,
  );
}

function queuedTooLong(hostname: string): CheckError {
  return new CheckError(
    "PAGE_LOAD_FAILED",
    `Timed out after ${SHOPIFY_PRODUCT_TIMEOUT_MS} ms waiting for earlier requests to ${hostname} to finish; no request was sent.`,
  );
}

/**
 * What went wrong with a fetch, for the error message. fetch() itself only says
 * "fetch failed"; the reason sits on `cause`. Proxy credentials must never reach
 * a caller, so anything shaped like URL userinfo and the active proxy's own
 * credentials are masked.
 */
function describeFetchError(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const parts = [(err as Error | null)?.message, cause?.code ?? cause?.message].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  let text = (parts.join(": ") || "unknown error").replace(/\/\/[^/@\s]*@/g, "//***@");
  const proxy = getProxyConfig();
  for (const secret of [proxy?.username, proxy?.password]) {
    if (!secret) continue;
    text = text.split(secret).join("***").split(encodeURIComponent(secret)).join("***");
  }
  return text;
}
