import type { CollectionCheckResult } from "../api.js";
import { ResultSummary } from "./ResultSummary.js";

export function CollectionSummary({ result }: { result: CollectionCheckResult }) {
  return (
    <div className="anim">
      <section className="card">
        <div className="card-head">
          <h2>Collection</h2>
          <span className="tag ok">{result.summary.succeeded} scraped</span>
        </div>
        <p className="muted">
          <a href={result.finalUrl} target="_blank" rel="noreferrer">{result.finalUrl}</a>
        </p>
        <div className="stats">
          <div className="stat"><b>{result.summary.discovered}</b><span>found</span></div>
          <div className="stat ok"><b>{result.summary.succeeded}</b><span>scraped</span></div>
          <div className="stat down"><b>{result.summary.failed}</b><span>failed</span></div>
        </div>
      </section>

      {result.warnings.length > 0 && (
        <section className="card warn">
          <h2>Notes</h2>
          <ul className="warnings">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      )}

      {result.products.map((product, index) => (
        <div key={product.url} className="collection-product">
          <div className="card-head subhead">
            <h3>
              Product {index + 1}
              <span className={`tag ${product.success ? "ok" : "warn"}`}>
                {product.success ? "scraped" : "failed"}
              </span>
            </h3>
            <a href={product.url} target="_blank" rel="noreferrer" className="muted">{product.url}</a>
          </div>
          {product.success ? (
            <ResultSummary result={product.result} fileBaseUrl={product.fileBaseUrl ?? ""} />
          ) : (
            <div className="error">
              <strong>{product.error.code}</strong>
              <span>{product.error.message}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
