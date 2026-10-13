import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { CURRENCIES, EXPERIENCE_RANGES, experienceRangeByKey, type Question } from '../../shared/constants';
import type { PublicJobResponse, SubmitApplicationResponse } from '../../shared/types';
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
import { Alert, Button, Card, ChoiceGroup, cx, Field, Icon, PageLoading, Select, TextArea, TextInput, buttonClass, type IconName } from '../components/ui';
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
    <PublicShell companyName={data.companyName} title={data.job.title} width={COLUMN}>
      <JobHero job={data.job} companyName={data.companyName} />
      <div className={cx(COLUMN, 'mx-auto py-3 md:px-6 md:py-6 lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start lg:gap-8 lg:py-8')}>
        <JobSummary job={data.job} />
        <main className="mt-3 md:mt-6 lg:mt-0">
          {data.form ? (
            // Keyed by job so navigating to another job starts a clean form.
            <ApplicationForm key={data.job.id} job={data.job} form={data.form} companyName={data.companyName} />
          ) : (
            <Card className={cx(SHEET, 'px-6 py-12 text-center')}>
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                <Icon name="clock" className="h-6 w-6" />
              </span>
              <h2 className="mt-4 text-lg font-semibold text-slate-900">Applications are closed</h2>
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

/** One comfortable column for reading and typing, until the screen has room for two. */
const COLUMN = 'max-w-3xl lg:max-w-6xl';

/**
 * On phones and small tablets a card spans the full width of the screen, so
 * its contents get the room that side margins and rounded corners would take.
 */
const SHEET = 'max-md:rounded-none max-md:border-x-0';

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

function Chip({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-sm text-slate-700 shadow-sm ring-1 ring-slate-200 ring-inset">
      <Icon name={icon} className="text-brand-600" />
      {children}
    </span>
  );
}

/** The job title, large, with the few facts a candidate wants before starting. */
function JobHero({ job, companyName }: { job: PublicJobResponse['job']; companyName: string }) {
  return (
    <div className="border-b border-slate-200 bg-linear-to-b from-brand-50 via-brand-50/40 to-white">
      <div className={cx(COLUMN, 'mx-auto px-4 py-7 sm:px-6 sm:py-10')}>
        <p className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-semibold text-brand-700 shadow-sm ring-1 ring-brand-200 ring-inset">
          <span className={cx('h-1.5 w-1.5 rounded-full', job.open ? 'bg-emerald-500' : 'bg-slate-400')} aria-hidden="true" />
          {job.open ? `${companyName} is hiring` : 'Applications closed'}
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">{job.title}</h1>
        <div className="mt-4 flex flex-wrap gap-2">
          {job.experienceCriteria && <Chip icon="briefcase">{job.experienceCriteria}</Chip>}
          {job.open && <Chip icon="clock">Takes about 3 minutes</Chip>}
          {job.open && <Chip icon="file">Keep your resume ready</Chip>}
        </div>
      </div>
    </div>
  );
}

const NEXT_STEPS = [
  { title: 'You apply', text: 'Three short steps and your resume.' },
  { title: 'Our team reviews', text: 'Every application is read by a person.' },
  { title: 'We contact you', text: 'If your profile matches the role.' },
];

function JobSummary({ job }: { job: PublicJobResponse['job'] }) {
  const [expanded, setExpanded] = useState(false);
  const sections = [
    { heading: 'About the role', text: job.description },
    { heading: 'Responsibilities', text: job.responsibilities },
    { heading: 'Requirements', text: job.requirements },
  ].filter((s) => s.text.trim() !== '');

  return (
    <aside className="space-y-4 lg:sticky lg:top-6">
      {sections.length > 0 && (
        <Card className={cx(SHEET, 'px-4 py-4 sm:px-6 md:py-5 lg:p-6')}>
          {/* On phones the description is collapsed so the form is reachable without scrolling far. */}
          <button
            type="button"
            className="flex w-full items-center justify-between text-left text-sm font-semibold text-slate-900 lg:hidden"
            aria-expanded={expanded}
            aria-controls="job-details"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Hide job description' : 'Read the job description'}
            <Icon name={expanded ? 'up' : 'down'} className="text-slate-500" />
          </button>
          <div id="job-details" className={cx('space-y-5 lg:block', expanded ? 'mt-4 block' : 'hidden')}>
            {sections.map((section) => (
              <section key={section.heading}>
                <h2 className="mb-2 text-sm font-semibold text-slate-900">{section.heading}</h2>
                <RichText text={section.text} />
              </section>
            ))}
          </div>
        </Card>
      )}

      {job.open && (
        <Card className="hidden p-5 sm:p-6 lg:block">
          <h2 className="text-sm font-semibold text-slate-900">What happens next</h2>
          <ol className="mt-4 space-y-4">
            {NEXT_STEPS.map((item, i) => (
              <li key={item.title} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700 ring-1 ring-brand-200 ring-inset">
                  {i + 1}
                </span>
                <div>
                  <p className="text-sm font-medium text-slate-900">{item.title}</p>
                  <p className="text-sm text-slate-500">{item.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}
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
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold transition-colors',
                done && 'bg-emerald-500 text-white',
                current && 'bg-brand-600 text-white shadow-md ring-4 ring-brand-100',
                !done && !current && 'bg-slate-100 text-slate-400',
              )}
            >
              {done ? <Icon name="check" /> : i + 1}
            </span>
          );
          return (
            <li key={label} className={cx('flex items-center', i < STEPS.length - 1 && 'flex-1')} aria-current={current ? 'step' : undefined}>
              {done ? (
                <button type="button" onClick={() => onBack(i)} className="flex items-center gap-2 rounded-full hover:opacity-80" aria-label={`Go back to ${label}`}>
                  {marker}
                  <span className="hidden text-sm font-medium text-slate-700 sm:inline">{label}</span>
                </button>
              ) : (
                <span className="flex items-center gap-2">
                  {marker}
                  <span className={cx('hidden text-sm font-medium sm:inline', current ? 'text-slate-900' : 'text-slate-500')}>{label}</span>
                </span>
              )}
              {i < STEPS.length - 1 && <span className={cx('mx-3 h-0.5 flex-1 rounded transition-colors', done ? 'bg-emerald-500' : 'bg-slate-200')} aria-hidden="true" />}
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

const STEP_INTROS = [
  'Tell us who you are and how to reach you.',
  'A few details about your experience.',
  'Upload your resume and check your details before sending.',
];

interface FormProps {
  job: PublicJobResponse['job'];
  form: NonNullable<PublicJobResponse['form']>;
  companyName: string;
}

function ApplicationForm({ job, form, companyName }: FormProps) {
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
  const [emailSent, setEmailSent] = useState(false);
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
      const result = await api<SubmitApplicationResponse>(`/api/public/jobs/${job.id}/applications`, { body });
      setEmailSent(result.confirmationEmail);
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
      <Card className={cx(SHEET, 'overflow-hidden')}>
        <div className="bg-linear-to-b from-emerald-50 to-white px-4 pt-10 pb-6 text-center sm:px-10">
          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg ring-8 ring-emerald-100">
            <Icon name="check" className="h-8 w-8" />
          </span>
          <h2 className="mt-5 text-2xl font-semibold tracking-tight text-slate-900" role="status">
            Application submitted
          </h2>
          <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-slate-700">
            Thank you for applying to <span className="font-semibold text-slate-900">{companyName}</span> for the{' '}
            <span className="font-semibold text-slate-900">{job.title}</span> position.
          </p>
          <p className="mx-auto mt-2 max-w-md text-[15px] leading-relaxed text-slate-600">
            Our team will review your application. If your profile matches the requirements, we will contact you shortly.
          </p>
          {emailSent && (
            <p className="mx-auto mt-5 flex max-w-md items-start justify-center gap-2 rounded-xl bg-white/70 px-4 py-3 text-left text-sm text-slate-600 ring-1 ring-emerald-100">
              <Icon name="mail" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              <span>
                A confirmation email is on its way to <span className="font-medium wrap-anywhere text-slate-900">{values.email.trim()}</span>. If
                you cannot find it in a few minutes, check your spam folder.
              </span>
            </p>
          )}
        </div>

        <div className="border-t border-slate-100 px-4 py-6 sm:px-10">
          <ol className="mx-auto max-w-sm space-y-3">
            {[
              { title: 'Application received', done: true },
              { title: 'Review by our team', done: false },
              { title: 'We contact you if your profile matches', done: false },
            ].map((item, i) => (
              <li key={item.title} className="flex items-center gap-3 text-sm">
                <span
                  className={cx(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                    item.done ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-500',
                  )}
                >
                  {item.done ? <Icon name="check" className="h-3.5 w-3.5" /> : i + 1}
                </span>
                <span className={item.done ? 'font-medium text-slate-900' : 'text-slate-600'}>{item.title}</span>
              </li>
            ))}
          </ol>

          <div className="mt-6 flex flex-col items-center gap-3 border-t border-slate-100 pt-5 text-center">
            <p className="text-xs text-slate-500">
              Your reference: <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono font-semibold text-slate-700">{submittedId}</span>
            </p>
            <Link to="/" className={buttonClass('secondary')}>
              View other open positions
            </Link>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className={cx(SHEET, 'px-4 py-6 shadow-md sm:px-6 md:p-8')}>
      <Stepper step={step} onBack={goTo} />
      {/* Taller fields with larger text on this form: easier to read and to tap. */}
      <form
        onSubmit={submit}
        noValidate
        className="mt-7 [&_input:not([type=file],[type=radio])]:h-11 [&_input]:text-base [&_select]:h-11 [&_select]:text-base [&_textarea]:text-base"
      >
        <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-tight text-slate-900 outline-none">
          {STEPS[step]}
        </h2>
        <p className="mt-1 text-sm text-slate-500">{STEP_INTROS[step]}</p>

        {/* Hidden from people; automated form-fillers tend to complete it. */}
        <div className="absolute -left-[9999px] h-0 w-0 overflow-hidden" aria-hidden="true">
          <label>
            Website
            <input type="text" name="website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
          </label>
        </div>

        <div className="mt-6 space-y-5">
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

        <div className="mt-8 flex flex-col-reverse gap-3 border-t border-slate-200 pt-5 sm:flex-row sm:items-center sm:justify-between">
          {step > 0 ? (
            <Button variant="secondary" size="lg" icon="left" onClick={() => goTo(step - 1)} disabled={submitting}>
              Back
            </Button>
          ) : (
            <p className="hidden text-xs text-slate-500 sm:block">
              Step {step + 1} of {STEPS.length}
            </p>
          )}
          {step < STEPS.length - 1 ? (
            <Button type="submit" variant="primary" size="lg" className="group sm:min-w-40">
              Continue <Icon name="arrowRight" className="transition-transform group-hover:translate-x-1" />
            </Button>
          ) : (
            <Button type="submit" variant="primary" size="lg" className="group sm:min-w-48" busy={submitting}>
              {submitting ? 'Submitting…' : 'Submit application'}
              {!submitting && <Icon name="arrowRight" className="transition-transform group-hover:translate-x-1" />}
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}

const YES_NO = ['Yes', 'No'] as const;

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
      <Field
        label="Current annual CTC"
        required
        error={errors.ctcAmount ?? errors.ctcCurrency}
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
          // One control: the currency sits on the left edge of the amount.
          <div className="flex">
            <div className="w-24 shrink-0">
              <Select
                aria-label="Currency"
                name="ctcCurrency"
                className="relative rounded-r-none border-r-0 focus:z-10"
                value={values.ctcCurrency}
                onChange={(e) => set('ctcCurrency', e.target.value)}
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </div>
            <TextInput
              {...control}
              name="ctcAmount"
              inputMode="decimal"
              autoComplete="off"
              className="relative min-w-0 flex-1 rounded-l-none focus:z-10"
              value={values.ctcAmount}
              onChange={(e) => set('ctcAmount', e.target.value)}
              maxLength={20}
            />
          </div>
        )}
      </Field>

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
            if (question.type === 'yes_no') {
              return (
                <Field
                  key={question.id}
                  group
                  label={question.label}
                  required={question.required}
                  error={error}
                  hint={
                    !question.required && value ? (
                      <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => setAnswer(question.id, '')}>
                        Clear answer
                      </button>
                    ) : undefined
                  }
                >
                  {(control) => (
                    <ChoiceGroup {...control} name={`answer-${question.id}`} options={YES_NO} value={value} onChange={(v) => setAnswer(question.id, v)} />
                  )}
                </Field>
              );
            }
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
                      {question.options.map((option) => (
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
              'group flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-9 text-center transition-colors',
              dragging ? 'border-brand-500 bg-brand-50' : error ? 'border-rose-300 bg-rose-50' : 'border-slate-300 bg-slate-50/60 hover:border-brand-400 hover:bg-brand-50/50',
            )}
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-brand-600 shadow-sm ring-1 ring-slate-200 transition-transform group-hover:-translate-y-0.5">
              <Icon name="upload" className="h-5 w-5" />
            </span>
            <span className="text-sm font-semibold text-slate-900">
              <span className="text-brand-700">Choose your resume</span>
              <span className="hidden font-normal text-slate-500 sm:inline"> or drag it here</span>
            </span>
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
