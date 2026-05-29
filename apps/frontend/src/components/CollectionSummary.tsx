import type { CollectionCheckResult } from "../api.js";
import { ResultSummary } from "./ResultSummary.js";

interface Props {
  result: CollectionCheckResult;
}

export function CollectionSummary({ result }: Props) {
  return (
    <div>
      <div className="card">
        <h2>
          Collection
          <span className="badge success">visible products</span>
        </h2>
        <div className="stat-grid" style={{ marginBottom: "1rem" }}>
          <div className="stat">
            <div className="num">{result.summary.discovered}</div>
            <div className="label">discovered</div>
          </div>
          <div className="stat">
            <div className="num">{result.summary.succeeded}</div>
            <div className="label">scraped</div>
          </div>
          <div className="stat">
            <div className="num">{result.summary.failed}</div>
            <div className="label">failed</div>
          </div>
        </div>
        <div className="field-container">
          <div className="field-label">Collection URL</div>
          <div className="field-value">
            <a href={result.finalUrl} target="_blank" rel="noreferrer">{result.finalUrl}</a>
          </div>
        </div>
      </div>

      {result.warnings.length > 0 && (
        <div className="card" style={{ borderColor: "rgba(245, 158, 11, 0.25)" }}>
          <h2 style={{ color: "var(--accent-warning)" }}>Collection Warnings</h2>
          <ul className="warnings">
            {result.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <h2>Discovered Product URLs</h2>
        <ol className="product-url-list">
          {result.discoveredProductUrls.map((url) => (
            <li key={url}>
              <a href={url} target="_blank" rel="noreferrer">{url}</a>
            </li>
          ))}
        </ol>
      </div>

      {result.products.map((product, index) => (
        <div key={product.url} className="collection-product">
          <div className="card collection-product-header">
            <h2>
              Product {index + 1}
              <span className={`badge ${product.success ? "success" : "warning"}`}>
                {product.success ? "scraped" : "failed"}
              </span>
            </h2>
            <div className="field-value">
              <a href={product.url} target="_blank" rel="noreferrer">{product.url}</a>
            </div>
            {!product.success && (
              <div className="error-banner" style={{ marginBottom: 0 }}>
                <strong>{product.error.code}</strong>
                {product.error.message}
              </div>
            )}
          </div>
          {product.success && (
            <ResultSummary result={product.result} fileBaseUrl={product.fileBaseUrl ?? ""} />
          )}
        </div>
      ))}
    </div>
  );
}
