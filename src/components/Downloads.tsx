import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DownloadProgress } from '../../shared/types';
import { api, apiBlob, ApiError, apiUrl, saveBlob } from '../lib/api';
import { Button, Icon, Spinner } from './ui';

/** Either specific candidates, or everything matching the candidate list's filters. */
export type Selection = { ids: string[] } | { filters: Record<string, string> };

interface DownloadsApi {
  /**
   * Starts a ZIP of resumes for the selection. Rejects with a readable error
   * (nothing matches, session expired) before anything is downloaded.
   */
  startZip: (selection: Selection, label: string) => Promise<void>;
  /** Downloads a CSV of applicants for the selection. Rejects with a readable error. */
  exportCsv: (selection: Selection) => Promise<void>;
}

const DownloadsContext = createContext<DownloadsApi | null>(null);

export function useDownloads(): DownloadsApi {
  const value = useContext(DownloadsContext);
  if (!value) throw new Error('useDownloads must be used inside DownloadsProvider');
  return value;
}

interface ActiveDownload {
  id: string;
  label: string;
  progress: DownloadProgress;
  problem: string | null;
}

export function DownloadsProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveDownload | null>(null);

  const startZip = useCallback(async (selection: Selection, label: string) => {
    // Step 1: the server checks the selection and hands back a one-time download ID.
    const prepared = await api<{ downloadId: string; total: number }>('/api/admin/resumes/zip', { json: selection });

    // Step 2: let the browser fetch the ZIP as a normal download, so it is
    // streamed straight to disk with the browser's own progress bar instead of
    // being held in memory. The page stays where it is.
    const link = document.createElement('a');
    link.href = apiUrl(`/api/admin/resumes/zip/${prepared.downloadId}`);
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();

    setActive({
      id: prepared.downloadId,
      label,
      progress: { state: 'running', total: prepared.total, added: 0, missing: 0 },
      problem: null,
    });
  }, []);

  const exportCsv = useCallback(async (selection: Selection) => {
    const { blob, filename } = await apiBlob('/api/admin/export', { json: selection });
    saveBlob(blob, filename ?? 'applicants.csv');
  }, []);

  const running = active !== null && active.problem === null && active.progress.state === 'running';
  const activeId = active?.id;

  useEffect(() => {
    if (!running || !activeId) return;
    let stopped = false;
    const poll = async () => {
      try {
        const progress = await api<DownloadProgress>(`/api/admin/downloads/${activeId}`);
        if (!stopped) setActive((a) => (a && a.id === activeId ? { ...a, progress } : a));
      } catch (err) {
        // A brief network blip should not end the display; a definite answer from the server does.
        if (!stopped && err instanceof ApiError && err.status !== 0) {
          setActive((a) => (a && a.id === activeId ? { ...a, problem: 'Progress is no longer available for this download.' } : a));
        }
      }
    };
    const timer = setInterval(poll, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [running, activeId]);

  const value = useMemo(() => ({ startZip, exportCsv }), [startZip, exportCsv]);

  return (
    <DownloadsContext.Provider value={value}>
      {children}
      {active && <DownloadStatus download={active} onClose={() => setActive(null)} />}
    </DownloadsContext.Provider>
  );
}

function DownloadStatus({ download, onClose }: { download: ActiveDownload; onClose: () => void }) {
  const { progress, problem } = download;
  const processed = progress.added + progress.missing;
  const percent = progress.total > 0 ? Math.round((processed / progress.total) * 100) : 0;
  const failed = problem ?? (progress.state === 'failed' ? (progress.message ?? 'The download failed.') : null);
  const cancelled = progress.state === 'cancelled';
  const done = progress.state === 'done';

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-4 bottom-4 z-50 w-[calc(100%-2rem)] max-w-sm rounded-xl border border-slate-200 bg-white p-4 shadow-lg"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-slate-500">
          {failed || cancelled ? <Icon name="alert" className="text-red-600" /> : done ? <Icon name="check" className="text-emerald-600" /> : <Spinner />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{download.label}</p>
          <p className="mt-0.5 text-sm text-slate-600">
            {failed
              ? failed
              : cancelled
                ? 'The download was cancelled.'
                : done
                  ? `${progress.added} of ${progress.total} resumes added to the ZIP.`
                  : `Adding resumes: ${processed} of ${progress.total}`}
          </p>
          {done && progress.missing > 0 && (
            <p className="mt-1 text-xs text-amber-700">
              {progress.missing} could not be included. See _download-report.txt inside the ZIP.
            </p>
          )}
          {!failed && !cancelled && !done && (
            <>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                <div className="h-full rounded-full bg-brand-600 transition-[width]" style={{ width: `${percent}%` }} />
              </div>
              <p className="mt-1.5 text-xs text-slate-500">Your browser saves the file as it is built. Large downloads can take a few minutes.</p>
            </>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Dismiss">
          <Icon name="close" />
        </Button>
      </div>
    </div>
  );
}
