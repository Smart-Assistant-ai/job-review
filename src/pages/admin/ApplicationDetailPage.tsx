import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { APPLICATION_STATUSES, LIMITS, type ApplicationStatus } from '../../../shared/constants';
import type { ApplicationDetailResponse, ApplicationDto } from '../../../shared/types';
import { formatFileSize, resumeExtension } from '../../../shared/validation';
import { useSession } from '../../components/AdminLayout';
import { Alert, Button, Card, Field, Icon, PageLoading, Select, Spinner, StatusBadge, TextArea } from '../../components/ui';
import { api, ApiError, apiBlob, saveBlob } from '../../lib/api';
import { formatDateTime, formatExperience, formatMoney, lakhsLabel } from '../../lib/format';
import { useApi } from '../../lib/useApi';

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm break-words text-slate-900">{children}</dd>
    </div>
  );
}

export function ApplicationDetailPage() {
  const { id = '' } = useParams();
  const { timezone } = useSession();
  const location = useLocation();
  const backTo = (location.state as { from?: string } | null)?.from ?? '/admin/applications';
  const { data, error, loading, reload } = useApi<ApplicationDetailResponse>(`/api/admin/applications/${encodeURIComponent(id)}`);

  if (error && !data) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <BackLink to={backTo} />
        <Alert title={error.status === 404 ? 'This application was not found' : 'This application could not be loaded'} action={error.status === 404 ? undefined : <Button size="sm" onClick={reload}>Retry</Button>}>
          {error.status === 404 ? 'It may have been removed from the spreadsheet.' : error.message}
        </Alert>
      </div>
    );
  }
  if (loading && !data) return <PageLoading />;
  if (!data) return null;

  const { application: app, answers, activity, job } = data;
  const lakhs = app.ctcAmount !== null ? lakhsLabel(app.ctcAmount, app.ctcCurrency) : null;

  return (
    <div className="space-y-5">
      <BackLink to={backTo} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight break-words text-slate-900">{app.fullName}</h1>
          <p className="mt-1 text-sm text-slate-600">
            Applied for{' '}
            <Link to={`/admin/applications?job=${app.jobId}`} className="font-medium text-brand-700 hover:underline">
              {job?.title ?? app.jobTitle}
            </Link>{' '}
            on {formatDateTime(app.submittedAt, timezone)}
          </p>
        </div>
        <StatusBadge status={app.status} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
        <div className="space-y-5">
          <Card className="p-5">
            <h2 className="text-sm font-semibold text-slate-900">Candidate details</h2>
            <dl className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <Detail label="Email">
                <a href={`mailto:${app.email}`} className="text-brand-700 hover:underline">
                  {app.email}
                </a>
              </Detail>
              <Detail label="Phone">
                <a href={`tel:${app.phone.replace(/[^\d+]/g, '')}`} className="text-brand-700 hover:underline">
                  {app.phone}
                </a>
              </Detail>
              <Detail label="Current location">{app.location || '—'}</Detail>
              <Detail label="Total experience">
                {formatExperience(app.experienceRange, app.experienceYears)}
                {app.experienceYears && <span className="text-slate-500"> ({app.experienceRange})</span>}
              </Detail>
              <Detail label="Current annual CTC">
                {formatMoney(app.ctcAmount, app.ctcCurrency)}
                {lakhs && <span className="text-slate-500"> ({lakhs})</span>}
              </Detail>
              <Detail label="LinkedIn">
                {/^https:\/\/([a-z0-9-]+\.)*linkedin\.com\//i.test(app.linkedinUrl) ? (
                  <a href={app.linkedinUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-brand-700 hover:underline">
                    {app.linkedinUrl.replace(/^https:\/\/(www\.)?/, '')} <Icon name="external" className="h-3.5 w-3.5" />
                  </a>
                ) : (
                  app.linkedinUrl || '—'
                )}
              </Detail>
              <Detail label="Application ID">
                <span className="font-mono text-xs">{app.id}</span>
              </Detail>
            </dl>
          </Card>

          {answers.length > 0 && (
            <Card className="p-5">
              <h2 className="text-sm font-semibold text-slate-900">Application answers</h2>
              <dl className="mt-4 space-y-4">
                {answers.map((answer) => (
                  <div key={answer.questionId}>
                    <dt className="text-xs text-slate-500">{answer.question}</dt>
                    <dd className="mt-0.5 text-sm break-words whitespace-pre-line text-slate-900">{answer.answer}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}

          {/* Remounts when the saved values change so the editor always starts from what is stored. */}
          <ReviewEditor key={`${app.id}:${app.updatedAt}`} app={app} onSaved={reload} />

          <Card className="p-5">
            <h2 className="text-sm font-semibold text-slate-900">Activity</h2>
            {activity.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">No activity recorded.</p>
            ) : (
              <ol className="mt-3 space-y-3">
                {activity.map((entry, index) => (
                  <li key={index} className="flex gap-3 text-sm">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" aria-hidden="true" />
                    <div>
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
          </Card>
        </div>

        <ResumePanel app={app} />
      </div>
    </div>
  );
}

function BackLink({ to }: { to: string }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
      <Icon name="left" /> Back to candidates
    </Link>
  );
}

function ReviewEditor({ app, onSaved }: { app: ApplicationDto; onSaved: () => void }) {
  const known = (APPLICATION_STATUSES as readonly string[]).includes(app.status);
  const [status, setStatus] = useState(app.status);
  const [notes, setNotes] = useState(app.notes);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const dirty = status !== app.status || notes !== app.notes;

  const save = async () => {
    setSaving(true);
    setResult(null);
    try {
      await api(`/api/admin/applications/${app.id}`, {
        method: 'PATCH',
        json: { notes, ...(status !== app.status ? { status: status as ApplicationStatus } : {}) },
      });
      setResult({ tone: 'success', text: 'Saved.' });
      onSaved();
    } catch (err) {
      setResult({ tone: 'error', text: err instanceof ApiError ? err.message : 'Your changes could not be saved.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="space-y-4 p-5">
      <h2 className="text-sm font-semibold text-slate-900">Review</h2>
      <Field label="Status">
        {(control) => (
          <Select {...control} className="sm:max-w-xs" value={status} onChange={(e) => setStatus(e.target.value)}>
            {!known && <option value={app.status}>{app.status}</option>}
            {APPLICATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Internal notes" hint="Visible to administrators only. Never shown to the candidate.">
        {(control) => <TextArea {...control} rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={LIMITS.notes} />}
      </Field>
      <div className="flex items-center gap-3">
        <Button variant="primary" busy={saving} disabled={!dirty} onClick={save}>
          Save
        </Button>
        <span aria-live="polite" className={result?.tone === 'error' ? 'text-sm text-red-700' : 'text-sm text-emerald-700'}>
          {result?.text ?? (dirty ? <span className="text-slate-500">Unsaved changes</span> : null)}
        </span>
      </div>
    </Card>
  );
}

function ResumePanel({ app }: { app: ApplicationDto }) {
  const isPdf = resumeExtension(app.resumeFilename) === 'pdf';
  const [preview, setPreview] = useState<{ url: string } | { error: string } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Fetch the PDF with the admin session and show it from memory. The file is
  // never given a public link and disappears from the browser when this page closes.
  useEffect(() => {
    if (!isPdf || !app.resumeFileId) return;
    let url: string | null = null;
    let cancelled = false;
    setPreview(null);
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
    setDownloadError(null);
    try {
      const { blob, filename } = await apiBlob(`/api/admin/applications/${app.id}/resume`);
      saveBlob(blob, filename ?? app.resumeFilename ?? 'resume');
    } catch (err) {
      setDownloadError(err instanceof ApiError ? err.message : 'The resume could not be downloaded.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Card className="overflow-hidden lg:sticky lg:top-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">Resume</h2>
          <p className="truncate text-xs text-slate-500">
            {app.resumeFilename || 'No file on record'}
            {app.resumeSize ? ` · ${formatFileSize(app.resumeSize)}` : ''}
          </p>
        </div>
        <Button icon="download" busy={downloading} disabled={!app.resumeFileId} onClick={download}>
          Download
        </Button>
      </div>
      {downloadError && <Alert className="m-4">{downloadError}</Alert>}
      {!app.resumeFileId ? (
        <p className="px-5 py-10 text-center text-sm text-slate-500">No resume is on record for this application.</p>
      ) : !isPdf ? (
        <p className="px-5 py-10 text-center text-sm text-slate-600">
          Word documents cannot be previewed here. Download the file to open it.
        </p>
      ) : preview === null ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-500" role="status">
          <Spinner /> Loading preview…
        </div>
      ) : 'error' in preview ? (
        <Alert className="m-4" title="Preview unavailable">
          {preview.error}
        </Alert>
      ) : (
        <iframe src={preview.url} title={`Resume of ${app.fullName}`} className="h-[75vh] w-full bg-slate-100" />
      )}
    </Card>
  );
}
