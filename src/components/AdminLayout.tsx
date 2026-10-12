import { createContext, useContext, useEffect } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import type { SessionResponse } from '../../shared/types';
import { api, AUTH_EXPIRED_EVENT } from '../lib/api';
import { useApi } from '../lib/useApi';
import { DownloadsProvider } from './Downloads';
import { Alert, Button, buttonClass, cx, Icon, LogoMark, PageLoading, ToastProvider } from './ui';

const SessionContext = createContext<SessionResponse | null>(null);

export function useSession(): SessionResponse {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside AdminLayout');
  return session;
}

const NAV = [
  { to: '/admin', label: 'Dashboard', isActive: (path: string) => path === '/admin' || path.startsWith('/admin/jobs') },
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
    if (session) document.title = `Hiring – ${session.companyName}`;
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
      <ToastProvider>
        <DownloadsProvider>
          <div className="min-h-screen">
            <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
              <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-4 px-4 sm:gap-6 sm:px-6">
                <Link to="/admin" className="flex shrink-0 items-center gap-2.5">
                  <LogoMark name={session.companyName} />
                  <span className="hidden text-[15px] font-semibold tracking-tight text-slate-900 sm:inline">
                    {session.companyName}
                  </span>
                  <span className="hidden text-[15px] text-slate-400 md:inline">Hiring</span>
                </Link>
                <nav className="flex h-full items-stretch gap-1" aria-label="Admin">
                  {NAV.map((item) => {
                    const active = item.isActive(location.pathname);
                    return (
                      <Link
                        key={item.to}
                        to={item.to}
                        aria-current={active ? 'page' : undefined}
                        className={cx(
                          'flex items-center border-b-2 px-3 text-sm font-medium transition-colors',
                          active ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900',
                        )}
                      >
                        {item.label}
                      </Link>
                    );
                  })}
                </nav>
                <div className="ml-auto flex items-center gap-1.5">
                  <Link to="/admin/jobs/new" className={buttonClass('primary', 'sm')}>
                    <Icon name="plus" /> <span className="hidden sm:inline">New job</span>
                  </Link>
                  <Button size="sm" variant="ghost" icon="logout" onClick={signOut}>
                    <span className="hidden sm:inline">Sign out</span>
                  </Button>
                </div>
              </div>
            </header>
            {session.storage === 'local' && (
              <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900">
                Demo storage is on: data is kept in files on this server, not in Google Sheets or Drive.
              </div>
            )}
            <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
              <Outlet />
            </main>
          </div>
        </DownloadsProvider>
      </ToastProvider>
    </SessionContext.Provider>
  );
}
