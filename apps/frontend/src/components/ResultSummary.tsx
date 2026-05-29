import type { ExtractedField, ProductCheckResult } from "../api.js";
import { ImageGallery } from "./ImageGallery.js";

function isUrl(v: string | null): v is string {
  return !!v && /^https?:\/\//i.test(v);
}

function Field({ label, field }: { label: string; field: ExtractedField<string | null> }) {
  return (
    <div className="field-block">
      <span className="k">{label}</span>
      <div className="v">
        {field.value == null ? (
          <em className="muted">not found</em>
        ) : isUrl(field.value) ? (
          <a href={field.value} target="_blank" rel="noreferrer">{field.value}</a>
        ) : (
          field.value
        )}
      </div>
      <div className="meta">
        {field.source} · {field.confidence.toFixed(2)}
        {field.warnings.length > 0 && <span className="warn-inline"> · ⚠ {field.warnings.join("; ")}</span>}
      </div>
    </div>
  );
}

function Pills({ data }: { data: Record<string, string> }) {
  const entries = Object.entries(data);
  if (entries.length === 0) return null;
  return (
    <div className="pills">
      {entries.map(([k, v]) => (
        <span className="pill" key={k} title={v}>
          <b>{k}</b> {v.length > 48 ? `${v.slice(0, 48)}…` : v}
        </span>
      ))}
    </div>
  );
}

interface Props {
  result: ProductCheckResult;
  fileBaseUrl: string;
}

export function ResultSummary({ result, fileBaseUrl }: Props) {
  const { seo, product, images, finalUrl, domain, checkedAt } = result;
  const selective = images.strategy.mode === "selective";

  return (
    <div className="anim">
      <section className="card">
        <div className="card-head">
          <h2>{product.title.value ?? seo.title.value ?? domain}</h2>
          <span className={`tag ${selective ? "ok" : "warn"}`}>{images.strategy.mode}</span>
        </div>
        <p className="muted">
          <a href={finalUrl} target="_blank" rel="noreferrer">{finalUrl}</a>
          {" · "}{new Date(checkedAt).toLocaleString()}
        </p>
        <div className="stats">
          <div className="stat"><b>{images.discovered.length}</b><span>found</span></div>
          <div className="stat ok"><b>{images.downloaded.length}</b><span>kept</span></div>
          <div className="stat"><b>{images.skipped.length}</b><span>skipped</span></div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Image library</h2>
        </div>
        <p className="muted">{images.strategy.reason}</p>
        <ImageGallery images={images.downloaded} fileBaseUrl={fileBaseUrl} />
        {images.downloaded.length === 0 && images.discovered.length > 0 && (
          <div className="gallery">
            {images.discovered.slice(0, 12).map((img) => (
              <figure key={img.normalizedUrl}>
                <img src={img.normalizedUrl} alt={img.alt ?? ""} loading="lazy" />
                <figcaption>{img.source}</figcaption>
              </figure>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>SEO &amp; meta</h2>
        </div>
        <Field label="SEO title" field={seo.title} />
        <Field label="SEO description" field={seo.description} />
        <Field label="Canonical URL" field={seo.canonicalUrl} />
        <Field label="Product title" field={product.title} />
        <Field label="Product description" field={product.description} />
        <div className="meta" style={{ marginTop: ".6rem" }}>
          structured-data nodes: {product.structuredData.length}
        </div>
        <Pills data={seo.openGraph} />
        <Pills data={seo.twitter} />
      </section>

      {result.warnings.length > 0 && (
        <section className="card warn">
          <h2>Warnings</h2>
          <ul className="warnings">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
