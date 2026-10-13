import { useEffect, useMemo, useRef, useState, type InputHTMLAttributes, type MouseEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { APPLICATION_STATUSES, CURRENCIES, PAGE_SIZES, type ApplicationStatus } from '../../../shared/constants';
import type { ApplicationDto, ApplicationListResponse, SortKey } from '../../../shared/types';
import { useSession } from '../../components/AdminLayout';
import { useDownloads, type Selection } from '../../components/Downloads';
import {
  Alert,
  Avatar,
  Button,
  Card,
  cx,
  EmptyState,
  Icon,
  IconButton,
  inputClass,
  Menu,
  Skeleton,
  Spinner,
  statusSolid,
  statusTone,
  Tabs,
  useToast,
} from '../../components/ui';
import { api, ApiError, apiBlob, saveBlob } from '../../lib/api';
import { experienceOptions, formatDateTime, formatExperience, formatMoney, plural, timeAgo } from '../../lib/format';
import { saveReviewQueue } from '../../lib/reviewQueue';
import { useApi } from '../../lib/useApi';

/** URL parameters that narrow the result set (as opposed to sorting or paging it). */
const FILTER_KEYS = ['q', 'job', 'status', 'experience', 'ctcCurrency', 'ctcMin', 'ctcMax', 'from', 'to'] as const;
const EXTRA_FILTER_KEYS = ['ctcCurrency', 'ctcMin', 'ctcMax', 'from', 'to'] as const;

const STATUS_TAB_LABELS: Record<string, string> = { 'Under Review': 'In review' };

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
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = params.toString();
  const { data, error, loading, reload, setData } = useApi<ApplicationListResponse>(`/api/admin/applications?${query}`);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const get = (key: string) => params.get(key) ?? '';
  const filterSignature = FILTER_KEYS.map((k) => get(k)).join('\u0001');
  const hasFilters = FILTER_KEYS.some((k) => get(k) !== '');
  const extraFilterCount = EXTRA_FILTER_KEYS.filter((k) => get(k) !== '').length;
  const [showMore, setShowMore] = useState(extraFilterCount > 0);

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

  const fail = (err: unknown, fallback: string) => toast({ tone: 'error', text: err instanceof ApiError ? err.message : fallback });

  /** Opens a candidate and remembers this list, so "next" on that screen follows the same order. */
  const openCandidate = (id: string) => {
    if (data) saveReviewQueue({ ids: data.allIds, from: `/admin/applications${query ? `?${query}` : ''}` });
    navigate(`/admin/applications/${id}`);
  };
  const onRowClick = (event: MouseEvent<HTMLTableRowElement>, id: string) => {
    // Checkboxes, menus, links and buttons inside the row keep their own behaviour.
    if ((event.target as HTMLElement).closest('a,button,input,select,label')) return;
    openCandidate(id);
  };

  const changeStatus = async (app: ApplicationDto, status: ApplicationStatus) => {
    if (status === app.status) return;
    const previous = app.status;
    // Show the change at once; put it back if the save fails.
    setData((d) => ({ ...d, items: d.items.map((i) => (i.id === app.id ? { ...i, status } : i)) }));
    try {
      await api(`/api/admin/applications/${app.id}`, { method: 'PATCH', json: { status } });
      toast({ tone: 'success', text: `${app.fullName} moved to ${status}` });
      // Refreshes the tab counts, and drops the row if it no longer matches the open tab.
      reload();
    } catch (err) {
      setData((d) => ({ ...d, items: d.items.map((i) => (i.id === app.id ? { ...i, status: previous } : i)) }));
      fail(err, 'The status could not be saved.');
    }
  };

  const applyBulkStatus = async (status: ApplicationStatus) => {
    if (selected.size === 0) return;
    setBusy(`bulk-${status}`);
    try {
      const result = await api<{ updated: string[]; notFound: string[] }>('/api/admin/applications/bulk-status', {
        json: { ids: [...selected], status },
      });
      const count = selected.size - result.notFound.length;
      toast({ tone: 'success', text: `${plural(count, 'candidate')} moved to ${status}` });
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
    try {
      const { blob, filename } = await apiBlob(`/api/admin/applications/${app.id}/resume`);
      saveBlob(blob, filename ?? app.resumeFilename ?? 'resume');
    } catch (err) {
      fail(err, 'The resume could not be downloaded.');
    } finally {
      setBusy(null);
    }
  };

  const selectClass = cx(inputClass(), 'pr-10');
  const total = data?.total ?? 0;
  const firstRow = data && total > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const lastRow = data ? Math.min(data.page * data.pageSize, total) : 0;
  const counts = data?.statusCounts;
  const showJobColumn = !selectedJob;

  const columns: { key: SortKey; label: string; className?: string }[] = [
    { key: 'name', label: 'Candidate' },
    ...(showJobColumn ? [{ key: 'job' as const, label: 'Job' }] : []),
    { key: 'experience', label: 'Experience' },
    { key: 'ctc', label: 'Current CTC', className: 'text-right' },
    { key: 'submittedAt', label: 'Applied' },
    { key: 'status', label: 'Status' },
  ];

  return (
    <div className="space-y-4 pb-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Candidates</h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-slate-500" aria-live="polite">
            {data ? (selectedJob ? `Applying for ${selectedJob.title}` : 'Across all jobs') : ' '}
            {loading && data && <Spinner className="text-slate-400" />}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Menu
            button={(props) => (
              <Button icon="download" busy={busy === 'export-filtered' || busy === 'zip-all' || busy === 'zip-shortlisted'} {...props}>
                Export <Icon name="down" className="h-3.5 w-3.5" />
              </Button>
            )}
            items={[
              {
                label: 'Export this list as CSV',
                icon: 'file',
                disabled: total === 0,
                hint: 'Nothing to export',
                onSelect: () => void exportCsv({ filters: filterFields() }, 'export-filtered'),
              },
              {
                label: 'Download all resumes (ZIP)',
                icon: 'download',
                disabled: !selectedJob,
                hint: 'Choose a job first',
                onSelect: () => selectedJob && void downloadZip({ filters: { job: selectedJob.id } }, `All resumes: ${selectedJob.title}`, 'zip-all'),
              },
              {
                label: 'Download shortlisted resumes (ZIP)',
                icon: 'star',
                disabled: !selectedJob,
                hint: 'Choose a job first',
                onSelect: () =>
                  selectedJob &&
                  void downloadZip({ filters: { job: selectedJob.id, status: 'Shortlisted' } }, `Shortlisted resumes: ${selectedJob.title}`, 'zip-shortlisted'),
              },
            ]}
          />
          <Button variant="primary" disabled={total === 0} onClick={() => data && openCandidate(data.allIds[0])}>
            Review {total > 0 ? plural(total, 'candidate') : 'candidates'} <Icon name="arrowRight" />
          </Button>
        </div>
      </div>

      <Card>
        {/* Pipeline stages as tabs: one click to see who is waiting at each step. */}
        <div className="border-b border-slate-200 px-3">
          <Tabs
            label="Filter by status"
            value={get('status')}
            onChange={(status) => update({ status })}
            items={[
              { value: '', label: 'All', count: counts?.all },
              ...APPLICATION_STATUSES.map((status) => ({
                value: status,
                label: STATUS_TAB_LABELS[status] ?? status,
                count: counts?.[status],
                dot: statusSolid(status),
              })),
            ]}
          />
        </div>

        <div className="space-y-3 p-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1fr)_auto]">
            <label className="relative block">
              <span className="sr-only">Search candidates</span>
              <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
              <DebouncedInput type="search" className="pl-9" placeholder="Search name, email, phone, location, notes…" value={get('q')} onCommit={(q) => update({ q })} />
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
            <select aria-label="Experience" className={selectClass} value={get('experience')} onChange={(e) => update({ experience: e.target.value })}>
              <option value="">Any experience</option>
              {experienceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <Button icon="sliders" aria-expanded={showMore} onClick={() => setShowMore((v) => !v)} className={extraFilterCount > 0 ? 'border-brand-300 text-brand-700' : undefined}>
              Filters
              {extraFilterCount > 0 && (
                <span className="rounded-full bg-brand-100 px-1.5 py-0.5 text-[11px] leading-none font-semibold text-brand-800">{extraFilterCount}</span>
              )}
            </Button>
          </div>

          {showMore && (
            <div className="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-2 lg:grid-cols-5">
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
              {(get('ctcMin') || get('ctcMax')) && !get('ctcCurrency') && (
                <p className="text-xs text-amber-700 sm:col-span-2 lg:col-span-5">Choose a currency so amounts are compared like for like.</p>
              )}
            </div>
          )}

          {hasFilters && (
            <div className="flex items-center gap-3 text-xs">
              <span className="text-slate-500">{plural(total, 'match', 'matches')}</span>
              <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => update(Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])))}>
                Clear all filters
              </button>
            </div>
          )}
        </div>

        {error && !data ? (
          <div className="p-3">
            <Alert title="Candidates could not be loaded" action={<Button size="sm" onClick={reload}>Retry</Button>}>
              {error.message}
            </Alert>
          </div>
        ) : !data ? (
          <div className="space-y-3 border-t border-slate-200 p-4" role="status" aria-label="Loading candidates">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-48" />
                  <Skeleton className="h-3 w-64" />
                </div>
                <Skeleton className="h-6 w-24 rounded-full" />
              </div>
            ))}
          </div>
        ) : total === 0 ? (
          <div className="border-t border-slate-200">
            <EmptyState icon={hasFilters ? 'search' : 'inbox'} title={hasFilters ? 'No candidates match' : 'No applications yet'}>
              {hasFilters ? 'Try another status tab, or remove a filter.' : 'Applications appear here as soon as candidates submit them.'}
            </EmptyState>
          </div>
        ) : (
          <>
            {error && <Alert className="m-3">{error.message}</Alert>}
            {allOnPageSelected && data.allIds.length > pageIds.length && (
              <div className="border-t border-brand-100 bg-brand-50 px-4 py-2 text-center text-xs text-brand-900">
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
            <div className={cx('overflow-x-auto border-t border-slate-200 transition-opacity', loading && 'opacity-60')}>
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500">
                  <tr>
                    <th className="w-10 py-2.5 pr-1 pl-4">
                      <input ref={headerCheckbox} type="checkbox" className="h-4 w-4 rounded border-slate-300 accent-brand-600" checked={allOnPageSelected} onChange={togglePage} aria-label="Select all candidates on this page" />
                    </th>
                    {columns.map((column) => (
                      <th key={column.key} className={cx('px-3 py-2.5', column.className)} aria-sort={sort === column.key ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                        <button type="button" className="inline-flex items-center gap-1 hover:text-slate-900" onClick={() => toggleSort(column.key)}>
                          {column.label}
                          {sort === column.key && <Icon name={dir === 'asc' ? 'up' : 'down'} className="h-3.5 w-3.5" />}
                        </button>
                      </th>
                    ))}
                    <th className="px-3 py-2.5">
                      <span className="sr-only">Quick actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((app) => {
                    const isSelected = selected.has(app.id);
                    const isNew = app.status === 'New';
                    const knownStatus = (APPLICATION_STATUSES as readonly string[]).includes(app.status);
                    return (
                      <tr
                        key={app.id}
                        onClick={(event) => onRowClick(event, app.id)}
                        className={cx('group cursor-pointer', isSelected ? 'bg-brand-50/70' : 'hover:bg-slate-50')}
                      >
                        <td className="py-2.5 pr-1 pl-4">
                          <input type="checkbox" className="h-4 w-4 rounded border-slate-300 accent-brand-600" checked={isSelected} onChange={() => toggle(app.id)} aria-label={`Select ${app.fullName}`} />
                        </td>
                        <td className="max-w-[18rem] px-3 py-2.5">
                          <div className="flex items-center gap-3">
                            <Avatar name={app.fullName} />
                            <div className="min-w-0">
                              <Link
                                to={`/admin/applications/${app.id}`}
                                onClick={() => saveReviewQueue({ ids: data.allIds, from: `/admin/applications${query ? `?${query}` : ''}` })}
                                className={cx('flex items-center gap-1.5 truncate text-slate-900 hover:text-brand-700', isNew ? 'font-semibold' : 'font-medium')}
                              >
                                {isNew && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500" title="Not reviewed yet" />}
                                <span className="truncate">{app.fullName}</span>
                              </Link>
                              <p className="truncate text-xs text-slate-500">
                                {app.email}
                                {app.location ? ` · ${app.location}` : ''}
                              </p>
                            </div>
                          </div>
                        </td>
                        {showJobColumn && <td className="max-w-[12rem] truncate px-3 py-2.5 text-slate-600">{jobTitles.get(app.jobId) ?? app.jobTitle}</td>}
                        <td className="px-3 py-2.5 whitespace-nowrap text-slate-700">{formatExperience(app.experienceRange, app.experienceYears)}</td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap text-slate-700 tabular-nums">{formatMoney(app.ctcAmount, app.ctcCurrency)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-slate-500" title={formatDateTime(app.submittedAt, timezone)}>
                          {timeAgo(app.submittedAt, timezone)}
                        </td>
                        <td className="px-3 py-2.5">
                          {/* A status pill that is also the control for changing it. */}
                          <select
                            aria-label={`Status of ${app.fullName}`}
                            className={cx('h-7 cursor-pointer rounded-full border-0 py-0 pr-7 pl-2.5 text-xs font-medium ring-1 ring-inset [--select-arrow-inset:0.4rem]', statusTone(app.status))}
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
                        <td className="px-3 py-2.5">
                          {/* The two decisions a recruiter makes most, one click each. */}
                          <div className="flex items-center justify-end gap-0.5 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:focus-within:opacity-100">
                            <IconButton icon="check" tone="success" label={`Shortlist ${app.fullName}`} disabled={app.status === 'Shortlisted'} onClick={() => changeStatus(app, 'Shortlisted')} />
                            <IconButton icon="close" tone="danger" label={`Reject ${app.fullName}`} disabled={app.status === 'Rejected'} onClick={() => changeStatus(app, 'Rejected')} />
                            <IconButton icon="download" label={`Download resume of ${app.fullName}`} busy={busy === `resume-${app.id}`} disabled={!app.resumeFileId} onClick={() => downloadResume(app)} />
                            {/^https:\/\/([a-z0-9-]+\.)*linkedin\.com\//i.test(app.linkedinUrl) && (
                              <a
                                href={app.linkedinUrl}
                                target="_blank"
                                rel="noreferrer noopener"
                                title={`Open LinkedIn profile of ${app.fullName}`}
                                aria-label={`Open LinkedIn profile of ${app.fullName}`}
                                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
                              >
                                <Icon name="link" />
                              </a>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
              <p className="tabular-nums">
                {firstRow}–{lastRow} of {total}
              </p>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-xs">
                  Rows
                  <select className={cx(selectClass, 'w-auto min-w-[4.5rem] py-1')} value={data.pageSize} onChange={(e) => update({ pageSize: e.target.value })}>
                    {PAGE_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="hidden text-xs tabular-nums sm:inline">
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
          </>
        )}
      </Card>

      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4" role="region" aria-label="Actions for selected candidates">
          <div className="flex max-w-full flex-wrap items-center gap-2 rounded-2xl bg-slate-900 py-2 pr-2 pl-4 text-white shadow-xl">
            <p className="mr-1 text-sm font-semibold tabular-nums">{selected.size} selected</p>
            <Button size="sm" variant="dark" icon="check" busy={busy === 'bulk-Shortlisted'} onClick={() => applyBulkStatus('Shortlisted')}>
              Shortlist
            </Button>
            <Button size="sm" variant="dark" icon="close" busy={busy === 'bulk-Rejected'} onClick={() => applyBulkStatus('Rejected')}>
              Reject
            </Button>
            <select
              aria-label="Move selected candidates to another status"
              className="select-arrow-light h-8 rounded-lg border-0 bg-white/10 py-0 pr-9 pl-2.5 text-[13px] font-medium text-white"
              value=""
              onChange={(e) => e.target.value && applyBulkStatus(e.target.value as ApplicationStatus)}
            >
              <option value="" className="text-slate-900">
                Move to…
              </option>
              {APPLICATION_STATUSES.map((status) => (
                <option key={status} value={status} className="text-slate-900">
                  {status}
                </option>
              ))}
            </select>
            <span className="mx-1 hidden h-5 w-px bg-white/20 sm:block" aria-hidden="true" />
            <Button
              size="sm"
              variant="dark"
              icon="download"
              busy={busy === 'zip-selected'}
              onClick={() => downloadZip({ ids: [...selected] }, `Resumes of ${plural(selected.size, 'selected candidate')}`, 'zip-selected')}
            >
              Resumes
            </Button>
            <Button size="sm" variant="dark" icon="file" busy={busy === 'export-selected'} onClick={() => exportCsv({ ids: [...selected] }, 'export-selected')}>
              CSV
            </Button>
            <IconButton icon="close" label="Clear selection" className="text-white/70 hover:bg-white/10 hover:text-white" onClick={() => setSelected(new Set())} />
          </div>
        </div>
      )}
    </div>
  );
}
