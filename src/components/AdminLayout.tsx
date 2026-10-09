import { createContext, useContext, useEffect } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import type { SessionResponse } from '../../shared/types';
import { api, AUTH_EXPIRED_EVENT } from '../lib/api';
import { useApi } from '../lib/useApi';
import { DownloadsProvider } from './Downloads';
import { Alert, Button, cx, PageLoading } from './ui';

const SessionContext = createContext<SessionResponse | null>(null);

export function useSession(): SessionResponse {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside AdminLayout');
  return session;
}

const NAV = [
  { to: '/admin', label: 'Jobs', isActive: (path: string) => path === '/admin' || path.startsWith('/admin/jobs') },
  { to: '/admin/applications', label: 'Candidates', isActive: (path: string) => path.startsWith('/admin/applications') },
];

/**
 * Frame for all admin pages. It only decides what to show: the server checks
 * the session again on every admin request, so nothing here is a security boundary.
 */
export function AdminLayout() {
  const { data: session, error, loading, reload } = useApi<SessionResponse>('/api/admin/session');
  const navigate = useNavigate();
  const location = useLocation();
  const loginUrl = `/admin/login?next=${encodeURIComponent(location.pathname + location.search)}`;

  useEffect(() => {
    const onExpired = () => navigate(loginUrl, { replace: true });
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, [navigate, loginUrl]);

  useEffect(() => {
    if (session) document.title = `Recruitment – ${session.companyName}`;
  }, [session]);

  if (error && !session) {
    return (
      <div className="mx-auto max-w-md px-4 py-24">
        <Alert title="The admin area could not be loaded" action={<Button size="sm" onClick={reload}>Retry</Button>}>
          {error.message}
        </Alert>
      </div>
    );
  }
  if (loading && !session) return <PageLoading />;
  if (!session) return null;
  if (!session.authenticated) return <Navigate to={loginUrl} replace />;

  const signOut = async () => {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => undefined);
    navigate('/admin/login', { replace: true });
  };

  return (
    <SessionContext.Provider value={session}>
      <DownloadsProvider>
        <div className="min-h-screen">
          <header className="border-b border-slate-200 bg-white">
            <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6">
              <Link to="/admin" className="shrink-0 text-base font-semibold tracking-tight text-slate-900">
                {session.companyName}
                <span className="ml-2 hidden font-normal text-slate-500 sm:inline">Recruitment</span>
              </Link>
              <nav className="flex h-full items-stretch gap-1" aria-label="Admin">
                {NAV.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    aria-current={item.isActive(location.pathname) ? 'page' : undefined}
                    className={cx(
                      'flex items-center border-b-2 px-3 text-sm font-medium',
                      item.isActive(location.pathname) ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900',
                    )}
                  >
                    {item.label}
                  </NavLink>
                ))}
              </nav>
              <div className="ml-auto">
                <Button size="sm" variant="ghost" onClick={signOut}>
                  Sign out
                </Button>
              </div>
            </div>
          </header>
          {session.storage === 'local' && (
            <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-900">
              Demo storage is on: data is kept in files on this server, not in Google Sheets or Drive. Connect Google before real use.
            </div>
          )}
          <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
            <Outlet />
          </main>
        </div>
      </DownloadsProvider>
    </SessionContext.Provider>
  );
}
