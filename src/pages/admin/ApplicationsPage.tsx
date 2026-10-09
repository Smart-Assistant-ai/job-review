import { useEffect, useMemo, useRef, useState, type InputHTMLAttributes } from 'react';
import { Link, useSearchParams } from 'react-router';
import { APPLICATION_STATUSES, CURRENCIES, PAGE_SIZES, type ApplicationStatus } from '../../../shared/constants';
import type { ApplicationDto, ApplicationListResponse, SortKey } from '../../../shared/types';
import { useSession } from '../../components/AdminLayout';
import { useDownloads, type Selection } from '../../components/Downloads';
import { Alert, Button, Card, cx, Icon, inputClass, PageLoading, Spinner, statusTone } from '../../components/ui';
import { api, ApiError, apiBlob, saveBlob } from '../../lib/api';
import { experienceOptions, formatDate, formatExperience, formatMoney } from '../../lib/format';
import { useApi } from '../../lib/useApi';

/** URL parameters that narrow the result set (as opposed to sorting or paging it). */
const FILTER_KEYS = ['q', 'job', 'status', 'experience', 'ctcCurrency', 'ctcMin', 'ctcMax', 'from', 'to'] as const;
const EXTRA_FILTER_KEYS = ['ctcCurrency', 'ctcMin', 'ctcMax', 'from', 'to'] as const;

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: 'name', label: 'Candidate' },
  { key: 'job', label: 'Job' },
  { key: 'experience', label: 'Experience' },
  { key: 'ctc', label: 'Current CTC', className: 'text-right' },
  { key: 'submittedAt', label: 'Applied' },
  { key: 'status', label: 'Status' },
];

/** A text box that updates the URL shortly after typing stops. */
function DebouncedInput({
  value,
  onCommit,
  className,
  ...rest
}: { value: string; onCommit: (value: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [text, setText] = useState(value);
  const committed = useRef(value);

  useEffect(() => {
    // Follow outside changes such as "Clear filters" or the browser's back button.
    if (value !== committed.current) {
      committed.current = value;
      setText(value);
    }
  }, [value]);

  useEffect(() => {
    if (text === committed.current) return;
    const timer = setTimeout(() => {
      committed.current = text;
      onCommit(text);
    }, 350);
    return () => clearTimeout(timer);
  }, [text, onCommit]);

  return <input {...rest} className={cx(inputClass(), className)} value={text} onChange={(e) => setText(e.target.value)} />;
}

export function ApplicationsPage() {
  const { timezone } = useSession();
  const downloads = useDownloads();
  const [params, setParams] = useSearchParams();
  const query = params.toString();
  const { data, error, loading, reload, setData } = useApi<ApplicationListResponse>(`/api/admin/applications?${query}`);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<ApplicationStatus | ''>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const get = (key: string) => params.get(key) ?? '';
  const filterSignature = FILTER_KEYS.map((k) => get(k)).join('\u0001');
  const hasFilters = FILTER_KEYS.some((k) => get(k) !== '');
  const [showMore, setShowMore] = useState(() => EXTRA_FILTER_KEYS.some((k) => get(k) !== ''));

  // A selection only makes sense for the result set it was made in.
  useEffect(() => setSelected(new Set()), [filterSignature]);

  const update = useMemo(
    () => (patch: Record<string, string>) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          // Any change other than paging returns to the first page.
          if (!('page' in patch)) next.delete('page');
          for (const [key, value] of Object.entries(patch)) {
            if (value === '') next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const sort = (get('sort') || 'submittedAt') as SortKey;
  const dir = get('dir') === 'asc' ? 'asc' : 'desc';
  const toggleSort = (key: SortKey) => {
    // First click sorts A→Z for text and newest/highest first for everything else.
    const firstDir = key === 'name' || key === 'job' || key === 'status' ? 'asc' : 'desc';
    update({ sort: key, dir: sort === key ? (dir === 'asc' ? 'desc' : 'asc') : firstDir });
  };

  const jobs = data?.jobs ?? [];
  const jobTitles = useMemo(() => new Map(jobs.map((j) => [j.id, j.title])), [jobs]);
  const selectedJob = jobs.find((j) => j.id === get('job'));
  const items = data?.items ?? [];
  const pageIds = items.map((i) => i.id);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someOnPageSelected = pageIds.some((id) => selected.has(id));
  const headerCheckbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerCheckbox.current) headerCheckbox.current.indeterminate = someOnPageSelected && !allOnPageSelected;
  }, [someOnPageSelected, allOnPageSelected]);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const togglePage = () =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of pageIds) {
        if (allOnPageSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  const fail = (err: unknown, fallback: string) =>
    setNotice({ tone: 'error', text: err instanceof ApiError ? err.message : fallback });

  const changeStatus = async (app: ApplicationDto, status: ApplicationStatus) => {
    const previous = app.status;
    setNotice(null);
    // Show the change at once; put it back if the save fails.
    setData((d) => ({ ...d, items: d.items.map((i) => (i.id === app.id ? { ...i, status } : i)) }));
    try {
      await api(`/api/admin/applications/${app.id}`, { method: 'PATCH', json: { status } });
    } catch (err) {
      setData((d) => ({ ...d, items: d.items.map((i) => (i.id === app.id ? { ...i, status: previous } : i)) }));
      fail(err, 'The status could not be saved.');
    }
  };

  const applyBulkStatus = async () => {
    if (!bulkStatus || selected.size === 0) return;
    setBusy('bulk-status');
    setNotice(null);
    try {
      const result = await api<{ updated: string[]; notFound: string[] }>('/api/admin/applications/bulk-status', {
        json: { ids: [...selected], status: bulkStatus },
      });
      const count = selected.size - result.notFound.length;
      setNotice({
        tone: 'success',
        text: `${count} ${count === 1 ? 'candidate' : 'candidates'} set to ${bulkStatus}.${result.notFound.length > 0 ? ` ${result.notFound.length} no longer exist.` : ''}`,
      });
      setBulkStatus('');
      setSelected(new Set());
      reload();
    } catch (err) {
      fail(err, 'The status could not be saved.');
    } finally {
      setBusy(null);
    }
  };

  const filterFields = (): Record<string, string> => {
    const fields: Record<string, string> = {};
    for (const key of [...FILTER_KEYS, 'sort', 'dir']) if (get(key) !== '') fields[key] = get(key);
    return fields;
  };

  const exportCsv = async (selection: Selection, key: string) => {
    setBusy(key);
    setNotice(null);
    try {
      await downloads.exportCsv(selection);
    } catch (err) {
      fail(err, 'The export failed.');
    } finally {
      setBusy(null);
    }
  };

  const downloadZip = async (selection: Selection, label: string, key: string) => {
    setBusy(key);
    setNotice(null);
    try {
      await downloads.startZip(selection, label);
    } catch (err) {
      fail(err, 'The download could not be started.');
    } finally {
      setBusy(null);
    }
  };

  const downloadResume = async (app: ApplicationDto) => {
    setBusy(`resume-${app.id}`);
    setNotice(null);
    try {
      const { blob, filename } = await apiBlob(`/api/admin/applications/${app.id}/resume`);
      saveBlob(blob, filename ?? app.resumeFilename ?? 'resume');
    } catch (err) {
      fail(err, 'The resume could not be downloaded.');
    } finally {
      setBusy(null);
    }
  };

  const selectClass = cx(inputClass(), 'pr-8');
  const total = data?.total ?? 0;
  const firstRow = data && total > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const lastRow = data ? Math.min(data.page * data.pageSize, total) : 0;

  return (
    <div className="space-y-4 pb-24">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Candidates</h1>
          <p className="mt-0.5 flex items-center gap-2 text-sm text-slate-600" aria-live="polite">
            {data ? `${total} ${total === 1 ? 'candidate' : 'candidates'}${selectedJob ? ` for ${selectedJob.title}` : ''}` : ' '}
            {loading && data && <Spinner className="text-slate-400" />}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {selectedJob && (
            <>
              <Button icon="download" busy={busy === 'zip-all'} onClick={() => downloadZip({ filters: { job: selectedJob.id } }, `All resumes: ${selectedJob.title}`, 'zip-all')}>
                All resumes
              </Button>
              <Button icon="download" busy={busy === 'zip-shortlisted'} onClick={() => downloadZip({ filters: { job: selectedJob.id, status: 'Shortlisted' } }, `Shortlisted resumes: ${selectedJob.title}`, 'zip-shortlisted')}>
                Shortlisted resumes
              </Button>
            </>
          )}
          <Button icon="file" busy={busy === 'export-filtered'} disabled={total === 0} onClick={() => exportCsv({ filters: filterFields() }, 'export-filtered')}>
            Export CSV
          </Button>
        </div>
      </div>

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
          <label className="relative block">
            <span className="sr-only">Search candidates</span>
            <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
            <DebouncedInput type="search" className="pl-9" placeholder="Search name, email, phone, location…" value={get('q')} onCommit={(q) => update({ q })} />
          </label>
          <select aria-label="Job" className={selectClass} value={get('job')} onChange={(e) => update({ job: e.target.value })}>
            <option value="">All jobs</option>
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.title}
                {job.status !== 'Published' ? ` (${job.status})` : ''}
              </option>
            ))}
          </select>
          <select aria-label="Status" className={selectClass} value={get('status')} onChange={(e) => update({ status: e.target.value })}>
            <option value="">Any status</option>
            {APPLICATION_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <select aria-label="Experience" className={selectClass} value={get('experience')} onChange={(e) => update({ experience: e.target.value })}>
            <option value="">Any experience</option>
            {experienceOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {showMore && (
          <div className="mt-3 grid gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2 lg:grid-cols-5">
            <label className="block text-xs font-medium text-slate-600">
              Applied from
              <input type="date" className={cx(inputClass(), 'mt-1')} value={get('from')} max={get('to') || undefined} onChange={(e) => update({ from: e.target.value })} />
            </label>
            <label className="block text-xs font-medium text-slate-600">
              Applied to
              <input type="date" className={cx(inputClass(), 'mt-1')} value={get('to')} min={get('from') || undefined} onChange={(e) => update({ to: e.target.value })} />
            </label>
            <label className="block text-xs font-medium text-slate-600">
              CTC currency
              <select className={cx(selectClass, 'mt-1')} value={get('ctcCurrency')} onChange={(e) => update({ ctcCurrency: e.target.value })}>
                <option value="">Any currency</option>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-medium text-slate-600">
              Minimum annual CTC
              <DebouncedInput className="mt-1" inputMode="numeric" placeholder="e.g. 1000000" value={get('ctcMin')} onCommit={(v) => update({ ctcMin: v.replace(/[^\d.]/g, '') })} />
            </label>
            <label className="block text-xs font-medium text-slate-600">
              Maximum annual CTC
              <DebouncedInput className="mt-1" inputMode="numeric" placeholder="e.g. 2500000" value={get('ctcMax')} onCommit={(v) => update({ ctcMax: v.replace(/[^\d.]/g, '') })} />
            </label>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-medium">
          <button type="button" className="text-brand-700 hover:underline" aria-expanded={showMore} onClick={() => setShowMore((v) => !v)}>
            {showMore ? 'Fewer filters' : 'More filters: date and CTC'}
          </button>
          {hasFilters && (
            <button
              type="button"
              className="text-slate-600 hover:underline"
              onClick={() => update(Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])))}
            >
              Clear all filters
            </button>
          )}
          {(get('ctcMin') || get('ctcMax')) && !get('ctcCurrency') && (
            <span className="font-normal text-amber-700">Choose a currency so amounts are compared like for like.</span>
          )}
        </div>
      </Card>

      {notice && (
        <Alert tone={notice.tone} action={<Button size="sm" variant="ghost" onClick={() => setNotice(null)} aria-label="Dismiss"><Icon name="close" /></Button>}>
          {notice.text}
        </Alert>
      )}

      {error && !data ? (
        <Alert title="Candidates could not be loaded" action={<Button size="sm" onClick={reload}>Retry</Button>}>
          {error.message}
        </Alert>
      ) : !data ? (
        <PageLoading />
      ) : total === 0 ? (
        <Card className="px-6 py-14 text-center">
          <h2 className="text-base font-semibold text-slate-900">{hasFilters ? 'No candidates match these filters' : 'No applications yet'}</h2>
          <p className="mt-1 text-sm text-slate-600">
            {hasFilters ? 'Try removing a filter or changing the search.' : 'Applications appear here as soon as candidates submit them.'}
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {error && <Alert className="m-3">{error.message}</Alert>}
          {allOnPageSelected && data.allIds.length > pageIds.length && (
            <div className="border-b border-slate-200 bg-brand-50 px-4 py-2 text-center text-xs text-brand-900">
              {selected.size >= data.allIds.length ? (
                <>All {data.allIds.length} matching candidates are selected.</>
              ) : (
                <>
                  The {pageIds.length} candidates on this page are selected.{' '}
                  <button type="button" className="font-semibold underline" onClick={() => setSelected(new Set(data.allIds))}>
                    Select all {data.allIds.length} matching candidates
                  </button>
                </>
              )}
            </div>
          )}
          <div className={cx('overflow-x-auto transition-opacity', loading && 'opacity-60')}>
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                <tr>
                  <th className="w-10 px-4 py-2.5">
                    <input ref={headerCheckbox} type="checkbox" className="h-4 w-4 rounded border-slate-300 accent-brand-600" checked={allOnPageSelected} onChange={togglePage} aria-label="Select all candidates on this page" />
                  </th>
                  {COLUMNS.map((column) => (
                    <th key={column.key} className={cx('px-3 py-2.5', column.className)} aria-sort={sort === column.key ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                      <button type="button" className="inline-flex items-center gap-1 hover:text-slate-900" onClick={() => toggleSort(column.key)}>
                        {column.label}
                        {sort === column.key && <Icon name={dir === 'asc' ? 'up' : 'down'} className="h-3.5 w-3.5" />}
                      </button>
                    </th>
                  ))}
                  <th className="px-3 py-2.5 text-right">Resume</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((app) => {
                  const isSelected = selected.has(app.id);
                  const knownStatus = (APPLICATION_STATUSES as readonly string[]).includes(app.status);
                  return (
                    <tr key={app.id} className={cx(isSelected ? 'bg-brand-50/60' : 'hover:bg-slate-50/60')}>
                      <td className="px-4 py-2.5">
                        <input type="checkbox" className="h-4 w-4 rounded border-slate-300 accent-brand-600" checked={isSelected} onChange={() => toggle(app.id)} aria-label={`Select ${app.fullName}`} />
                      </td>
                      <td className="max-w-[16rem] px-3 py-2.5">
                        <Link to={`/admin/applications/${app.id}`} state={{ from: `/admin/applications?${query}` }} className="block truncate font-medium text-slate-900 hover:text-brand-700">
                          {app.fullName}
                        </Link>
                        <p className="truncate text-xs text-slate-500">
                          {app.email}
                          {app.location ? ` · ${app.location}` : ''}
                        </p>
                      </td>
                      <td className="max-w-[12rem] truncate px-3 py-2.5 text-slate-700">{jobTitles.get(app.jobId) ?? app.jobTitle}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-700">{formatExperience(app.experienceRange, app.experienceYears)}</td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap text-slate-700 tabular-nums">{formatMoney(app.ctcAmount, app.ctcCurrency)}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">{formatDate(app.submittedAt, timezone)}</td>
                      <td className="px-3 py-2.5">
                        {/* A status pill that is also the control for changing it. */}
                        <select
                          aria-label={`Status of ${app.fullName}`}
                          className={cx('h-7 cursor-pointer rounded-full border-0 py-0 pr-7 pl-2.5 text-xs font-medium ring-1 ring-inset', statusTone(app.status))}
                          value={knownStatus ? app.status : ''}
                          onChange={(e) => changeStatus(app, e.target.value as ApplicationStatus)}
                        >
                          {!knownStatus && <option value="">{app.status}</option>}
                          {APPLICATION_STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {status}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <Button size="sm" variant="ghost" busy={busy === `resume-${app.id}`} disabled={!app.resumeFileId} onClick={() => downloadResume(app)} aria-label={`Download resume of ${app.fullName}`}>
                          {busy === `resume-${app.id}` ? null : <Icon name="download" />}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
            <p>
              Showing {firstRow}–{lastRow} of {total}
            </p>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs">
                Rows per page
                <select className={cx(selectClass, 'w-auto py-1')} value={data.pageSize} onChange={(e) => update({ pageSize: e.target.value })}>
                  {PAGE_SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>
              <span className="text-xs">
                Page {data.page} of {data.pageCount}
              </span>
              <Button size="sm" icon="left" disabled={data.page <= 1} onClick={() => update({ page: String(data.page - 1) })}>
                Previous
              </Button>
              <Button size="sm" disabled={data.page >= data.pageCount} onClick={() => update({ page: String(data.page + 1) })}>
                Next <Icon name="right" />
              </Button>
            </div>
          </div>
        </Card>
      )}

      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 shadow-[0_-4px_12px_rgba(15,23,42,0.06)] backdrop-blur" role="region" aria-label="Actions for selected candidates">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
            <p className="text-sm font-semibold text-slate-900">
              {selected.size} selected
            </p>
            <div className="flex items-center gap-2">
              <select aria-label="New status for selected candidates" className={cx(selectClass, 'h-10 w-44 py-0')} value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value as ApplicationStatus | '')}>
                <option value="">Set status to…</option>
                {APPLICATION_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
              <Button variant="primary" disabled={!bulkStatus} busy={busy === 'bulk-status'} onClick={applyBulkStatus}>
                Apply
              </Button>
            </div>
            <Button icon="download" busy={busy === 'zip-selected'} onClick={() => downloadZip({ ids: [...selected] }, `Resumes of ${selected.size} selected ${selected.size === 1 ? 'candidate' : 'candidates'}`, 'zip-selected')}>
              Download resumes
            </Button>
            <Button icon="file" busy={busy === 'export-selected'} onClick={() => exportCsv({ ids: [...selected] }, 'export-selected')}>
              Export CSV
            </Button>
            <Button variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
