/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public base URL of the backend API (e.g. https://...up.railway.app). */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
