import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';

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
  mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
  phone: 'M6 3h3l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z',
  pin: 'M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
  calendar: 'M5 5h14v15H5zM5 10h14M9 3v4M15 3v4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  wallet: 'M4 7h16v11H4zM4 10h16M15 14h2',
  sliders: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  pencil: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  inbox: 'M4 13l2-8h12l2 8v6H4v-6zM4 13h5l1 2h4l1-2h5',
  star: 'M12 4l2.5 5.2 5.7.8-4.1 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4.1-4 5.7-.8L12 4z',
  note: 'M5 4h14v12l-4 4H5zM15 20v-4h4M8 9h8M8 13h5',
  logout: 'M10 5H5v14h5M14 8l4 4-4 4M18 12H9',
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'dots' ? 2.6 : 1.8}
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
  primary: 'bg-brand-600 text-white shadow-sm hover:bg-brand-700 disabled:bg-brand-300 disabled:shadow-none',
  secondary: 'border border-slate-300 bg-white text-slate-700 shadow-sm hover:bg-slate-50 disabled:text-slate-400 disabled:shadow-none',
  ghost: 'text-slate-600 hover:bg-slate-100 disabled:text-slate-400',
  danger: 'border border-rose-200 bg-white text-rose-700 shadow-sm hover:bg-rose-50 disabled:text-rose-300',
  success: 'bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 disabled:bg-emerald-300',
  successSoft: 'border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100',
  dangerSoft: 'border border-rose-200 bg-rose-50 text-rose-800 hover:bg-rose-100',
  dark: 'bg-white/10 text-white hover:bg-white/20 disabled:text-white/40',
} as const;

const BUTTON_SIZES = {
  sm: 'h-8 gap-1.5 px-2.5 text-[13px]',
  md: 'h-9 gap-2 px-3.5 text-sm',
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

/** A square button that shows only an icon. `label` is read by screen readers and shown on hover. */
export function IconButton({
  icon,
  label,
  tone = 'neutral',
  busy,
  className,
  ...rest
}: {
  icon: IconName;
  label: string;
  tone?: 'neutral' | 'success' | 'danger';
  busy?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>) {
  const tones = {
    neutral: 'text-slate-500 hover:bg-slate-100 hover:text-slate-900',
    success: 'text-slate-500 hover:bg-emerald-50 hover:text-emerald-700',
    danger: 'text-slate-500 hover:bg-rose-50 hover:text-rose-700',
  };
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={rest.disabled || busy}
      className={cx(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        tones[tone],
        className,
      )}
      {...rest}
    >
      {busy ? <Spinner /> : <Icon name={icon} />}
    </button>
  );
}

// ---- Form fields ----

export const inputClass = (invalid?: boolean) =>
  cx(
    'block w-full rounded-lg border bg-white px-3 py-2 text-slate-900 shadow-sm placeholder:text-slate-400 disabled:bg-slate-100',
    invalid ? 'border-rose-400' : 'border-slate-300',
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
          <span className="ml-0.5 text-rose-600" aria-hidden="true">
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
        <p id={`${id}-error`} role="alert" className="mt-1.5 flex items-start gap-1 text-xs font-medium text-rose-700">
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
  error: 'border-rose-200 bg-rose-50 text-rose-800',
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
      className={cx('flex items-start gap-3 rounded-xl border px-4 py-3 text-sm', ALERT_TONES[tone], className)}
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
  return (
    <div className={cx('rounded-xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.05)]', className)}>
      {children}
    </div>
  );
}

export function PageLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-500" role="status">
      <Spinner /> {label}
    </div>
  );
}

/** A grey placeholder shown where content is about to appear. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx('animate-pulse rounded-md bg-slate-200/70', className)} />;
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-500">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <h2 className="mt-3 text-sm font-semibold text-slate-900">{title}</h2>
      {children && <p className="mt-1 max-w-sm text-sm text-slate-500">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** A keyboard key, for shortcut hints. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-slate-300 bg-white px-1 font-sans text-[11px] font-medium text-slate-600 shadow-[0_1px_0_rgba(15,23,42,0.08)]">
      {children}
    </kbd>
  );
}

// ---- Statuses: one colour per stage, used everywhere a status appears ----

interface StatusStyle {
  /** Pill background, text and outline. */
  pill: string;
  /** Solid colour for dots and pipeline bars. */
  solid: string;
}

const STATUS_STYLES: Record<string, StatusStyle> = {
  New: { pill: 'bg-sky-50 text-sky-800 ring-sky-200', solid: 'bg-sky-500' },
  'Under Review': { pill: 'bg-amber-50 text-amber-800 ring-amber-200', solid: 'bg-amber-400' },
  Shortlisted: { pill: 'bg-emerald-50 text-emerald-800 ring-emerald-200', solid: 'bg-emerald-500' },
  Rejected: { pill: 'bg-rose-50 text-rose-700 ring-rose-200', solid: 'bg-rose-400' },
  Hired: { pill: 'bg-violet-50 text-violet-800 ring-violet-200', solid: 'bg-violet-500' },
  Published: { pill: 'bg-emerald-50 text-emerald-800 ring-emerald-200', solid: 'bg-emerald-500' },
  Draft: { pill: 'bg-slate-100 text-slate-600 ring-slate-200', solid: 'bg-slate-400' },
  Closed: { pill: 'bg-slate-100 text-slate-600 ring-slate-300', solid: 'bg-slate-400' },
};
const FALLBACK_STATUS: StatusStyle = { pill: 'bg-slate-100 text-slate-700 ring-slate-200', solid: 'bg-slate-400' };

/** Pill colour classes for a job or application status. */
export const statusTone = (status: string) => (STATUS_STYLES[status] ?? FALLBACK_STATUS).pill;
/** Solid colour class for a status, for dots and bars. */
export const statusSolid = (status: string) => (STATUS_STYLES[status] ?? FALLBACK_STATUS).solid;

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
        statusTone(status),
      )}
    >
      <span className={cx('h-1.5 w-1.5 rounded-full', statusSolid(status))} aria-hidden="true" />
      {label ?? status}
    </span>
  );
}

// ---- People ----

const AVATAR_TONES = [
  'bg-sky-100 text-sky-800',
  'bg-emerald-100 text-emerald-800',
  'bg-amber-100 text-amber-800',
  'bg-violet-100 text-violet-800',
  'bg-rose-100 text-rose-800',
  'bg-teal-100 text-teal-800',
  'bg-indigo-100 text-indigo-800',
  'bg-orange-100 text-orange-800',
];

/** Initials on a soft colour that stays the same for the same name. */
export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = ((words[0]?.[0] ?? '?') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const sizes = { sm: 'h-7 w-7 text-[11px]', md: 'h-9 w-9 text-xs', lg: 'h-12 w-12 text-base' };
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold select-none',
        sizes[size],
        AVATAR_TONES[hash % AVATAR_TONES.length],
      )}
    >
      {initials}
    </span>
  );
}

/** The company's initial on the brand colour, standing in for a logo. */
export function LogoMark({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white"
    >
      {(name.trim()[0] ?? 'C').toUpperCase()}
    </span>
  );
}

// ---- Tabs with counts ----

export interface TabItem {
  value: string;
  label: string;
  count?: number;
  /** Colour dot shown before the label. */
  dot?: string;
}

export function Tabs({
  items,
  value,
  onChange,
  label,
}: {
  items: TabItem[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="-mb-px flex gap-1 overflow-x-auto">
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={cx(
              'flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors',
              active ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900',
            )}
          >
            {item.dot && <span className={cx('h-2 w-2 rounded-full', item.dot)} aria-hidden="true" />}
            {item.label}
            {item.count !== undefined && (
              <span
                className={cx(
                  'rounded-full px-1.5 py-0.5 text-[11px] leading-none font-semibold tabular-nums',
                  active ? 'bg-brand-100 text-brand-800' : 'bg-slate-100 text-slate-600',
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---- Dropdown menu ----

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  disabled?: boolean;
  /** Explains a disabled item. */
  hint?: string;
  danger?: boolean;
}

export function Menu({
  button,
  items,
  align = 'right',
}: {
  /** Renders the control that opens the menu. */
  button: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode;
  items: MenuItem[];
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      {button({ onClick: () => setOpen((v) => !v), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {open && (
        <div
          role="menu"
          className={cx(
            'absolute z-40 mt-1.5 min-w-56 rounded-xl border border-slate-200 bg-white p-1 shadow-lg',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.disabled ? item.hint : undefined}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cx(
                'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-45',
                item.danger ? 'text-rose-700 hover:bg-rose-50' : 'text-slate-700 hover:bg-slate-100',
              )}
            >
              {item.icon && <Icon name={item.icon} className={item.danger ? undefined : 'text-slate-500'} />}
              <span className="min-w-0 flex-1">
                {item.label}
                {item.disabled && item.hint && <span className="block text-xs text-slate-500">{item.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Toasts: brief confirmations that do not push the page around ----

interface Toast {
  id: number;
  tone: 'success' | 'error';
  text: string;
}

const ToastContext = createContext<((toast: Omit<Toast, 'id'>) => void) | null>(null);

export function useToast(): (toast: Omit<Toast, 'id'>) => void {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside ToastProvider');
  return value;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = nextId.current++;
    setToasts((current) => [...current.slice(-2), { ...toast, id }]);
    // Errors stay longer so they can be read.
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), toast.tone === 'error' ? 7000 : 3200);
  }, []);
  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-16 z-50 flex flex-col items-center gap-2 px-4" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className={cx(
              'pointer-events-auto flex max-w-md items-center gap-2.5 rounded-xl px-4 py-2.5 text-sm font-medium text-white shadow-lg',
              toast.tone === 'error' ? 'bg-rose-600' : 'bg-slate-900',
            )}
          >
            <Icon name={toast.tone === 'error' ? 'alert' : 'check'} className={toast.tone === 'error' ? undefined : 'text-emerald-400'} />
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
