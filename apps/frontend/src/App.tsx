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

function newRunId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function App() {
  const [mode, setMode] = useState<Mode>("scrape");
  const [url, setUrl] = useState("");
  const [apiKey, setKey] = useState(getApiKey());
  const [state, setState] = useState<State>({ status: "idle" });
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => setApiKey(apiKey), [apiKey]);

  const isIdle = state.status === "idle";
  const loading = state.status === "loading";

  const runScrape = async () => {
    const runId = newRunId();
    setState({ status: "loading", progress: [] });

    const source = createProgressSource(runId);
    sourceRef.current = source;
    source.onmessage = (event) => {
      const progress = JSON.parse(event.data) as ProgressEvent;
      setState((current) =>
        current.status === "loading"
          ? { status: "loading", progress: [...current.progress, progress] }
          : current,
      );
    };

    try {
      const res = await checkProduct(url, runId);
      if (res.success) {
        setState({ status: "scrape", result: res.result, fileBaseUrl: res.fileBaseUrl });
      } else {
        setState({ status: "error", error: res.error });
      }
    } catch (err) {
      setState({ status: "error", error: { code: "NETWORK_ERROR", message: (err as Error).message } });
    } finally {
      source.close();
      if (sourceRef.current === source) sourceRef.current = null;
    }
  };

  const runListing = async () => {
    setState({ status: "loading", progress: [] });
    try {
      const res = await trackListing(url);
      if (res.success) setState({ status: "listing", result: res.result });
      else setState({ status: "error", error: res.error });
    } catch (err) {
      setState({ status: "error", error: { code: "NETWORK_ERROR", message: (err as Error).message } });
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim() || loading) return;
    sourceRef.current?.close();
    if (mode === "scrape") void runScrape();
    else void runListing();
  };

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
            <button
              type="button"
              className={mode === "scrape" ? "on" : ""}
              aria-selected={mode === "scrape"}
              onClick={() => setMode("scrape")}
            >
              Scrape page
            </button>
            <button
              type="button"
              className={mode === "listing" ? "on" : ""}
              aria-selected={mode === "listing"}
              onClick={() => setMode("listing")}
            >
              Best-sellers
            </button>
          </div>

          <div className="url-row">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={
                mode === "scrape"
                  ? "https://yourshop.com/products/linen-dress"
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
          {state.status === "listing" && <ListingSummary result={state.result} />}
        </div>
      </div>
    </div>
  );
}
