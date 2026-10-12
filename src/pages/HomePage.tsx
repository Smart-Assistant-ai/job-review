import { Link } from 'react-router';
import type { PublicJobListItem } from '../../shared/types';
import { PublicShell } from '../components/PublicShell';
import { Alert, Card, Icon, PageLoading } from '../components/ui';
import { useApi } from '../lib/useApi';

export function HomePage() {
  const { data, error, loading } = useApi<{ companyName: string; jobs: PublicJobListItem[] }>('/api/public/jobs');

  return (
    <PublicShell companyName={data?.companyName ?? 'Careers'}>
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <p className="text-sm font-medium text-brand-700">Join {data?.companyName ?? 'us'}</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900">Open positions</h1>
        <p className="mt-2 text-sm text-slate-600">Choose a role to read the details and apply. It takes about three minutes.</p>

        <div className="mt-6">
          {error ? (
            <Alert title="Open positions could not be loaded.">Please refresh the page in a moment.</Alert>
          ) : loading && !data ? (
            <PageLoading />
          ) : data && data.jobs.length > 0 ? (
            <ul className="space-y-3">
              {data.jobs.map((job) => (
                <li key={job.id}>
                  <Link to={`/apply/${job.id}`} className="group block">
                    <Card className="flex items-center gap-4 px-5 py-4 transition-all group-hover:border-brand-300 group-hover:shadow-md">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                        <Icon name="briefcase" className="h-5 w-5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold text-slate-900">{job.title}</p>
                        {job.experienceCriteria && <p className="mt-0.5 truncate text-sm text-slate-500">{job.experienceCriteria}</p>}
                      </div>
                      <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-brand-700">
                        Apply <Icon name="arrowRight" className="transition-transform group-hover:translate-x-0.5" />
                      </span>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Card className="px-5 py-10 text-center text-sm text-slate-600">
              There are no open positions right now. Please check back later.
            </Card>
          )}
        </div>
      </main>
    </PublicShell>
  );
}
