import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { useId } from 'react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---- Icons (inline so nothing is fetched from elsewhere) ----

const ICON_PATHS = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  download: 'M12 4v11m0 0l-4-4m4 4l4-4M5 19h14',
  external: 'M14 5h5v5m0-5l-8 8M10 6H6v12h12v-4',
  left: 'M14 6l-6 6 6 6',
  right: 'M10 6l6 6-6 6',
  up: 'M6 14l6-6 6 6',
  down: 'M6 10l6 6 6-6',
  close: 'M6 6l12 12M18 6L6 18',
  search: 'M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zm9 2l-4-4',
  upload: 'M12 16V5m0 0l-4 4m4-4l4 4M5 19h14',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  plus: 'M12 5v14M5 12h14',
  trash: 'M5 7h14M10 7V4h4v3m-7 0l1 13h8l1-13',
  alert: 'M12 8v5m0 3.5v.5M10.3 3.9L2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  briefcase: 'M4 8h16v11H4zM9 8V5h6v3M4 13h16',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm-6 9a6 6 0 0 1 12 0M16 4.5a3.5 3.5 0 0 1 0 6.5m2 9a6 6 0 0 0-3-5.2',
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cx('h-4 w-4 shrink-0', className)}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cx('h-4 w-4 animate-spin', className)}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ---- Buttons ----

const BUTTON_VARIANTS = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-300',
  secondary: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:text-slate-400',
  ghost: 'text-slate-600 hover:bg-slate-100 disabled:text-slate-400',
  danger: 'border border-red-200 bg-white text-red-700 hover:bg-red-50 disabled:text-red-300',
} as const;

const BUTTON_SIZES = {
  sm: 'h-8 gap-1.5 px-2.5 text-xs',
  md: 'h-10 gap-2 px-4 text-sm',
  lg: 'h-11 gap-2 px-5 text-sm',
} as const;

export const buttonClass = (
  variant: keyof typeof BUTTON_VARIANTS = 'secondary',
  size: keyof typeof BUTTON_SIZES = 'md',
) =>
  cx(
    'inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed',
    BUTTON_VARIANTS[variant],
    BUTTON_SIZES[size],
  );

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
  busy?: boolean;
  icon?: IconName;
}

export function Button({ variant, size, busy, icon, className, children, disabled, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={cx(buttonClass(variant, size), className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Spinner /> : icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

// ---- Form fields ----

export const inputClass = (invalid?: boolean) =>
  cx(
    'block w-full rounded-lg border bg-white px-3 py-2 text-slate-900 placeholder:text-slate-400 disabled:bg-slate-100',
    invalid ? 'border-red-400' : 'border-slate-300',
  );

interface FieldProps {
  label: ReactNode;
  error?: string;
  hint?: ReactNode;
  required?: boolean;
  className?: string;
  /** Receives the IDs to wire the control to its label, hint and error. */
  children: (control: { id: string; 'aria-invalid': boolean | undefined; 'aria-describedby': string | undefined }) => ReactNode;
}

/** A labelled control with its hint and its validation message directly underneath. */
export function Field({ label, error, hint, required, className, children }: FieldProps) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
        {required && (
          <span className="ml-0.5 text-red-600" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-slate-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1.5 flex items-start gap-1 text-xs font-medium text-red-700">
          <Icon name="alert" className="mt-px h-3.5 w-3.5" />
          {error}
        </p>
      )}
    </div>
  );
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(inputClass(rest['aria-invalid'] === true), className)} {...rest} />;
}

export function TextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(inputClass(rest['aria-invalid'] === true), 'min-h-24', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(inputClass(rest['aria-invalid'] === true), 'pr-8', className)} {...rest}>
      {children}
    </select>
  );
}

// ---- Feedback ----

const ALERT_TONES = {
  error: 'border-red-200 bg-red-50 text-red-800',
  warning: 'border-amber-200 bg-amber-50 text-amber-900',
  info: 'border-brand-200 bg-brand-50 text-brand-900',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
} as const;

export function Alert({
  tone = 'error',
  title,
  children,
  action,
  className,
}: {
  tone?: keyof typeof ALERT_TONES;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx('flex items-start gap-3 rounded-lg border px-4 py-3 text-sm', ALERT_TONES[tone], className)}
    >
      <Icon name={tone === 'success' ? 'check' : 'alert'} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? 'mt-0.5' : undefined}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('rounded-xl border border-slate-200 bg-white shadow-sm', className)}>{children}</div>;
}

const STATUS_STYLES: Record<string, string> = {
  New: 'bg-brand-50 text-brand-800 ring-brand-200',
  'Under Review': 'bg-amber-50 text-amber-800 ring-amber-200',
  Shortlisted: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  Rejected: 'bg-slate-100 text-slate-600 ring-slate-200',
  Hired: 'bg-violet-50 text-violet-800 ring-violet-200',
  Published: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  Draft: 'bg-slate-100 text-slate-600 ring-slate-200',
  Closed: 'bg-red-50 text-red-700 ring-red-200',
};

/** Colour classes for a job or application status. */
export const statusTone = (status: string) => STATUS_STYLES[status] ?? 'bg-slate-100 text-slate-700 ring-slate-200';

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
        statusTone(status),
      )}
    >
      {label ?? status}
    </span>
  );
}

export function PageLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-500" role="status">
      <Spinner /> {label}
    </div>
  );
}
