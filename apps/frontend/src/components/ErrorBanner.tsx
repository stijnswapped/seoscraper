import type { ApiError } from "../api.js";

export function ErrorBanner({ error }: { error: ApiError }) {
  return (
    <div className="error-banner">
      <strong>{error.code}</strong>
      <div>{error.message}</div>
    </div>
  );
}
