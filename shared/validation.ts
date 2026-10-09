// Validation rules for the candidate application form. The same functions run
// in the browser (for instant feedback) and on the server (as the authority).
// Keep this file free of Node-only imports.

import {
  CURRENCIES,
  LIMITS,
  RESUME_EXTENSIONS,
  experienceRangeByKey,
  type Currency,
  type ExperienceRange,
  type Question,
  type ResumeExtension,
} from './constants';

/** Field name -> message. Custom question errors use the key `answers.<questionId>`. */
export type FieldErrors = Record<string, string>;

export interface ApplicationFormValues {
  fullName: string;
  email: string;
  phone: string;
  location: string;
  ctcCurrency: string;
  ctcAmount: string;
  /** Key of an entry in EXPERIENCE_RANGES. */
  experienceRange: string;
  experienceYears: string;
  linkedinUrl: string;
  answers: Record<string, string>;
}

export interface ValidAnswer {
  questionId: string;
  question: string;
  answer: string;
}

export interface ValidApplication {
  fullName: string;
  email: string;
  phone: string;
  location: string;
  ctcCurrency: Currency;
  ctcAmount: number;
  experienceRange: ExperienceRange;
  experienceYears: string;
  linkedinUrl: string;
  answers: ValidAnswer[];
}

/** Single-line input: control characters removed, whitespace collapsed. */
export function cleanLine(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Multi-line input: newlines kept, other control characters removed. */
export function cleanText(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
}

const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

export function normalizeEmail(value: unknown): string {
  return cleanLine(value).toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_PATTERN.test(email);
}

/** Returns a normalised https LinkedIn URL, or null if the input is not one. */
export function normalizeLinkedinUrl(value: unknown): string | null {
  let raw = cleanLine(value);
  if (!raw || raw.length > LIMITS.url) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;
  const path = url.pathname.replace(/\/+$/, '');
  if (path.length < 2) return null;
  return `https://${host}${path}`;
}

/** Parses an amount such as "12,00,000" or "1200000.50". Returns null when invalid. */
export function parseAmount(value: unknown): number | null {
  const raw = cleanLine(value).replace(/[,\s]/g, '');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(raw)) return null;
  const amount = Number(raw);
  return Number.isFinite(amount) && amount <= LIMITS.maxCtc ? amount : null;
}

export function validateBasicDetails(values: ApplicationFormValues): FieldErrors {
  const errors: FieldErrors = {};

  const fullName = cleanLine(values.fullName);
  if (fullName.length < 2) errors.fullName = 'Enter your full name.';
  else if (fullName.length > LIMITS.name) errors.fullName = `Keep your name under ${LIMITS.name} characters.`;

  const email = normalizeEmail(values.email);
  if (!email) errors.email = 'Enter your email address.';
  else if (!isValidEmail(email)) errors.email = 'Enter a valid email address, like name@example.com.';

  const phone = cleanLine(values.phone);
  const digits = phone.replace(/\D/g, '');
  if (!phone) errors.phone = 'Enter your phone number.';
  else if (!/^\+?[\d\s().-]+$/.test(phone) || digits.length < 7 || digits.length > 15) {
    errors.phone = 'Enter a valid phone number, including country code if outside India.';
  }

  const location = cleanLine(values.location);
  if (location.length < 2) errors.location = 'Enter your current city or location.';
  else if (location.length > LIMITS.location) {
    errors.location = `Keep the location under ${LIMITS.location} characters.`;
  }

  return errors;
}

function cleanAnswer(question: Question, value: unknown): string {
  return question.type === 'long_text' ? cleanText(value) : cleanLine(value);
}

export function validateProfessionalDetails(
  values: ApplicationFormValues,
  questions: Question[],
): FieldErrors {
  const errors: FieldErrors = {};

  if (!(CURRENCIES as readonly string[]).includes(values.ctcCurrency)) {
    errors.ctcCurrency = 'Choose a currency.';
  }
  if (!cleanLine(values.ctcAmount)) errors.ctcAmount = 'Enter your current annual CTC. Enter 0 if not applicable.';
  else if (parseAmount(values.ctcAmount) === null) {
    errors.ctcAmount = 'Enter the full annual amount as a number, for example 1200000.';
  }

  const range = experienceRangeByKey(values.experienceRange);
  if (!range) {
    errors.experienceRange = 'Choose your total professional experience.';
  } else if (range.years.length > 0 && !range.years.includes(values.experienceYears)) {
    errors.experienceYears = 'Choose your exact number of completed years.';
  }

  if (!cleanLine(values.linkedinUrl)) errors.linkedinUrl = 'Enter your LinkedIn profile URL.';
  else if (!normalizeLinkedinUrl(values.linkedinUrl)) {
    errors.linkedinUrl = 'Enter a LinkedIn profile URL, like https://www.linkedin.com/in/your-name.';
  }

  for (const question of questions) {
    const key = `answers.${question.id}`;
    const answer = cleanAnswer(question, values.answers?.[question.id]);
    if (!answer) {
      if (question.required) errors[key] = 'This question is required.';
      continue;
    }
    if (question.type === 'select' && !question.options.includes(answer)) {
      errors[key] = 'Choose one of the listed options.';
    } else if (question.type === 'yes_no' && answer !== 'Yes' && answer !== 'No') {
      errors[key] = 'Choose Yes or No.';
    } else if (question.type === 'short_text' && answer.length > LIMITS.shortAnswer) {
      errors[key] = `Keep your answer under ${LIMITS.shortAnswer} characters.`;
    } else if (question.type === 'long_text' && answer.length > LIMITS.longAnswer) {
      errors[key] = `Keep your answer under ${LIMITS.longAnswer} characters.`;
    }
  }

  return errors;
}

/** Validates the whole form and returns cleaned, typed values ready to store. */
export function validateApplication(
  values: ApplicationFormValues,
  questions: Question[],
): { ok: true; data: ValidApplication } | { ok: false; errors: FieldErrors } {
  const errors = { ...validateBasicDetails(values), ...validateProfessionalDetails(values, questions) };
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const range = experienceRangeByKey(values.experienceRange)!;
  return {
    ok: true,
    data: {
      fullName: cleanLine(values.fullName),
      email: normalizeEmail(values.email),
      phone: cleanLine(values.phone),
      location: cleanLine(values.location),
      ctcCurrency: values.ctcCurrency as Currency,
      ctcAmount: parseAmount(values.ctcAmount)!,
      experienceRange: range,
      experienceYears: range.years.length > 0 ? values.experienceYears : '',
      linkedinUrl: normalizeLinkedinUrl(values.linkedinUrl)!,
      answers: questions
        .map((question) => ({
          questionId: question.id,
          question: question.label,
          answer: cleanAnswer(question, values.answers?.[question.id]),
        }))
        .filter((a) => a.answer !== ''),
    },
  };
}

export function resumeExtension(filename: string): ResumeExtension | null {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return (RESUME_EXTENSIONS as readonly string[]).includes(ext ?? '') ? (ext as ResumeExtension) : null;
}

/** Quick check on the chosen file. The server additionally inspects the file contents. */
export function validateResumeChoice(
  file: { name: string; size: number } | null,
  maxBytes: number,
): string | null {
  if (!file) return 'Attach your resume.';
  if (!resumeExtension(file.name)) return 'Upload your resume as a PDF, DOC or DOCX file.';
  if (file.size === 0) return 'This file is empty. Choose another file.';
  if (file.size > maxBytes) {
    return `This file is too large. The limit is ${formatFileSize(maxBytes)}.`;
  }
  return null;
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
