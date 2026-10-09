import { Link } from 'react-router';
import type { PublicJobListItem } from '../../shared/types';
import { PublicShell } from '../components/PublicShell';
import { Alert, Card, Icon, PageLoading } from '../components/ui';
import { useApi } from '../lib/useApi';

export function HomePage() {
  const { data, error, loading } = useApi<{ companyName: string; jobs: PublicJobListItem[] }>('/api/public/jobs');

  return (
    <PublicShell companyName={data?.companyName ?? 'Careers'}>
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Open positions</h1>
        <p className="mt-1 text-sm text-slate-600">Choose a role to read the details and apply.</p>

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
                    <Card className="flex items-center justify-between gap-4 px-5 py-4 transition-colors group-hover:border-brand-300">
                      <div className="min-w-0">
                        <p className="font-medium text-slate-900">{job.title}</p>
                        {job.experienceCriteria && (
                          <p className="mt-0.5 text-sm text-slate-500">Experience: {job.experienceCriteria}</p>
                        )}
                      </div>
                      <span className="flex items-center gap-1 text-sm font-medium text-brand-700">
                        Apply <Icon name="right" />
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
