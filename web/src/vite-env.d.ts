/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute base URL of the Tylo server, for a split (web ≠ server) deploy.
   *  Leave unset when the server serves this bundle — same-origin is the default. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
