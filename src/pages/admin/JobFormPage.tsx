import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { LIMITS, QUESTION_TYPES, type JobStatus, type QuestionType } from '../../../shared/constants';
import { jobInputSchema, parseOptionsText, zodFieldErrors } from '../../../shared/job-schema';
import type { JobDetailResponse, JobDto } from '../../../shared/types';
import type { FieldErrors } from '../../../shared/validation';
import { CopyButton } from '../../components/CopyButton';
import { Alert, Button, Card, Field, Icon, PageLoading, Select, StatusBadge, TextArea, TextInput } from '../../components/ui';
import { api, ApiError, apiUrl } from '../../lib/api';
import { useApi } from '../../lib/useApi';

interface QuestionDraft {
  /** Stable key for React; also the saved question ID for existing questions. */
  key: string;
  id?: string;
  label: string;
  type: QuestionType;
  required: boolean;
  /** One option per line while editing; see parseOptionsText. */
  optionsText: string;
}

interface Draft {
  title: string;
  description: string;
  responsibilities: string;
  requirements: string;
  experienceCriteria: string;
  questions: QuestionDraft[];
}

const EMPTY: Draft = { title: '', description: '', responsibilities: '', requirements: '', experienceCriteria: '', questions: [] };

let draftKey = 0;
const newKey = () => `new-${++draftKey}`;

function toDraft(job: JobDto): Draft {
  return {
    title: job.title,
    description: job.description,
    responsibilities: job.responsibilities,
    requirements: job.requirements,
    experienceCriteria: job.experienceCriteria,
    questions: job.questions.map((q) => ({
      key: q.id,
      id: q.id,
      label: q.label,
      type: q.type,
      required: q.required,
      optionsText: q.options.join('\n'),
    })),
  };
}

function toPayload(draft: Draft) {
  return {
    ...draft,
    questions: draft.questions.map((q) => ({
      id: q.id,
      label: q.label,
      type: q.type,
      required: q.required,
      options: parseOptionsText(q.optionsText),
    })),
  };
}

/** Remounts the form whenever the job changes, so state never leaks between jobs. */
export function JobFormPage() {
  const { jobId } = useParams();
  return <JobForm key={jobId ?? 'new'} jobId={jobId} />;
}

function JobForm({ jobId }: { jobId: string | undefined }) {
  const editing = jobId !== undefined;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const loaded = useApi<JobDetailResponse>(editing ? `/api/admin/jobs/${jobId}` : null);
  const emailStatus = (loaded.data as Partial<JobDetailResponse> | undefined)?.confirmationEmail;

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState<'save' | 'publish' | 'status' | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const justCreated = params.has('created');
  const [dirty, setDirty] = useState(false);

  const job = loaded.data?.job;
  useEffect(() => {
    if (job) {
      setDraft(toDraft(job));
      setDirty(false);
    }
  }, [job]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Always derive from the latest state so quick successive edits never overwrite each other.
  const updateDraft = (fn: (current: Draft) => Draft) => {
    setDirty(true);
    setDraft(fn);
  };
  const change = (patch: Partial<Draft>) => updateDraft((d) => ({ ...d, ...patch }));
  const changeQuestion = (key: string, patch: Partial<QuestionDraft>) =>
    updateDraft((d) => ({ ...d, questions: d.questions.map((q) => (q.key === key ? { ...q, ...patch } : q)) }));
  const removeQuestion = (key: string) => updateDraft((d) => ({ ...d, questions: d.questions.filter((q) => q.key !== key) }));
  const addQuestion = () =>
    updateDraft((d) => ({
      ...d,
      questions: [...d.questions, { key: newKey(), label: '', type: 'short_text', required: false, optionsText: '' }],
    }));
  const moveQuestion = (index: number, delta: number) =>
    updateDraft((d) => {
      const questions = [...d.questions];
      const [moved] = questions.splice(index, 1);
      questions.splice(index + delta, 0, moved);
      return { ...d, questions };
    });

  const save = async (event: FormEvent | null, publish: boolean) => {
    event?.preventDefault();
    const payload = toPayload(draft);
    const check = jobInputSchema.safeParse(payload);
    if (!check.success) {
      setErrors(zodFieldErrors(check.error));
      setMessage({ tone: 'error', text: 'Some details need your attention. Check the highlighted fields.' });
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setErrors({});
    setMessage(null);
    setSaving(publish ? 'publish' : 'save');
    try {
      if (editing) {
        await api(`/api/admin/jobs/${jobId}`, { method: 'PUT', json: { job: payload } });
        setDirty(false);
        loaded.reload();
        setMessage({ tone: 'success', text: 'Changes saved.' });
      } else {
        const created = await api<{ job: JobDto }>('/api/admin/jobs', { json: { job: payload, publish } });
        setDirty(false);
        navigate(`/admin/jobs/${created.job.id}/edit?created=1`, { replace: true });
      }
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setErrors(err.fieldErrors);
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'The job could not be saved.' });
    } finally {
      setSaving(null);
    }
  };

  const setStatus = async (status: Extract<JobStatus, 'Published' | 'Closed'>) => {
    if (dirty && !window.confirm('You have unsaved changes that will not be included. Continue?')) return;
    setSaving('status');
    setMessage(null);
    try {
      await api(`/api/admin/jobs/${jobId}/status`, { json: { status } });
      if (params.has('created')) setParams({}, { replace: true });
      loaded.reload();
      setMessage({ tone: 'success', text: status === 'Published' ? 'The job is now open for applications.' : 'The job is closed to new applications.' });
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'The job could not be updated.' });
    } finally {
      setSaving(null);
    }
  };

  if (editing && loaded.error && !job) {
    return (
      <Alert title="This job could not be loaded" action={<Button size="sm" onClick={loaded.reload}>Retry</Button>}>
        {loaded.error.message}
      </Alert>
    );
  }
  if (editing && !job) return <PageLoading />;

  return (
    <div className="mx-auto max-w-5xl">
      <Link to="/admin" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
        <Icon name="left" /> Dashboard
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{editing ? job?.title || 'Edit job' : 'New job'}</h1>
        {job && <StatusBadge status={job.status} />}
      </div>

      {justCreated && job && !message && (
        <Alert
          tone="success"
          className="mt-4"
          title={job.status === 'Published' ? 'Job published' : 'Draft saved'}
          action={job.status === 'Published' && loaded.data ? <CopyButton text={loaded.data.applyUrl} /> : undefined}
        >
          {job.status === 'Published' && loaded.data ? (
            <>
              Candidates can now apply at <span className="font-mono text-xs break-all">{loaded.data.applyUrl}</span>
            </>
          ) : (
            'Publish it when you are ready to accept applications.'
          )}
        </Alert>
      )}
      {message && (
        <Alert tone={message.tone} className="mt-4">
          {message.text}
        </Alert>
      )}

      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
        <form onSubmit={(e) => save(e, false)} noValidate className="space-y-6">
          <Card className="space-y-5 p-5 sm:p-6">
            <Field label="Job title" required error={errors.title}>
              {(control) => <TextInput {...control} value={draft.title} onChange={(e) => change({ title: e.target.value })} maxLength={LIMITS.jobTitle} />}
            </Field>
            <Field label="Experience criteria" error={errors.experienceCriteria} hint="Shown to candidates, for example “5–8 years in backend engineering”.">
              {(control) => (
                <TextInput {...control} value={draft.experienceCriteria} onChange={(e) => change({ experienceCriteria: e.target.value })} maxLength={LIMITS.jobExperienceCriteria} />
              )}
            </Field>
            <Field label="Description" required error={errors.description} hint="Start a line with “-” to make a bullet point.">
              {(control) => <TextArea {...control} rows={6} value={draft.description} onChange={(e) => change({ description: e.target.value })} maxLength={LIMITS.jobLongText} />}
            </Field>
            <Field label="Responsibilities" error={errors.responsibilities}>
              {(control) => (
                <TextArea {...control} rows={5} value={draft.responsibilities} onChange={(e) => change({ responsibilities: e.target.value })} maxLength={LIMITS.jobLongText} />
              )}
            </Field>
            <Field label="Requirements" error={errors.requirements}>
              {(control) => <TextArea {...control} rows={5} value={draft.requirements} onChange={(e) => change({ requirements: e.target.value })} maxLength={LIMITS.jobLongText} />}
            </Field>
          </Card>

          <Card className="p-5 sm:p-6">
            <h2 className="text-base font-semibold text-slate-900">Application questions</h2>
            <p className="mt-1 text-sm text-slate-600">
              Every candidate is asked for contact details, current CTC, experience, LinkedIn profile and resume. Add anything else you need here.
            </p>
            {errors.questions && <Alert className="mt-4">{errors.questions}</Alert>}

            <ol className="mt-4 space-y-4">
              {draft.questions.map((question, index) => (
                <li key={question.key} className="rounded-lg border border-slate-200 bg-slate-50/60 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-500">Question {index + 1}</span>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => moveQuestion(index, -1)} aria-label={`Move question ${index + 1} up`}>
                        <Icon name="up" />
                      </Button>
                      <Button size="sm" variant="ghost" disabled={index === draft.questions.length - 1} onClick={() => moveQuestion(index, 1)} aria-label={`Move question ${index + 1} down`}>
                        <Icon name="down" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => removeQuestion(question.key)} aria-label={`Remove question ${index + 1}`}>
                        <Icon name="trash" className="text-red-600" />
                      </Button>
                    </div>
                  </div>
                  <div className="mt-2 grid gap-4 sm:grid-cols-[minmax(0,1fr)_11rem]">
                    <Field label="Question" required error={errors[`questions.${index}.label`]}>
                      {(control) => <TextInput {...control} value={question.label} onChange={(e) => changeQuestion(question.key, { label: e.target.value })} maxLength={LIMITS.questionLabel} />}
                    </Field>
                    <Field label="Answer type">
                      {(control) => (
                        <Select {...control} value={question.type} onChange={(e) => changeQuestion(question.key, { type: e.target.value as QuestionType })}>
                          {QUESTION_TYPES.map((t) => (
                            <option key={t.value} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                  </div>
                  {question.type === 'select' && (
                    <Field className="mt-4" label="Options" required error={errors[`questions.${index}.options`]} hint="One option per line, or separate them with commas.">
                      {(control) => <TextArea {...control} rows={3} value={question.optionsText} onChange={(e) => changeQuestion(question.key, { optionsText: e.target.value })} />}
                    </Field>
                  )}
                  <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" className="h-4 w-4 rounded border-slate-300 accent-brand-600" checked={question.required} onChange={(e) => changeQuestion(question.key, { required: e.target.checked })} />
                    Candidates must answer this
                  </label>
                </li>
              ))}
            </ol>

            <Button
              className="mt-4"
              icon="plus"
              disabled={draft.questions.length >= LIMITS.questionsPerJob}
              onClick={addQuestion}
            >
              Add question
            </Button>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            {editing ? (
              <Button type="submit" variant="primary" busy={saving === 'save'} disabled={saving !== null}>
                Save changes
              </Button>
            ) : (
              <>
                <Button variant="primary" busy={saving === 'publish'} disabled={saving !== null} onClick={() => save(null, true)}>
                  Publish job
                </Button>
                <Button type="submit" busy={saving === 'save'} disabled={saving !== null}>
                  Save as draft
                </Button>
              </>
            )}
            <Link to="/admin" className="text-sm text-slate-600 hover:text-slate-900">
              Cancel
            </Link>
          </div>
        </form>

        {job && loaded.data && (
          <aside className="order-first space-y-4 lg:sticky lg:top-6 lg:order-none">
            <Card className="p-5">
              <h2 className="text-sm font-semibold text-slate-900">Application link</h2>
              {job.status === 'Draft' ? (
                <p className="mt-2 text-sm text-slate-600">Publish this job to get its application link.</p>
              ) : (
                <>
                  <p className="mt-2 text-xs text-slate-500">Paste this into LinkedIn’s “apply on external website” field.</p>
                  <p className="mt-2 rounded-md bg-slate-100 px-2.5 py-2 font-mono text-xs break-all text-slate-800">{loaded.data.applyUrl}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <CopyButton text={loaded.data.applyUrl} />
                    <a href={loaded.data.applyUrl} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-slate-600 hover:bg-slate-100">
                      <Icon name="external" /> Open
                    </a>
                  </div>
                  {job.status === 'Closed' && <p className="mt-3 text-xs text-amber-700">The link currently shows that applications are closed.</p>}
                </>
              )}
            </Card>
            <Card className="p-5">
              <h2 className="text-sm font-semibold text-slate-900">Status</h2>
              <p className="mt-2 text-sm text-slate-600">
                {job.status === 'Published'
                  ? 'Open: candidates can apply.'
                  : job.status === 'Closed'
                    ? 'Closed: the form is hidden from candidates.'
                    : 'Draft: not visible to candidates.'}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {job.status === 'Published' ? (
                  <Button size="sm" variant="danger" busy={saving === 'status'} disabled={saving !== null} onClick={() => setStatus('Closed')}>
                    Close applications
                  </Button>
                ) : (
                  <Button size="sm" variant="primary" busy={saving === 'status'} disabled={saving !== null} onClick={() => setStatus('Published')}>
                    {job.status === 'Closed' ? 'Reopen job' : 'Publish job'}
                  </Button>
                )}
                <Link to={`/admin/applications?job=${job.id}`} className="inline-flex h-8 items-center rounded-lg px-2.5 text-xs font-medium text-brand-700 hover:bg-brand-50">
                  View candidates
                </Link>
              </div>
            </Card>
            {/* The site and the backend are deployed separately: an older backend does not report this yet. */}
            {emailStatus && (
              <Card className="p-5">
                <h2 className="text-sm font-semibold text-slate-900">Confirmation email</h2>
                <p className="mt-2 text-sm text-slate-600">
                  {emailStatus.on
                    ? 'On: candidates get an email as soon as they apply.'
                    : emailStatus.problem
                      ? `Off: ${emailStatus.problem}`
                      : 'Off: candidates are not emailed after applying.'}
                </p>
                <a
                  href={apiUrl(`/api/admin/jobs/${job.id}/email-preview`)}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 -ml-2.5 inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-brand-700 hover:bg-brand-50"
                >
                  <Icon name="external" /> Preview the email
                </a>
              </Card>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
