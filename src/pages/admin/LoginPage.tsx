import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import type { SessionResponse } from '../../../shared/types';
import { Alert, Button, Card, Field, PageLoading, TextInput } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';

/** Only ever send people back to a page inside the admin area. */
function safeNext(next: string | null): string {
  return next && /^\/admin(\/|\?|$)/.test(next) && !next.startsWith('/admin/login') ? next : '/admin';
}

export function LoginPage() {
  const { data: session, loading } = useApi<SessionResponse>('/api/admin/session');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = safeNext(params.get('next'));

  useEffect(() => {
    document.title = `Sign in – ${session?.companyName ?? 'Recruitment'}`;
  }, [session]);

  if (loading && !session) return <PageLoading />;
  if (session?.authenticated) return <Navigate to={next} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password) return setError('Enter the admin password.');
    setBusy(true);
    setError(null);
    try {
      await api('/api/admin/login', { json: { password } });
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed. Please try again.');
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <Card className="w-full max-w-sm p-6 sm:p-8">
        <h1 className="text-lg font-semibold text-slate-900">{session?.companyName ?? 'Recruitment'}</h1>
        <p className="mt-1 text-sm text-slate-600">Sign in to manage jobs and candidates.</p>

        {session?.loginProblem ? (
          <Alert tone="warning" className="mt-6" title="Sign-in is not set up yet">
            {session.loginProblem} Set it in the server environment and restart the app.
          </Alert>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-5" noValidate>
            <Field label="Admin password" error={error ?? undefined}>
              {(control) => (
                <TextInput
                  {...control}
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              )}
            </Field>
            <Button type="submit" variant="primary" className="w-full" busy={busy}>
              Sign in
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
