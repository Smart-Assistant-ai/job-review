import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { APPLICATION_STATUSES, LIMITS, type ApplicationStatus } from '../../../shared/constants';
import type { ApplicationDetailResponse, ApplicationDto } from '../../../shared/types';
import { formatFileSize, resumeExtension } from '../../../shared/validation';
import { useSession } from '../../components/AdminLayout';
import {
  Alert,
  Avatar,
  Button,
  Card,
  cx,
  Icon,
  IconButton,
  Kbd,
  Skeleton,
  Spinner,
  statusTone,
  TextArea,
  useToast,
  type IconName,
} from '../../components/ui';
import { api, ApiError, apiBlob, saveBlob } from '../../lib/api';
import { formatDateTime, formatExperience, formatMoney, lakhsLabel, timeAgo } from '../../lib/format';
import { loadReviewQueue } from '../../lib/reviewQueue';
import { useApi } from '../../lib/useApi';

const AUTO_ADVANCE_KEY = 'review-auto-advance';

/** True while the person is typing somewhere, so single-key shortcuts must stay out of the way. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

function Fact({ icon, label, children }: { icon: IconName; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
        <Icon name={icon} className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0">
        <dt className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">{label}</dt>
        <dd className="text-sm break-words text-slate-900">{children}</dd>
      </div>
    </div>
  );
}

export function ApplicationDetailPage() {
  const { id = '' } = useParams();
  const { timezone } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const { data, error, loading, reload, setData } = useApi<ApplicationDetailResponse>(`/api/admin/applications/${encodeURIComponent(id)}`);

  // The list this candidate was opened from, for "previous / next" in the same order.
  const queue = useMemo(() => loadReviewQueue(), []);
  const position = queue ? queue.ids.indexOf(id) : -1;
  const previousId = position > 0 ? queue!.ids[position - 1] : null;
  const nextId = queue && position !== -1 && position < queue.ids.length - 1 ? queue.ids[position + 1] : null;
  const backTo = queue?.from ?? '/admin/applications';

  const app = data?.application.id === id ? data.application : undefined;
  const [savingStatus, setSavingStatus] = useState(false);
  // "Decide and move on": remembered on this computer, off until the recruiter turns it on.
  const [autoAdvance, setAutoAdvance] = useState(() => {
    try {
      return localStorage.getItem(AUTO_ADVANCE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggleAutoAdvance = (on: boolean) => {
    setAutoAdvance(on);
    try {
      localStorage.setItem(AUTO_ADVANCE_KEY, on ? '1' : '0');
    } catch {
      // Not being able to remember the choice is harmless.
    }
  };

  const setStatus = useCallback(
    async (status: ApplicationStatus) => {
      if (!app || status === app.status || savingStatus) return;
      const previous = app.status;
      setSavingStatus(true);
      // Show the decision at once; put it back if the save fails.
      setData((d) => ({ ...d, application: { ...d.application, status } }));
      try {
        await api(`/api/admin/applications/${app.id}`, { method: 'PATCH', json: { status } });
        toast({ tone: 'success', text: `${app.fullName} moved to ${status}` });
        // After a yes/no decision, go straight to the next person if the recruiter asked for that.
        if (autoAdvance && nextId && (status === 'Shortlisted' || status === 'Rejected')) {
          navigate(`/admin/applications/${nextId}`);
        } else {
          reload();
        }
      } catch (err) {
        setData((d) => ({ ...d, application: { ...d.application, status: previous } }));
        toast({ tone: 'error', text: err instanceof ApiError ? err.message : 'The status could not be saved.' });
      } finally {
        setSavingStatus(false);
      }
    },
    [app, savingStatus, setData, toast, reload, autoAdvance, nextId, navigate],
  );

  // Keyboard shortcuts for working through a list without the mouse.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      if ((key === 'j' || key === 'arrowright') && nextId) navigate(`/admin/applications/${nextId}`);
      else if ((key === 'k' || key === 'arrowleft') && previousId) navigate(`/admin/applications/${previousId}`);
      else if (key === 's') void setStatus('Shortlisted');
      else if (key === 'r') void setStatus('Rejected');
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, nextId, previousId, setStatus]);

  const toolbar = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Link to={backTo} className="inline-flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900">
        <Icon name="left" /> Candidates
      </Link>
      {position !== -1 && queue && (
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="mr-2 flex cursor-pointer items-center gap-1.5 text-xs text-slate-600" title="After you shortlist or reject, open the next candidate automatically">
            <input type="checkbox" className="h-3.5 w-3.5 rounded border-slate-300 accent-brand-600" checked={autoAdvance} onChange={(e) => toggleAutoAdvance(e.target.checked)} />
            Next after decision
          </label>
          <span className="mr-1 text-xs text-slate-500 tabular-nums">
            {position + 1} of {queue.ids.length}
          </span>
          <Button size="sm" icon="left" disabled={!previousId} onClick={() => previousId && navigate(`/admin/applications/${previousId}`)}>
            Previous
          </Button>
          <Button size="sm" disabled={!nextId} onClick={() => nextId && navigate(`/admin/applications/${nextId}`)}>
            Next <Icon name="right" />
          </Button>
        </div>
      )}
    </div>
  );

  if (error && !app) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        {toolbar}
        <Alert
          title={error.status === 404 ? 'This application was not found' : 'This application could not be loaded'}
          action={error.status === 404 ? undefined : <Button size="sm" onClick={reload}>Retry</Button>}
        >
          {error.status === 404 ? 'It may have been removed from the spreadsheet.' : error.message}
        </Alert>
      </div>
    );
  }

  if (!app || !data) {
    return (
      <div className="space-y-4" role="status" aria-label="Loading candidate">
        {toolbar}
        <div className="grid gap-5 lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
          <div className="space-y-4">
            <Skeleton className="h-64 rounded-xl" />
            <Skeleton className="h-40 rounded-xl" />
          </div>
          <Skeleton className="h-[70vh] rounded-xl" />
        </div>
      </div>
    );
  }

  const { answers, activity, job } = data;
  const lakhs = app.ctcAmount !== null ? lakhsLabel(app.ctcAmount, app.ctcCurrency) : null;
  const knownStatus = (APPLICATION_STATUSES as readonly string[]).includes(app.status);
  const linkedinOk = /^https:\/\/([a-z0-9-]+\.)*linkedin\.com\//i.test(app.linkedinUrl);

  return (
    <div className={cx('space-y-4 transition-opacity', loading && data.application.id !== id && 'opacity-60')}>
      {toolbar}

      <div className="grid gap-5 lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)] lg:items-start">
        <div className="space-y-4">
          <Card className="p-5">
            <div className="flex items-start gap-3.5">
              <Avatar name={app.fullName} size="lg" />
              <div className="min-w-0 flex-1">
                <h1 className="text-lg leading-tight font-semibold tracking-tight break-words text-slate-900">{app.fullName}</h1>
                <p className="mt-0.5 text-sm text-slate-600">
                  <Link to={`/admin/applications?job=${app.jobId}`} className="font-medium text-brand-700 hover:underline">
                    {job?.title ?? app.jobTitle}
                  </Link>
                </p>
                <p className="mt-0.5 text-xs text-slate-500" title={formatDateTime(app.submittedAt, timezone)}>
                  Applied {timeAgo(app.submittedAt, timezone)}
                </p>
              </div>
            </div>

            {/* The decision, front and centre. */}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Button
                variant={app.status === 'Shortlisted' ? 'success' : 'successSoft'}
                icon="check"
                disabled={savingStatus}
                aria-pressed={app.status === 'Shortlisted'}
                onClick={() => setStatus('Shortlisted')}
              >
                {app.status === 'Shortlisted' ? 'Shortlisted' : 'Shortlist'}
              </Button>
              <Button
                variant={app.status === 'Rejected' ? 'danger' : 'dangerSoft'}
                icon="close"
                disabled={savingStatus}
                aria-pressed={app.status === 'Rejected'}
                onClick={() => setStatus('Rejected')}
              >
                {app.status === 'Rejected' ? 'Rejected' : 'Reject'}
              </Button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <label htmlFor="status-select" className="text-xs text-slate-500">
                Status
              </label>
              <select
                id="status-select"
                className={cx('h-7 flex-1 cursor-pointer rounded-full border-0 py-0 pr-7 pl-2.5 text-xs font-medium ring-1 ring-inset [--select-arrow-inset:0.4rem]', statusTone(app.status))}
                value={knownStatus ? app.status : ''}
                disabled={savingStatus}
                onChange={(e) => setStatus(e.target.value as ApplicationStatus)}
              >
                {!knownStatus && <option value="">{app.status}</option>}
                {APPLICATION_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>

            <dl className="mt-5 space-y-3.5 border-t border-slate-100 pt-5">
              <Fact icon="briefcase" label="Experience">
                {formatExperience(app.experienceRange, app.experienceYears)}
                {app.experienceYears && <span className="text-slate-500"> ({app.experienceRange})</span>}
              </Fact>
              <Fact icon="wallet" label="Current annual CTC">
                {formatMoney(app.ctcAmount, app.ctcCurrency)}
                {lakhs && <span className="text-slate-500"> ({lakhs})</span>}
              </Fact>
              <Fact icon="pin" label="Location">
                {app.location || '—'}
              </Fact>
              <Fact icon="mail" label="Email">
                <a href={`mailto:${app.email}`} className="text-brand-700 hover:underline">
                  {app.email}
                </a>
              </Fact>
              <Fact icon="phone" label="Phone">
                <a href={`tel:${app.phone.replace(/[^\d+]/g, '')}`} className="text-brand-700 hover:underline">
                  {app.phone}
                </a>
              </Fact>
              <Fact icon="link" label="LinkedIn">
                {linkedinOk ? (
                  <a href={app.linkedinUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-brand-700 hover:underline">
                    {app.linkedinUrl.replace(/^https:\/\/(www\.)?/, '')} <Icon name="external" className="h-3.5 w-3.5" />
                  </a>
                ) : (
                  app.linkedinUrl || '—'
                )}
              </Fact>
            </dl>
          </Card>

          {answers.length > 0 && (
            <Card className="p-5">
              <h2 className="text-sm font-semibold text-slate-900">Screening answers</h2>
              <dl className="mt-3 space-y-3.5">
                {answers.map((answer) => (
                  <div key={answer.questionId}>
                    <dt className="text-xs text-slate-500">{answer.question}</dt>
                    <dd className="mt-0.5 text-sm font-medium break-words whitespace-pre-line text-slate-900">{answer.answer}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}

          {/* Remounts when the saved notes change so the editor always starts from what is stored. */}
          <NotesEditor key={`${app.id}:${app.notes}`} app={app} onSaved={reload} />

          <Card className="p-5">
            <h2 className="text-sm font-semibold text-slate-900">Activity</h2>
            {activity.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">No activity recorded.</p>
            ) : (
              <ol className="mt-3 space-y-3">
                {activity.map((entry, index) => (
                  <li key={index} className="relative flex gap-3 text-sm">
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-slate-300 ring-4 ring-white" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="text-slate-900">
                        {entry.action}
                        {entry.detail && <span className="text-slate-600">: {entry.detail}</span>}
                      </p>
                      <p className="text-xs text-slate-500">
                        {formatDateTime(entry.timestamp, timezone)} · {entry.actor}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-4 border-t border-slate-100 pt-3 font-mono text-[11px] text-slate-400">{app.id}</p>
          </Card>

          <p className="hidden flex-wrap items-center gap-x-3 gap-y-1.5 px-1 text-xs text-slate-500 lg:flex">
            <span className="flex items-center gap-1">
              <Kbd>S</Kbd> shortlist
            </span>
            <span className="flex items-center gap-1">
              <Kbd>R</Kbd> reject
            </span>
            {queue && position !== -1 && (
              <span className="flex items-center gap-1">
                <Kbd>←</Kbd>
                <Kbd>→</Kbd> previous / next
              </span>
            )}
          </p>
        </div>

        <ResumePanel key={app.id} app={app} />
      </div>
    </div>
  );
}

function NotesEditor({ app, onSaved }: { app: ApplicationDto; onSaved: () => void }) {
  const toast = useToast();
  const [notes, setNotes] = useState(app.notes);
  const [saving, setSaving] = useState(false);
  const dirty = notes !== app.notes;

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await api(`/api/admin/applications/${app.id}`, { method: 'PATCH', json: { notes } });
      toast({ tone: 'success', text: 'Note saved' });
      onSaved();
    } catch (err) {
      toast({ tone: 'error', text: err instanceof ApiError ? err.message : 'The note could not be saved.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="notes" className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Icon name="note" className="text-slate-500" /> Internal notes
        </label>
        <span className="text-xs text-slate-500" aria-live="polite">
          {saving ? 'Saving…' : dirty ? 'Not saved yet' : app.notes ? 'Saved' : ''}
        </span>
      </div>
      <TextArea
        id="notes"
        className="mt-3"
        rows={4}
        placeholder="Your impressions, follow-ups, interview feedback…"
        value={notes}
        maxLength={LIMITS.notes}
        onChange={(e) => setNotes(e.target.value)}
        // Leaving the box saves, so a note is never lost by moving to the next candidate.
        onBlur={save}
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500">Only administrators see this. Saved when you click away.</p>
        <Button size="sm" variant="primary" busy={saving} disabled={!dirty} onClick={save}>
          Save
        </Button>
      </div>
    </Card>
  );
}

function ResumePanel({ app }: { app: ApplicationDto }) {
  const toast = useToast();
  const isPdf = resumeExtension(app.resumeFilename) === 'pdf';
  const [preview, setPreview] = useState<{ url: string } | { error: string } | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Fetch the PDF with the admin session and show it from memory. The file is
  // never given a public link and disappears from the browser when this page closes.
  useEffect(() => {
    if (!isPdf || !app.resumeFileId) return;
    let url: string | null = null;
    let cancelled = false;
    apiBlob(`/api/admin/applications/${app.id}/resume?inline=1`).then(
      ({ blob }) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
        setPreview({ url });
      },
      (err: unknown) => {
        if (!cancelled) setPreview({ error: err instanceof ApiError ? err.message : 'The resume could not be loaded.' });
      },
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [app.id, app.resumeFileId, isPdf]);

  const download = async () => {
    setDownloading(true);
    try {
      const { blob, filename } = await apiBlob(`/api/admin/applications/${app.id}/resume`);
      saveBlob(blob, filename ?? app.resumeFilename ?? 'resume');
    } catch (err) {
      toast({ tone: 'error', text: err instanceof ApiError ? err.message : 'The resume could not be downloaded.' });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Card className="flex flex-col overflow-hidden lg:sticky lg:top-[4.5rem] lg:h-[calc(100vh-5.75rem)]">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon name="file" className="h-5 w-5 text-slate-400" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-slate-900">{app.resumeFilename || 'Resume'}</h2>
            {app.resumeSize ? <p className="text-xs text-slate-500">{formatFileSize(app.resumeSize)}</p> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {preview && 'url' in preview && (
            <IconButton icon="external" label="Open resume in a new tab" onClick={() => window.open(preview.url, '_blank', 'noopener')} />
          )}
          <Button size="sm" icon="download" busy={downloading} disabled={!app.resumeFileId} onClick={download}>
            Download
          </Button>
        </div>
      </div>

      <div className="min-h-[60vh] flex-1 bg-slate-100 lg:min-h-0">
        {!app.resumeFileId ? (
          <Centered>No resume is on record for this application.</Centered>
        ) : !isPdf ? (
          <Centered>
            <span className="block font-medium text-slate-700">This is a Word document.</span>
            Word files cannot be shown here. Download it to read it.
          </Centered>
        ) : preview === null ? (
          <Centered>
            <span className="inline-flex items-center gap-2">
              <Spinner /> Loading resume…
            </span>
          </Centered>
        ) : 'error' in preview ? (
          <div className="p-4">
            <Alert title="Preview unavailable">{preview.error}</Alert>
          </div>
        ) : (
          <iframe src={preview.url} title={`Resume of ${app.fullName}`} className="h-full min-h-[60vh] w-full lg:min-h-0" />
        )}
      </div>
    </Card>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-[40vh] items-center justify-center px-6 text-center text-sm text-slate-500">{children}</div>;
}

