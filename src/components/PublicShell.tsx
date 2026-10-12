import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router';
import { LogoMark } from './ui';

/** Page frame for candidate-facing pages. */
export function PublicShell({ companyName, title, children }: { companyName: string; title?: string; children: ReactNode }) {
  useEffect(() => {
    document.title = title ? `${title} – ${companyName}` : `Careers – ${companyName}`;
  }, [title, companyName]);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-slate-900">
            <LogoMark name={companyName} />
            {companyName}
            <span className="font-normal text-slate-400">Careers</span>
          </Link>
        </div>
      </header>
      <div className="flex-1">{children}</div>
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-6xl px-4 py-4 text-xs text-slate-500 sm:px-6">
          © {new Date().getFullYear()} {companyName}. Your details are used only to assess your application.
        </div>
      </footer>
    </div>
  );
}
