import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { JobStatus } from '../../../shared/constants';
import { EMPTY_COUNTS, type JobCounts, type JobSummaryDto, type OverviewResponse } from '../../../shared/types';
import { useSession } from '../../components/AdminLayout';
import { CopyButton } from '../../components/CopyButton';
import {
  Alert,
  Avatar,
  Button,
  buttonClass,
  Card,
  cx,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  Skeleton,
  StatusBadge,
  statusSolid,
  useToast,
} from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { plural, timeAgo } from '../../lib/format';
import { saveReviewQueue } from '../../lib/reviewQueue';
import { useApi } from '../../lib/useApi';

/** Pipeline stages in the order a candidate moves through them. */
const STAGES: { key: Exclude<keyof JobCounts, 'total'>; status: string; label: string }[] = [
  { key: 'new', status: 'New', label: 'New' },
  { key: 'underReview', status: 'Under Review', label: 'In review' },
  { key: 'shortlisted', status: 'Shortlisted', label: 'Shortlisted' },
  { key: 'hired', status: 'Hired', label: 'Hired' },
  { key: 'rejected', status: 'Rejected', label: 'Rejected' },
];

function StageCard({ label, value, status, hint, emphasis }: { label: string; value: number; status: string; hint: string; emphasis?: boolean }) {
  return (
    <Link to={`/admin/applications?status=${encodeURIComponent(status)}`} className="group block">
      <Card
        className={cx(
          'h-full p-4 transition-colors group-hover:border-brand-300',
          emphasis && value > 0 && 'border-brand-200 bg-brand-50/60',
        )}
      >
        <div className="flex items-center gap-2 text-xs font-medium text-slate-600">
          <span className={cx('h-2 w-2 rounded-full', statusSolid(status))} aria-hidden="true" />
          {label}
        </div>
        <p className="mt-2 text-3xl leading-none font-semibold tracking-tight text-slate-900 tabular-nums">{value}</p>
        <p className={cx('mt-2 flex items-center gap-1 text-xs', emphasis && value > 0 ? 'font-medium text-brand-700' : 'text-slate-500')}>
          {hint}
          {emphasis && value > 0 && <Icon name="arrowRight" className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />}
        </p>
      </Card>
    </Link>
  );
}

/** A thin stacked bar showing how a job's applicants are spread across stages. */
function PipelineBar({ counts }: { counts: JobCounts }) {
  if (counts.total === 0) return <div className="h-1.5 rounded-full bg-slate-100" aria-hidden="true" />;
  return (
    <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
      {STAGES.filter((stage) => counts[stage.key] > 0).map((stage) => (
        <div key={stage.key} className={statusSolid(stage.status)} style={{ flexGrow: counts[stage.key], flexBasis: 0 }} />
      ))}
    </div>
  );
}

export function OverviewPage() {
  const { timezone } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useApi<OverviewResponse>('/api/admin/overview');
  const [busyJob, setBusyJob] = useState<string | null>(null);

  const setStatus = async (job: JobSummaryDto, status: Extract<JobStatus, 'Published' | 'Closed'>) => {
    if (status === 'Closed' && !window.confirm(`Close "${job.title}"? Candidates will no longer be able to apply. You can reopen it later.`)) {
      return;
    }
    setBusyJob(job.id);
    try {
      await api(`/api/admin/jobs/${job.id}/status`, { json: { status } });
      toast({ tone: 'success', text: status === 'Published' ? `"${job.title}" is open for applications` : `"${job.title}" is closed` });
      reload();
    } catch (err) {
      toast({ tone: 'error', text: err instanceof ApiError ? err.message : 'The job could not be updated.' });
    } finally {
      setBusyJob(null);
    }
  };

  if (error && !data) {
    return (
      <Alert title="The dashboard could not be loaded" action={<Button size="sm" onClick={reload}>Retry</Button>}>
        {error.message}
      </Alert>
    );
  }

  if (loading && !data) {
    return (
      <div className="space-y-6" role="status" aria-label="Loading">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }
  if (!data) return null;

  // Filled in with zeros so the page still works against a backend that predates these numbers.
  const totals = { ...EMPTY_COUNTS, ...data.totals };
  const jobs = data.jobs.map((job) => ({ ...job, counts: { ...EMPTY_COUNTS, ...job.counts } }));
  const recent = data.recent ?? [];
  const today = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Dashboard</h1>
        <p className="mt-1 text-sm text-slate-500">
          {today} · {plural(totals.activeJobs, 'open job')} · {plural(totals.total, 'applicant')} in total
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StageCard label="New" status="New" value={totals.new} emphasis hint={totals.new > 0 ? 'Waiting for your review' : 'Nothing waiting'} />
        <StageCard label="In review" status="Under Review" value={totals.underReview} hint="Being considered" />
        <StageCard label="Shortlisted" status="Shortlisted" value={totals.shortlisted} hint="Ready for next steps" />
        <StageCard label="Hired" status="Hired" value={totals.hired} hint="Offers accepted" />
        <StageCard label="Rejected" status="Rejected" value={totals.rejected} hint="Not moving forward" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] xl:items-start">
        <Card>
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">
              Jobs <span className="ml-1 font-normal text-slate-400">{jobs.length}</span>
            </h2>
            <div className="hidden items-center gap-3 text-[11px] text-slate-500 sm:flex">
              {STAGES.map((stage) => (
                <span key={stage.key} className="flex items-center gap-1.5">
                  <span className={cx('h-2 w-2 rounded-full', statusSolid(stage.status))} aria-hidden="true" />
                  {stage.label}
                </span>
              ))}
            </div>
          </div>

          {jobs.length === 0 ? (
            <EmptyState
              icon="briefcase"
              title="No jobs yet"
              action={
                <Link to="/admin/jobs/new" className={buttonClass('primary')}>
                  <Icon name="plus" /> Create your first job
                </Link>
              }
            >
              Create a job to get an application link you can paste into LinkedIn.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {jobs.map((job) => (
                <li
                  key={job.id}
                  // Fixed column widths keep every job's pipeline bar lined up with the others.
                  className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4 md:grid md:grid-cols-[minmax(0,1.4fr)_minmax(180px,260px)_150px]"
                >
                  <div className="min-w-0 flex-1 basis-56">
                    <div className="flex items-center gap-2">
                      <Link to={`/admin/applications?job=${job.id}`} className="truncate text-[15px] font-semibold text-slate-900 hover:text-brand-700">
                        {job.title}
                      </Link>
                      <StatusBadge status={job.status} label={job.status === 'Published' ? 'Open' : job.status} />
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-500">
                      Posted {timeAgo(job.createdAt, timezone)}
                      {job.experienceCriteria ? ` · ${job.experienceCriteria}` : ''}
                    </p>
                  </div>

                  <Link to={`/admin/applications?job=${job.id}`} className="group block w-full md:w-auto" aria-label={`${job.counts.total} applicants for ${job.title}`}>
                    <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
                      <span className="font-semibold text-slate-900 tabular-nums group-hover:text-brand-700">{plural(job.counts.total, 'applicant')}</span>
                      {job.counts.new > 0 && <span className="font-medium text-sky-700 tabular-nums">{job.counts.new} new</span>}
                    </div>
                    <PipelineBar counts={job.counts} />
                    <p className="mt-1.5 truncate text-[11px] text-slate-500 tabular-nums">
                      {job.counts.total === 0
                        ? 'No applications yet'
                        : STAGES.filter((s) => s.key !== 'new' && job.counts[s.key] > 0)
                            .map((s) => `${job.counts[s.key]} ${s.label.toLowerCase()}`)
                            .join(' · ') || 'None reviewed yet'}
                    </p>
                  </Link>

                  <div className="flex shrink-0 items-center justify-end gap-1.5">
                    {job.status === 'Published' && <CopyButton text={job.applyUrl} />}
                    {job.status === 'Draft' && (
                      <Button size="sm" variant="primary" busy={busyJob === job.id} onClick={() => setStatus(job, 'Published')}>
                        Publish
                      </Button>
                    )}
                    {job.status === 'Closed' && (
                      <Button size="sm" busy={busyJob === job.id} onClick={() => setStatus(job, 'Published')}>
                        Reopen
                      </Button>
                    )}
                    <Menu
                      button={(props) => <IconButton icon="dots" label={`More actions for ${job.title}`} {...props} />}
                      items={[
                        { label: 'View candidates', icon: 'users', onSelect: () => navigate(`/admin/applications?job=${job.id}`) },
                        { label: 'Edit job', icon: 'pencil', onSelect: () => navigate(`/admin/jobs/${job.id}/edit`) },
                        ...(job.status === 'Draft'
                          ? []
                          : [{ label: 'Open application page', icon: 'external' as const, onSelect: () => window.open(job.applyUrl, '_blank', 'noopener') }]),
                        ...(job.status === 'Published'
                          ? [{ label: 'Close applications', icon: 'close' as const, danger: true, onSelect: () => void setStatus(job, 'Closed') }]
                          : []),
                      ]}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
            <h2 className="text-sm font-semibold text-slate-900">Latest applications</h2>
            <Link to="/admin/applications" className="text-xs font-medium text-brand-700 hover:underline">
              View all
            </Link>
          </div>
          {recent.length === 0 ? (
            <EmptyState icon="inbox" title="No applications yet">
              They appear here the moment a candidate applies.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {recent.map((app) => (
                <li key={app.id}>
                  <Link
                    to={`/admin/applications/${app.id}`}
                    onClick={() => saveReviewQueue({ ids: recent.map((r) => r.id), from: '/admin/applications' })}
                    className="flex items-center gap-3 px-5 py-3 hover:bg-slate-50"
                  >
                    <Avatar name={app.fullName} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className={cx('truncate text-sm text-slate-900', app.status === 'New' ? 'font-semibold' : 'font-medium')}>{app.fullName}</p>
                      <p className="truncate text-xs text-slate-500">{app.jobTitle}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs text-slate-500">{timeAgo(app.submittedAt, timezone)}</p>
                      <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-slate-600">
                        <span className={cx('h-1.5 w-1.5 rounded-full', statusSolid(app.status))} aria-hidden="true" />
                        {app.status}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
