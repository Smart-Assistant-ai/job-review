/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Sub-folder the site is served from. Empty when it lives at the root of the domain. */
  readonly VITE_BASE_PATH?: string;
  /** Address of the backend when it is not the same as the site's. */
  readonly VITE_BASE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
