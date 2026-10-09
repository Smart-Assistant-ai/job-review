import { resolveApiRoot } from '../../shared/api-root';
import type { ApiErrorBody } from '../../shared/types';

// During local development the dev server provides both the site and the API,
// so a deployed backend address in the env file is deliberately ignored.
const API_ROOT = resolveApiRoot(
  import.meta.env.DEV ? undefined : import.meta.env.VITE_BASE_API_URL,
  import.meta.env.BASE_URL,
  window.location.protocol,
);

/** Turns an app path such as "/api/admin/session" into the address of the backend. */
export function apiUrl(path: string): string {
  return API_ROOT + path.replace(/^\/api/, '');
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly fieldErrors?: Record<string, string>;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.fieldErrors = body.fieldErrors;
  }
}

/** Fired when the server says the admin session is missing or has expired. */
export const AUTH_EXPIRED_EVENT = 'auth:expired';

interface RequestOptions {
  method?: string;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as multipart form data (file uploads). */
  body?: FormData;
  signal?: AbortSignal;
}

async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: options.method ?? (options.json !== undefined || options.body ? 'POST' : 'GET'),
      headers: options.json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
      // The backend may live on another port of the same domain, so always send the session cookie.
      credentials: 'include',
      signal: options.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, { error: 'Could not reach the server. Check your connection and try again.', code: 'network' });
  }
  if (res.ok) return res;

  let body: ApiErrorBody = { error: 'Something went wrong. Please try again.' };
  try {
    const parsed = (await res.json()) as Partial<ApiErrorBody>;
    if (typeof parsed.error === 'string') body = parsed as ApiErrorBody;
  } catch {
    // Not JSON (for example an error page from a proxy); keep the generic message.
  }
  if (res.status === 401 && body.code === 'unauthenticated') {
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }
  throw new ApiError(res.status, body);
}

export async function api<T = void>(path: string, options?: RequestOptions): Promise<T> {
  const res = await request(path, options);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Fetches a file and its suggested name. */
export async function apiBlob(path: string, options?: RequestOptions): Promise<{ blob: Blob; filename: string | null }> {
  const res = await request(path, options);
  const disposition = res.headers.get('content-disposition') ?? '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="([^"]+)"/i)?.[1];
  let filename: string | null = plain ?? null;
  if (encoded) {
    try {
      filename = decodeURIComponent(encoded);
    } catch {
      // Keep the plain file name.
    }
  }
  return { blob: await res.blob(), filename };
}

/** Hands a file to the browser's normal download flow. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
