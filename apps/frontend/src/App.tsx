import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  checkProduct,
  trackListing,
  createProgressSource,
  getApiKey,
  setApiKey,
  type ApiError,
  type CheckResult,
  type ListingRankSnapshot,
  type ProgressEvent,
} from "./api.js";
import { ResultSummary } from "./components/ResultSummary.js";
import { CollectionSummary } from "./components/CollectionSummary.js";
import { ListingSummary } from "./components/ListingSummary.js";
import { ProgressPanel } from "./components/ProgressPanel.js";
import { ErrorBanner } from "./components/ErrorBanner.js";

type Mode = "scrape" | "listing";

type State =
  | { status: "idle" }
  | { status: "loading"; progress: ProgressEvent[] }
  | { status: "error"; error: ApiError }
  | { status: "scrape"; result: CheckResult; fileBaseUrl?: string | null }
  | { status: "listing"; result: ListingRankSnapshot };

const ENRICH_PHASES = new Set(["snapshot-ready", "enrich-start", "enrich-product-done", "enrich-product-failed", "enrich-complete", "enrich-failed"]);
const ENRICH_TERMINAL = new Set(["enrich-complete", "enrich-failed", "complete"]);

function newRunId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function App() {
  const [mode, setMode] = useState<Mode>("scrape");
  const [url, setUrl] = useState("");
  const [apiKey, setKey] = useState(getApiKey());
  const [maxPages, setMaxPages] = useState("");
  const [enrich, setEnrich] = useState(false);
  const [state, setState] = useState<State>({ status: "idle" });
  const [enrichEvents, setEnrichEvents] = useState<ProgressEvent[]>([]);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => setApiKey(apiKey), [apiKey]);

  const isIdle = state.status === "idle";
  const loading = state.status === "loading";
  const pagesNum = Number(maxPages) > 0 ? Number(maxPages) : undefined;

  const closeSource = () => {
    sourceRef.current?.close();
    sourceRef.current = null;
  };

  const runScrape = async () => {
    const runId = newRunId();
    setState({ status: "loading", progress: [] });
    const source = createProgressSource(runId);
    sourceRef.current = source;
    source.onmessage = (event) => {
      const progress = JSON.parse(event.data) as ProgressEvent;
      setState((current) =>
        current.status === "loading" ? { status: "loading", progress: [...current.progress, progress] } : current,
      );
    };
    try {
      const res = await checkProduct(url, { runId, maxPages: pagesNum });
      if (res.success) setState({ status: "scrape", result: res.result, fileBaseUrl: res.fileBaseUrl });
      else setState({ status: "error", error: res.error });
    } catch (err) {
      setState({ status: "error", error: { code: "NETWORK_ERROR", message: (err as Error).message } });
    } finally {
      closeSource();
    }
  };

  const runListing = async () => {
    const runId = newRunId();
    setState({ status: "loading", progress: [] });
    setEnrichEvents([]);
    const source = createProgressSource(runId);
    sourceRef.current = source;
    source.onmessage = (event) => {
      const p = JSON.parse(event.data) as ProgressEvent;
      if (ENRICH_PHASES.has(p.phase)) {
        setEnrichEvents((cur) => [...cur, p]);
      } else {
        setState((cur) => (cur.status === "loading" ? { status: "loading", progress: [...cur.progress, p] } : cur));
      }
      if (ENRICH_TERMINAL.has(p.phase)) closeSource();
    };
    try {
      const res = await trackListing(url, { runId, enrich, maxPages: pagesNum });
      if (res.success) setState({ status: "listing", result: res.result });
      else {
        setState({ status: "error", error: res.error });
        closeSource();
      }
    } catch (err) {
      setState({ status: "error", error: { code: "NETWORK_ERROR", message: (err as Error).message } });
      closeSource();
    } finally {
      // When enriching, keep the stream open for background progress; the
      // terminal event (or unmount) closes it.
      if (!enrich) closeSource();
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim() || loading) return;
    closeSource();
    if (mode === "scrape") void runScrape();
    else void runListing();
  };

  const enrichLatest = enrichEvents.at(-1);
  const enrichDone = !!enrichLatest && (enrichLatest.phase === "enrich-complete" || enrichLatest.phase === "enrich-failed");

  return (
    <div className={`app${isIdle ? " app--center" : ""}`}>
      <div className="stage">
        <header className="hero anim" style={{ animationDelay: "0ms" }}>
          <div className="mark">◧</div>
          <h1>Welcome</h1>
          <p className="subtitle">
            Pull SEO, product content &amp; images — or track best-seller rank — from your shop.
          </p>
        </header>

        <form className="console anim" style={{ animationDelay: "80ms" }} onSubmit={handleSubmit}>
          <label className="field">
            <span>API key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Paste your API key"
              autoComplete="current-password"
            />
          </label>

          <div className="segmented" role="tablist" aria-label="Mode">
            <button type="button" className={mode === "scrape" ? "on" : ""} aria-selected={mode === "scrape"} onClick={() => setMode("scrape")}>
              Scrape page
            </button>
            <button type="button" className={mode === "listing" ? "on" : ""} aria-selected={mode === "listing"} onClick={() => setMode("listing")}>
              Best-sellers
            </button>
          </div>

          <div className="options">
            <label className="field inline">
              <span>Max pages</span>
              <input
                type="number"
                min="1"
                value={maxPages}
                onChange={(e) => setMaxPages(e.target.value)}
                placeholder="default 10"
              />
            </label>
            {mode === "listing" && (
              <label className="check">
                <input type="checkbox" checked={enrich} onChange={(e) => setEnrich(e.target.checked)} />
                <span>Also scrape each product (SEO + images, runs in background)</span>
              </label>
            )}
          </div>

          <div className="url-row">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={
                mode === "scrape"
                  ? "https://yourshop.com/products/linen-dress (or a /collections page)"
                  : "https://yourshop.com/collections/all?sort_by=best-selling"
              }
              required
            />
            <button type="submit" disabled={loading}>
              {loading ? "Working…" : mode === "scrape" ? "Scrape →" : "Track →"}
            </button>
          </div>
        </form>

        <div className="results">
          {loading && <ProgressPanel events={state.progress} />}
          {state.status === "error" && (
            <div className="anim">
              <ErrorBanner error={state.error} />
            </div>
          )}
          {state.status === "scrape" &&
            (state.result.kind === "collection" ? (
              <CollectionSummary result={state.result} />
            ) : (
              <ResultSummary result={state.result} fileBaseUrl={state.fileBaseUrl ?? ""} />
            ))}
          {state.status === "listing" && (
            <>
              {enrichEvents.length > 0 && (
                <section className="card anim">
                  <div className="card-head">
                    <h2>{enrichDone ? "Enrichment finished" : "Enriching products…"}</h2>
                    {!enrichDone && <span className="spinner" />}
                  </div>
                  <p className="muted">{enrichLatest?.message}</p>
                  {enrichLatest?.total ? (
                    <div className="bar">
                      <div
                        className="bar-fill"
                        style={{ width: `${Math.round(((enrichLatest.current ?? 0) / enrichLatest.total) * 100)}%` }}
                      />
                      <span>{enrichLatest.current ?? 0}/{enrichLatest.total}</span>
                    </div>
                  ) : null}
                </section>
              )}
              <ListingSummary result={state.result} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
