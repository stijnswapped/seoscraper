import type { ApiError } from "../api.js";

export function ErrorBanner({ error }: { error: ApiError }) {
  return (
    <div className="error">
      <strong>{error.code}</strong>
      <span>{error.message}</span>
    </div>
  );
}
