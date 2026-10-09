import { useState } from 'react';
import { Link } from 'react-router';
import type { JobStatus } from '../../../shared/constants';
import type { JobSummaryDto, OverviewResponse } from '../../../shared/types';
import { useSession } from '../../components/AdminLayout';
import { CopyButton } from '../../components/CopyButton';
import { Alert, Button, buttonClass, Card, cx, Icon, PageLoading, StatusBadge, type IconName } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useApi } from '../../lib/useApi';

function Stat({ label, value, icon, to }: { label: string; value: number; icon: IconName; to?: string }) {
  const body = (
    <Card className={cx('flex items-center gap-4 p-4', to && 'transition-colors hover:border-brand-300')}>
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <div>
        <p className="text-2xl leading-tight font-semibold text-slate-900 tabular-nums">{value}</p>
        <p className="text-xs text-slate-500">{label}</p>
      </div>
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

export function OverviewPage() {
  const { timezone } = useSession();
  const { data, error, loading, reload } = useApi<OverviewResponse>('/api/admin/overview');
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const setStatus = async (job: JobSummaryDto, status: Extract<JobStatus, 'Published' | 'Closed'>) => {
    if (status === 'Closed' && !window.confirm(`Close "${job.title}"? Candidates will no longer be able to apply. You can reopen it later.`)) {
      return;
    }
    setBusyJob(job.id);
    setActionError(null);
    try {
      await api(`/api/admin/jobs/${job.id}/status`, { json: { status } });
      reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'The job could not be updated.');
    } finally {
      setBusyJob(null);
    }
  };

  if (error && !data) {
    return (
      <Alert title="Jobs could not be loaded" action={<Button size="sm" onClick={reload}>Retry</Button>}>
        {error.message}
      </Alert>
    );
  }
  if (loading && !data) return <PageLoading />;
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Jobs</h1>
        <Link to="/admin/jobs/new" className={buttonClass('primary')}>
          <Icon name="plus" /> New job
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Active jobs" value={data.totals.activeJobs} icon="briefcase" />
        <Stat label="Total applications" value={data.totals.applications} icon="users" to="/admin/applications" />
        <Stat label="New, not yet reviewed" value={data.totals.new} icon="file" to="/admin/applications?status=New" />
        <Stat label="Shortlisted" value={data.totals.shortlisted} icon="check" to="/admin/applications?status=Shortlisted" />
      </div>

      {actionError && <Alert>{actionError}</Alert>}

      {data.jobs.length === 0 ? (
        <Card className="px-6 py-14 text-center">
          <h2 className="text-base font-semibold text-slate-900">No jobs yet</h2>
          <p className="mt-1 text-sm text-slate-600">Create a job to get an application link you can paste into LinkedIn.</p>
          <Link to="/admin/jobs/new" className={cx(buttonClass('primary'), 'mt-5')}>
            <Icon name="plus" /> Create your first job
          </Link>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
              <tr>
                <th className="px-4 py-2.5">Job</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Applications</th>
                <th className="px-4 py-2.5 text-right">New</th>
                <th className="px-4 py-2.5 text-right">Shortlisted</th>
                <th className="px-4 py-2.5">Created</th>
                <th className="px-4 py-2.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.jobs.map((job) => (
                <tr key={job.id} className="hover:bg-slate-50/60">
                  <td className="max-w-xs px-4 py-3">
                    <Link to={`/admin/jobs/${job.id}/edit`} className="font-medium text-slate-900 hover:text-brand-700">
                      {job.title}
                    </Link>
                    {job.experienceCriteria && <p className="truncate text-xs text-slate-500">{job.experienceCriteria}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={job.status} />
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <Link to={`/admin/applications?job=${job.id}`} className="font-semibold text-brand-700 hover:underline" aria-label={`${job.counts.total} applications for ${job.title}`}>
                      {job.counts.total}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-right text-slate-700 tabular-nums">{job.counts.new}</td>
                  <td className="px-4 py-3 text-right text-slate-700 tabular-nums">{job.counts.shortlisted}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-slate-600">{formatDate(job.createdAt, timezone)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {job.status === 'Published' && <CopyButton text={job.applyUrl} />}
                      <Link to={`/admin/jobs/${job.id}/edit`} className={buttonClass('secondary', 'sm')}>
                        Edit
                      </Link>
                      {job.status === 'Published' ? (
                        <Button size="sm" variant="danger" busy={busyJob === job.id} onClick={() => setStatus(job, 'Closed')}>
                          Close
                        </Button>
                      ) : (
                        <Button size="sm" variant="primary" busy={busyJob === job.id} onClick={() => setStatus(job, 'Published')}>
                          {job.status === 'Closed' ? 'Reopen' : 'Publish'}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
