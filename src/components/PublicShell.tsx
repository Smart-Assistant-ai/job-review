import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router';
import { cx, LogoMark } from './ui';

interface PublicShellProps {
  companyName: string;
  title?: string;
  /** Width of the header and footer, so they line up with a page that uses a narrower column. */
  width?: string;
  children: ReactNode;
}

/** Page frame for candidate-facing pages. */
export function PublicShell({ companyName, title, width = 'max-w-6xl', children }: PublicShellProps) {
  useEffect(() => {
    document.title = title ? `${title} – ${companyName}` : `Careers – ${companyName}`;
  }, [title, companyName]);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className={cx('mx-auto flex h-14 items-center px-4 sm:px-6', width)}>
          <Link to="/" className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-slate-900">
            <LogoMark name={companyName} />
            {companyName}
            <span className="font-normal text-slate-400">Careers</span>
          </Link>
        </div>
      </header>
      <div className="flex-1">{children}</div>
      <footer className="border-t border-slate-200 bg-white">
        <div className={cx('mx-auto px-4 py-4 text-xs text-slate-500 sm:px-6', width)}>
          © {new Date().getFullYear()} {companyName}. Your details are used only to assess your application.
        </div>
      </footer>
    </div>
  );
}
