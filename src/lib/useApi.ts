import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

export interface ApiState<T> {
  data: T | undefined;
  error: ApiError | null;
  /** True while a request is in flight, including background refreshes. */
  loading: boolean;
  reload: () => void;
  /** Replace the data locally, for instant feedback after a successful change. */
  setData: (updater: (current: T) => T) => void;
}

/**
 * Loads JSON from the API whenever the path changes. Earlier data stays
 * visible while newer data loads, so tables do not flicker on every filter.
 */
export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);
  const loadedPath = useRef<string | null>(null);

  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    setLoading(true);
    api<T>(path, { signal: controller.signal }).then(
      (result) => {
        loadedPath.current = path;
        setDataState(result);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if ((err as Error).name === 'AbortError') return;
        setError(err instanceof ApiError ? err : new ApiError(0, { error: 'Something went wrong. Please try again.' }));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setData = useCallback((updater: (current: T) => T) => {
    setDataState((current) => (current === undefined ? current : updater(current)));
  }, []);

  return { data, error, loading, reload, setData };
}
