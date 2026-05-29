import type { ExtractedField, ProductCheckResult } from "../api.js";
import { ImageGallery } from "./ImageGallery.js";

function Field({ label, field }: { label: string; field: ExtractedField<string | null> }) {
  return (
    <div className="field-container">
      <div className="field-label">{label}</div>
      <div className="field-value">
        {field.value ?? <em style={{ color: "var(--color-text-dim)" }}>— not found —</em>}
      </div>
      <div className="meta-line">
        <span>source: <strong>{field.source}</strong></span>
        <span className="divider">·</span>
        <span>confidence: <strong>{field.confidence.toFixed(2)}</strong></span>
        {field.warnings.length > 0 && (
          <>
            <span className="divider">·</span>
            <span style={{ color: "var(--accent-warning)" }}>⚠ {field.warnings.join("; ")}</span>
          </>
        )}
      </div>
    </div>
  );
}

function FilePath({ value }: { value: string | null }) {
  return value ? (
    <code className="path">{value}</code>
  ) : (
    <em style={{ color: "var(--color-text-dim)" }}>not written in Worker mode</em>
  );
}

interface Props {
  result: ProductCheckResult;
  fileBaseUrl: string;
}

export function ResultSummary({ result, fileBaseUrl }: Props) {
  const { seo, product, images, files, warnings } = result;
  const badgeClass = `badge ${images.strategy.mode === "selective" ? "success" : "warning"}`;
  
  return (
    <div>
      <div className="card">
        <h2>SEO</h2>
        <Field label="SEO title" field={seo.title} />
        <Field label="SEO description" field={seo.description} />
        <Field label="Canonical URL" field={seo.canonicalUrl} />
      </div>

      <div className="card">
        <h2>Product</h2>
        <Field label="Product title" field={product.title} />
        <Field label="Product description" field={product.description} />
        <div className="meta-line" style={{ marginTop: "1rem", borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: "1rem" }}>
          <span>structured-data nodes: <strong>{product.structuredData.length}</strong></span>
        </div>
      </div>

      <div className="card">
        <h2>
          Images
          <span className={badgeClass}>{images.strategy.mode}</span>
        </h2>
        <div className="stat-grid" style={{ marginBottom: "1rem" }}>
          <div className="stat">
            <div className="num">{images.discovered.length}</div>
            <div className="label">discovered</div>
          </div>
          <div className="stat">
            <div className="num">{images.downloaded.length}</div>
            <div className="label">downloaded</div>
          </div>
          <div className="stat">
            <div className="num">{images.skipped.length}</div>
            <div className="label">skipped</div>
          </div>
        </div>
        <p className="meta-line" style={{ marginBottom: "1.5rem" }}>
          <span>strategy: <strong>{images.strategy.reason}</strong></span>
        </p>
        <ImageGallery images={images.downloaded} fileBaseUrl={fileBaseUrl} />
        {images.downloaded.length === 0 && images.discovered.length > 0 && (
          <div className="gallery">
            {images.discovered.slice(0, 12).map((img) => (
              <figure key={img.normalizedUrl}>
                <img src={img.normalizedUrl} alt={img.alt ?? "Discovered product image"} loading="lazy" />
                <figcaption>
                  <strong>{img.source}</strong>
                  <div style={{ marginTop: "0.2rem", opacity: 0.8 }}>{img.normalizedUrl}</div>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Output Files</h2>
        <div className="field-container">
          <div className="field-label">Folder</div>
          <div className="field-value">
            <FilePath value={files.outputDir} />
          </div>
        </div>
        <div className="field-container">
          <div className="field-label">data.json</div>
          <div className="field-value">
            <FilePath value={files.dataJsonPath} />
          </div>
        </div>
        <div className="field-container">
          <div className="field-label">seo.json</div>
          <div className="field-value">
            <FilePath value={files.seoJsonPath} />
          </div>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="card" style={{ borderColor: "rgba(245, 158, 11, 0.25)" }}>
          <h2 style={{ color: "var(--accent-warning)" }}>Warnings</h2>
          <ul className="warnings">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
