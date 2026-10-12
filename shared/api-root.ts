/**
 * Works out where the browser should send API requests.
 *
 * `configured` is the build-time VITE_BASE_API_URL setting:
 *   (empty)                          the same address as the site, under its base path
 *   dev.example.com:8799             another port on the same domain (uses the page's http/https)
 *   https://api.example.com/hiring   a full address
 *
 * `baseUrl` is the path the site is served from, for example "/job-applicants-review/".
 */
export function resolveApiRoot(configured: string | undefined, baseUrl: string, pageProtocol: string): string {
  const value = (configured ?? '').trim().replace(/\/+$/, '');
  if (!value) return `${baseUrl.replace(/\/+$/, '')}/api`;
  const withScheme = /^https?:\/\//i.test(value) ? value : `${pageProtocol}//${value}`;
  return `${withScheme}/api`;
}

/** Normalises VITE_BASE_PATH ("job-review", "/job-review/", "") to a Vite base such as "/job-review/". */
export function normalizeBasePath(configured: string | undefined): string {
  const trimmed = (configured ?? '').trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}/` : '/';
}

/**
 * Address the local dev server forwards API calls to when the frontend is run
 * on its own against a deployed backend. Returns null when none is configured.
 * A value without http:// or https:// is taken as plain http.
 */
export function devProxyTarget(configured: string | undefined): string | null {
  const value = (configured ?? '').trim().replace(/\/+$/, '');
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}
