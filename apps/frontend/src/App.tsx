import { useRef, useState } from "react";
import { checkProduct, createProgressSource, type ApiError, type CheckResult, type ProgressEvent } from "./api.js";
import { UrlForm } from "./components/UrlForm.js";
import { ErrorBanner } from "./components/ErrorBanner.js";
import { ResultSummary } from "./components/ResultSummary.js";
import { CollectionSummary } from "./components/CollectionSummary.js";
import { ProgressPanel } from "./components/ProgressPanel.js";

type State =
  | { status: "idle" }
  | { status: "loading"; progress: ProgressEvent[] }
  | { status: "error"; error: ApiError }
  | { status: "success"; result: CheckResult; fileBaseUrl?: string | null };

export function App() {
  const [state, setState] = useState<State>({ status: "idle" });
  const sourceRef = useRef<EventSource | null>(null);

  const handleSubmit = async (url: string) => {
    sourceRef.current?.close();
    const runId = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setState({ status: "loading", progress: [] });

    const source = createProgressSource(runId);
    sourceRef.current = source;
    source.onmessage = (event) => {
      const progress = JSON.parse(event.data) as ProgressEvent;
      setState((current) => current.status === "loading"
        ? { status: "loading", progress: [...current.progress, progress] }
        : current);
    };

    try {
      const res = await checkProduct(url, runId);
      if (res.success) {
        setState({ status: "success", result: res.result, fileBaseUrl: res.fileBaseUrl });
      } else {
        setState({ status: "error", error: res.error });
      }
    } catch (err) {
      setState({
        status: "error",
        error: { code: "NETWORK_ERROR", message: (err as Error).message },
      });
    } finally {
      source.close();
      if (sourceRef.current === source) sourceRef.current = null;
    }
  };

  return (
    <div className="app">
      <h1>Product Content Checker</h1>
      <p className="subtitle">
        Internal SEO &amp; product content checker for our owned webshop domains.
      </p>

      <UrlForm loading={state.status === "loading"} onSubmit={handleSubmit} />

      {state.status === "loading" && (
        <>
          <div className="loader-container">
            <div className="spinner"></div>
            <p>Rendering page and extracting content…</p>
          </div>
          <ProgressPanel events={state.progress} />
        </>
      )}
      {state.status === "error" && <ErrorBanner error={state.error} />}
      {state.status === "success" && (
        state.result.kind === "collection" ? (
          <CollectionSummary result={state.result} />
        ) : (
          <ResultSummary result={state.result} fileBaseUrl={state.fileBaseUrl ?? ""} />
        )
      )}
    </div>
  );
}
