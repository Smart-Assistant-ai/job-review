import { Link } from 'react-router';
import { PublicShell } from '../components/PublicShell';
import { buttonClass } from '../components/ui';
import { useSite } from '../lib/useSite';

export function NotFoundPage() {
  const { companyName } = useSite();
  return (
    <PublicShell companyName={companyName} title="Page not found">
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <h1 className="text-xl font-semibold text-slate-900">Page not found</h1>
        <p className="mt-2 text-sm text-slate-600">The link may be incorrect or the page may have been removed.</p>
        <Link to="/" className={`${buttonClass('secondary')} mt-6`}>
          View open positions
        </Link>
      </div>
    </PublicShell>
  );
}
