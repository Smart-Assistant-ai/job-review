import { EXPERIENCE_RANGES, MAX_EXPERIENCE_YEARS_LABEL } from '../../shared/constants';

export function formatDateTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return iso || '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

export function formatDate(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return iso || '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

/** "₹18,00,000" for INR, "$60,000" for USD. Falls back to plain text for unknown currencies. */
export function formatMoney(amount: number | null, currency: string): string {
  if (amount === null) return '—';
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString()}`.trim();
  }
}

/** Indian salaries are usually quoted in lakhs per annum. */
export function lakhsLabel(amount: number, currency: string): string | null {
  if (currency !== 'INR' || amount < 100_000) return null;
  const lakhs = amount / 100_000;
  return `${Number.isInteger(lakhs) ? lakhs : lakhs.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} LPA`;
}

export function formatExperience(range: string, years: string): string {
  if (!years) return range || '—';
  if (years === MAX_EXPERIENCE_YEARS_LABEL) return '20+ years';
  return `${years} ${years === '1' ? 'year' : 'years'}`;
}

export const experienceOptions = EXPERIENCE_RANGES.map((r) => ({ value: r.key, label: r.label }));

/** "just now", "12m ago", "3h ago", "2d ago", then a plain date after a week. */
export function timeAgo(iso: string, timeZone?: string, now = Date.now()): string {
  const time = new Date(iso).getTime();
  if (!iso || Number.isNaN(time)) return iso || '—';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(iso, timeZone);
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
