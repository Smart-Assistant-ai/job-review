import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { CURRENCIES, EXPERIENCE_RANGES, experienceRangeByKey, type Question } from '../../shared/constants';
import type { PublicJobResponse } from '../../shared/types';
import {
  formatFileSize,
  parseAmount,
  validateBasicDetails,
  validateProfessionalDetails,
  validateResumeChoice,
  type ApplicationFormValues,
  type FieldErrors,
} from '../../shared/validation';
import { PublicShell } from '../components/PublicShell';
import { RichText } from '../components/RichText';
import { Alert, Button, Card, cx, Field, Icon, PageLoading, Select, TextArea, TextInput, buttonClass } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { formatExperience, formatMoney, lakhsLabel } from '../lib/format';
import { useApi } from '../lib/useApi';
import { useSite } from '../lib/useSite';

const STEPS = ['Basic details', 'Professional details', 'Resume'] as const;
const BASIC_FIELDS = ['fullName', 'email', 'phone', 'location'];

/** Which step a server-reported field error belongs to. */
function stepForField(field: string): number {
  if (BASIC_FIELDS.includes(field)) return 0;
  return field === 'resume' ? 2 : 1;
}

function focusFirstError() {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  });
}

export function ApplyPage() {
  const { jobId = '' } = useParams();
  const { data, error, loading } = useApi<PublicJobResponse>(`/api/public/jobs/${encodeURIComponent(jobId)}`);
  const site = useSite();

  if (error?.status === 404) {
    return (
      <PublicShell companyName={site.companyName} title="Position not found">
        <Message title="This position could not be found">
          The link may be incorrect, or the position may have been removed.
        </Message>
      </PublicShell>
    );
  }
  if (error) {
    return (
      <PublicShell companyName={site.companyName}>
        <Message title="This page could not be loaded">{error.message} Please refresh the page in a moment.</Message>
      </PublicShell>
    );
  }
  if (loading || !data) {
    return (
      <PublicShell companyName={site.companyName}>
        <PageLoading />
      </PublicShell>
    );
  }

  return (
    <PublicShell companyName={data.companyName} title={data.job.title}>
      <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start lg:gap-8 lg:py-10">
        <JobSummary job={data.job} />
        <main className="mt-6 lg:mt-0">
          {data.form ? (
            // Keyed by job so navigating to another job starts a clean form.
            <ApplicationForm key={data.job.id} job={data.job} form={data.form} />
          ) : (
            <Card className="px-6 py-10 text-center">
              <h2 className="text-lg font-semibold text-slate-900">Applications are closed</h2>
              <p className="mt-2 text-sm text-slate-600">This position is no longer accepting applications.</p>
              <Link to="/" className={cx(buttonClass('secondary'), 'mt-6')}>
                View open positions
              </Link>
            </Card>
          )}
        </main>
      </div>
    </PublicShell>
  );
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
      <p className="mt-2 text-sm text-slate-600">{children}</p>
      <Link to="/" className={cx(buttonClass('secondary'), 'mt-6')}>
        View open positions
      </Link>
    </div>
  );
}

function JobSummary({ job }: { job: PublicJobResponse['job'] }) {
  const [expanded, setExpanded] = useState(false);
  const sections = [
    { heading: 'About the role', text: job.description },
    { heading: 'Responsibilities', text: job.responsibilities },
    { heading: 'Requirements', text: job.requirements },
  ].filter((s) => s.text.trim() !== '');

  return (
    <aside className="lg:sticky lg:top-6">
      <Card className="p-5 sm:p-6">
        <p className="text-xs font-semibold tracking-wide text-brand-700 uppercase">You are applying for</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">{job.title}</h1>
        {job.experienceCriteria && (
          <p className="mt-2 text-sm text-slate-600">
            <span className="font-medium text-slate-700">Experience:</span> {job.experienceCriteria}
          </p>
        )}

        {sections.length > 0 && (
          <>
            {/* On phones the description is collapsed so the form is reachable without scrolling far. */}
            <button
              type="button"
              className="mt-4 flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 lg:hidden"
              aria-expanded={expanded}
              aria-controls="job-details"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Hide job description' : 'View job description'}
              <Icon name={expanded ? 'up' : 'down'} />
            </button>
            <div id="job-details" className={cx('mt-5 space-y-5 lg:block', expanded ? 'block' : 'hidden')}>
              {sections.map((section) => (
                <section key={section.heading}>
                  <h2 className="mb-2 text-sm font-semibold text-slate-900">{section.heading}</h2>
                  <RichText text={section.text} />
                </section>
              ))}
            </div>
          </>
        )}
      </Card>
    </aside>
  );
}

function Stepper({ step, onBack }: { step: number; onBack: (target: number) => void }) {
  return (
    <div>
      <ol className="flex items-center">
        {STEPS.map((label, i) => {
          const done = i < step;
          const current = i === step;
          const marker = (
            <span
              className={cx(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
                done && 'bg-brand-600 text-white',
                current && 'bg-brand-600 text-white ring-4 ring-brand-100',
                !done && !current && 'bg-slate-100 text-slate-500',
              )}
            >
              {done ? <Icon name="check" /> : i + 1}
            </span>
          );
          return (
            <li key={label} className={cx('flex items-center', i < STEPS.length - 1 && 'flex-1')} aria-current={current ? 'step' : undefined}>
              {done ? (
                <button type="button" onClick={() => onBack(i)} className="flex items-center gap-2 rounded-full" aria-label={`Go back to ${label}`}>
                  {marker}
                  <span className="hidden text-sm font-medium text-slate-700 sm:inline">{label}</span>
                </button>
              ) : (
                <span className="flex items-center gap-2">
                  {marker}
                  <span className={cx('hidden text-sm font-medium sm:inline', current ? 'text-slate-900' : 'text-slate-500')}>{label}</span>
                </span>
              )}
              {i < STEPS.length - 1 && <span className={cx('mx-3 h-0.5 flex-1 rounded', done ? 'bg-brand-600' : 'bg-slate-200')} aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-sm text-slate-600 sm:hidden" aria-live="polite">
        Step {step + 1} of {STEPS.length}: <span className="font-medium text-slate-900">{STEPS[step]}</span>
      </p>
    </div>
  );
}

interface FormProps {
  job: PublicJobResponse['job'];
  form: NonNullable<PublicJobResponse['form']>;
}

function ApplicationForm({ job, form }: FormProps) {
  const [values, setValues] = useState<ApplicationFormValues>({
    fullName: '',
    email: '',
    phone: '',
    location: '',
    ctcCurrency: form.defaultCurrency,
    ctcAmount: '',
    experienceRange: '',
    experienceYears: '',
    linkedinUrl: '',
    answers: {},
  });
  const [file, setFile] = useState<File | null>(null);
  const [honeypot, setHoneypot] = useState('');
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [token, setToken] = useState(form.token);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Warn before the tab is closed with a partly completed form.
  useEffect(() => {
    if (!dirty || submittedId) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, submittedId]);

  const set = (field: keyof Omit<ApplicationFormValues, 'answers'>, value: string) => {
    setDirty(true);
    setValues((v) => ({ ...v, [field]: value }));
    setErrors(({ [field]: _removed, ...rest }) => rest);
  };
  const setAnswer = (questionId: string, value: string) => {
    setDirty(true);
    setValues((v) => ({ ...v, answers: { ...v.answers, [questionId]: value } }));
    setErrors(({ [`answers.${questionId}`]: _removed, ...rest }) => rest);
  };
  const chooseFile = (chosen: File | null) => {
    setDirty(true);
    setFile(chosen);
    const problem = chosen ? validateResumeChoice(chosen, form.maxResumeBytes) : null;
    setErrors(({ resume: _removed, ...rest }) => (problem ? { ...rest, resume: problem } : rest));
  };

  const goTo = (target: number) => {
    setStep(target);
    setSubmitError(null);
    requestAnimationFrame(() => {
      headingRef.current?.focus();
      headingRef.current?.scrollIntoView({ block: 'nearest' });
    });
  };

  const validateStep = (index: number): FieldErrors => {
    if (index === 0) return validateBasicDetails(values);
    if (index === 1) return validateProfessionalDetails(values, job.questions);
    const problem = validateResumeChoice(file, form.maxResumeBytes);
    return problem ? { resume: problem } : {};
  };

  const next = () => {
    const found = validateStep(step);
    setErrors(found);
    if (Object.keys(found).length > 0) return focusFirstError();
    goTo(step + 1);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (step < STEPS.length - 1) return next();
    if (submitting) return;

    // Re-check everything: earlier steps may have been edited since they were validated.
    const all = { ...validateStep(0), ...validateStep(1), ...validateStep(2) };
    if (Object.keys(all).length > 0) {
      setErrors(all);
      const firstStep = Math.min(...Object.keys(all).map(stepForField));
      if (firstStep !== step) goTo(firstStep);
      return focusFirstError();
    }

    const body = new FormData();
    const { answers, ...fields } = values;
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    body.set('answers', JSON.stringify(answers));
    body.set('formToken', token);
    body.set('website', honeypot);
    body.set('resume', file!, file!.name);

    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api<{ applicationId: string }>(`/api/public/jobs/${job.id}/applications`, { body });
      setSubmittedId(result.applicationId);
      window.scrollTo({ top: 0 });
    } catch (err) {
      const apiError = err instanceof ApiError ? err : null;
      if (apiError?.fieldErrors && Object.keys(apiError.fieldErrors).length > 0) {
        setErrors(apiError.fieldErrors);
        const firstStep = Math.min(...Object.keys(apiError.fieldErrors).map(stepForField));
        if (firstStep !== step) goTo(firstStep);
        focusFirstError();
        if (firstStep === step) setSubmitError(apiError.message);
      } else if (apiError?.code === 'form_expired') {
        // The page was open for a long time. Fetch a fresh token so the next attempt works.
        const fresh = await api<PublicJobResponse>(`/api/public/jobs/${job.id}`).catch(() => null);
        if (fresh?.form) {
          setToken(fresh.form.token);
          setSubmitError('This page had been open for a while, so we refreshed it. Please submit again in a few seconds.');
        } else {
          setSubmitError('This position is no longer accepting applications.');
        }
      } else {
        setSubmitError(apiError?.message ?? 'Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (submittedId) {
    return (
      <Card className="px-6 py-10 text-center sm:px-10">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          <Icon name="check" className="h-6 w-6" />
        </span>
        <h2 className="mt-4 text-xl font-semibold text-slate-900" role="status">
          Application submitted
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          Thank you, {values.fullName.trim().split(/\s+/)[0]}. We have received your application for{' '}
          <span className="font-medium text-slate-800">{job.title}</span> and will be in touch if there is a match.
        </p>
        <p className="mt-5 inline-block rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-700">
          Reference: <span className="font-mono font-semibold">{submittedId}</span>
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-5 sm:p-8">
      <Stepper step={step} onBack={goTo} />
      <form onSubmit={submit} noValidate className="mt-6">
        <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-slate-900 outline-none">
          {STEPS[step]}
        </h2>

        {/* Hidden from people; automated form-fillers tend to complete it. */}
        <div className="absolute -left-[9999px] h-0 w-0 overflow-hidden" aria-hidden="true">
          <label>
            Website
            <input type="text" name="website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
          </label>
        </div>

        <div className="mt-5 space-y-5">
          {step === 0 && <BasicStep values={values} errors={errors} set={set} />}
          {step === 1 && (
            <ProfessionalStep values={values} errors={errors} set={set} setAnswer={setAnswer} questions={job.questions} />
          )}
          {step === 2 && (
            <ResumeStep
              values={values}
              file={file}
              error={errors.resume}
              maxBytes={form.maxResumeBytes}
              onChoose={chooseFile}
              onEdit={goTo}
            />
          )}
        </div>

        {submitError && (
          <Alert className="mt-6" title="Your application was not submitted">
            {submitError}
          </Alert>
        )}

        <div className="mt-8 flex flex-col-reverse gap-3 border-t border-slate-200 pt-5 sm:flex-row sm:justify-between">
          {step > 0 ? (
            <Button variant="secondary" size="lg" icon="left" onClick={() => goTo(step - 1)} disabled={submitting}>
              Back
            </Button>
          ) : (
            <span />
          )}
          {step < STEPS.length - 1 ? (
            <Button type="submit" variant="primary" size="lg">
              Continue <Icon name="right" />
            </Button>
          ) : (
            <Button type="submit" variant="primary" size="lg" busy={submitting}>
              {submitting ? 'Submitting…' : 'Submit application'}
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}

interface StepProps {
  values: ApplicationFormValues;
  errors: FieldErrors;
  set: (field: keyof Omit<ApplicationFormValues, 'answers'>, value: string) => void;
}

function BasicStep({ values, errors, set }: StepProps) {
  return (
    <>
      <Field label="Full name" required error={errors.fullName}>
        {(control) => (
          <TextInput {...control} name="fullName" autoComplete="name" value={values.fullName} onChange={(e) => set('fullName', e.target.value)} maxLength={100} />
        )}
      </Field>
      <Field label="Email address" required error={errors.email}>
        {(control) => (
          <TextInput {...control} type="email" name="email" autoComplete="email" inputMode="email" value={values.email} onChange={(e) => set('email', e.target.value)} maxLength={254} />
        )}
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Phone number" required error={errors.phone}>
          {(control) => (
            <TextInput {...control} type="tel" name="phone" autoComplete="tel" inputMode="tel" value={values.phone} onChange={(e) => set('phone', e.target.value)} maxLength={25} />
          )}
        </Field>
        <Field label="Current city / location" required error={errors.location}>
          {(control) => (
            <TextInput {...control} name="location" autoComplete="address-level2" value={values.location} onChange={(e) => set('location', e.target.value)} maxLength={100} />
          )}
        </Field>
      </div>
    </>
  );
}

function ProfessionalStep({ values, errors, set, setAnswer, questions }: StepProps & { setAnswer: (id: string, value: string) => void; questions: Question[] }) {
  const range = experienceRangeByKey(values.experienceRange);
  const amount = parseAmount(values.ctcAmount);
  const lakhs = amount !== null ? lakhsLabel(amount, values.ctcCurrency) : null;

  return (
    <>
      <div className="grid gap-5 sm:grid-cols-[9rem_minmax(0,1fr)]">
        <Field label="Currency" required error={errors.ctcCurrency}>
          {(control) => (
            <Select {...control} name="ctcCurrency" value={values.ctcCurrency} onChange={(e) => set('ctcCurrency', e.target.value)}>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label={`Current annual CTC (${values.ctcCurrency})`}
          required
          error={errors.ctcAmount}
          hint={
            amount !== null && amount > 0 ? (
              <>
                {formatMoney(amount, values.ctcCurrency)} per year{lakhs ? ` (${lakhs})` : ''}
              </>
            ) : (
              'Enter the full yearly amount, for example 1200000. Enter 0 if not applicable.'
            )
          }
        >
          {(control) => (
            <TextInput {...control} name="ctcAmount" inputMode="decimal" autoComplete="off" value={values.ctcAmount} onChange={(e) => set('ctcAmount', e.target.value)} maxLength={20} />
          )}
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Total professional experience" required error={errors.experienceRange}>
          {(control) => (
            <Select
              {...control}
              name="experienceRange"
              value={values.experienceRange}
              onChange={(e) => {
                const nextRange = experienceRangeByKey(e.target.value);
                set('experienceRange', e.target.value);
                // Keep the exact year only if it is still a valid choice for the new range.
                if (!nextRange?.years.includes(values.experienceYears)) set('experienceYears', '');
              }}
            >
              <option value="">Select…</option>
              {EXPERIENCE_RANGES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {range && range.years.length > 0 && (
          <Field label="Exact completed years" required error={errors.experienceYears}>
            {(control) => (
              <Select {...control} name="experienceYears" value={values.experienceYears} onChange={(e) => set('experienceYears', e.target.value)}>
                <option value="">Select…</option>
                {range.years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>

      <Field label="LinkedIn profile URL" required error={errors.linkedinUrl} hint="For example linkedin.com/in/your-name">
        {(control) => (
          <TextInput {...control} name="linkedinUrl" inputMode="url" autoComplete="url" autoCapitalize="none" value={values.linkedinUrl} onChange={(e) => set('linkedinUrl', e.target.value)} maxLength={300} />
        )}
      </Field>

      {questions.length > 0 && (
        <div className="space-y-5 border-t border-slate-200 pt-5">
          {questions.map((question) => {
            const value = values.answers[question.id] ?? '';
            const error = errors[`answers.${question.id}`];
            return (
              <Field key={question.id} label={question.label} required={question.required} error={error}>
                {(control) =>
                  question.type === 'long_text' ? (
                    <TextArea {...control} rows={4} value={value} onChange={(e) => setAnswer(question.id, e.target.value)} maxLength={3000} />
                  ) : question.type === 'short_text' ? (
                    <TextInput {...control} value={value} onChange={(e) => setAnswer(question.id, e.target.value)} maxLength={300} />
                  ) : (
                    <Select {...control} value={value} onChange={(e) => setAnswer(question.id, e.target.value)}>
                      <option value="">Select…</option>
                      {(question.type === 'yes_no' ? ['Yes', 'No'] : question.options).map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </Select>
                  )
                }
              </Field>
            );
          })}
        </div>
      )}
    </>
  );
}

interface ResumeStepProps {
  values: ApplicationFormValues;
  file: File | null;
  error?: string;
  maxBytes: number;
  onChoose: (file: File | null) => void;
  onEdit: (step: number) => void;
}

function ResumeStep({ values, file, error, maxBytes, onChoose, onEdit }: ResumeStepProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const range = experienceRangeByKey(values.experienceRange);
  const amount = parseAmount(values.ctcAmount);

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    onChoose(event.dataTransfer.files[0] ?? null);
  };

  const groups = useMemo(
    () => [
      {
        step: 0,
        title: 'Basic details',
        items: [
          { label: 'Name', value: values.fullName },
          { label: 'Email', value: values.email },
          { label: 'Phone', value: values.phone },
          { label: 'Location', value: values.location },
        ],
      },
      {
        step: 1,
        title: 'Professional details',
        items: [
          { label: 'Experience', value: range ? formatExperience(range.label, values.experienceYears) : '' },
          { label: 'Current CTC', value: amount !== null ? `${formatMoney(amount, values.ctcCurrency)} per year` : '' },
        ],
      },
    ],
    [values, range, amount],
  );

  return (
    <>
      <div>
        <p className="mb-1.5 text-sm font-medium text-slate-700">
          Resume
          <span className="ml-0.5 text-red-600" aria-hidden="true">
            *
          </span>
        </p>
        <input
          ref={inputRef}
          id="resume-input"
          type="file"
          name="resume"
          className="sr-only"
          accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          aria-invalid={error ? true : undefined}
          aria-describedby="resume-help"
          onChange={(e) => {
            onChoose(e.target.files?.[0] ?? null);
            // Allow choosing the same file again after removing it.
            e.target.value = '';
          }}
        />
        {file ? (
          <div className={cx('flex items-center gap-3 rounded-lg border px-4 py-3', error ? 'border-red-300 bg-red-50' : 'border-slate-200 bg-slate-50')}>
            <Icon name="file" className="h-5 w-5 text-slate-500" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-slate-900">{file.name}</p>
              <p className="text-xs text-slate-500">{formatFileSize(file.size)}</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => inputRef.current?.click()}>
              Replace
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onChoose(null)} aria-label="Remove file">
              <Icon name="close" />
            </Button>
          </div>
        ) : (
          <label
            htmlFor="resume-input"
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cx(
              'flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors',
              dragging ? 'border-brand-500 bg-brand-50' : error ? 'border-red-300 bg-red-50' : 'border-slate-300 hover:border-brand-400 hover:bg-slate-50',
            )}
          >
            <Icon name="upload" className="h-6 w-6 text-slate-500" />
            <span className="text-sm font-medium text-brand-700">Choose a file</span>
            <span className="hidden text-xs text-slate-500 sm:inline">or drag and drop it here</span>
          </label>
        )}
        {error ? (
          <p id="resume-help" role="alert" className="mt-1.5 flex items-start gap-1 text-xs font-medium text-red-700">
            <Icon name="alert" className="mt-px h-3.5 w-3.5" />
            {error}
          </p>
        ) : (
          <p id="resume-help" className="mt-1.5 text-xs text-slate-500">
            PDF, DOC or DOCX, up to {formatFileSize(maxBytes)}.
          </p>
        )}
      </div>

      <div className="divide-y divide-slate-200 rounded-lg border border-slate-200">
        {groups.map((group) => (
          <section key={group.title} className="px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-slate-900">{group.title}</h3>
              <button type="button" className="text-xs font-medium text-brand-700 hover:underline" onClick={() => onEdit(group.step)}>
                Edit<span className="sr-only"> {group.title.toLowerCase()}</span>
              </button>
            </div>
            <dl className="mt-2 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {group.items.map((item) => (
                <div key={item.label} className="min-w-0">
                  <dt className="text-xs text-slate-500">{item.label}</dt>
                  <dd className="truncate text-slate-900">{item.value || '—'}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </>
  );
}
