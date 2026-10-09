// Shared between the browser and the server. Keep this file free of Node-only imports.

export const APPLICATION_STATUSES = [
  'New',
  'Under Review',
  'Shortlisted',
  'Rejected',
  'Hired',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const JOB_STATUSES = ['Draft', 'Published', 'Closed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface ExperienceRange {
  key: string;
  label: string;
  /** Exact completed-year choices offered as a follow-up. Empty means no follow-up. */
  years: string[];
  /** Used for sorting when no exact year is available. */
  order: number;
}

export const MAX_EXPERIENCE_YEARS_LABEL = '20+';

export const EXPERIENCE_RANGES: ExperienceRange[] = [
  { key: 'lt1', label: 'Less than 1 year', years: [], order: 0 },
  { key: '1-3', label: '1–3 years', years: ['1', '2', '3'], order: 1 },
  { key: '3-5', label: '3–5 years', years: ['3', '4', '5'], order: 3 },
  { key: '5-8', label: '5–8 years', years: ['5', '6', '7', '8'], order: 5 },
  {
    key: '8plus',
    label: '8+ years',
    years: [
      ...Array.from({ length: 12 }, (_, i) => String(i + 8)),
      MAX_EXPERIENCE_YEARS_LABEL,
    ],
    order: 8,
  },
];

export function experienceRangeByKey(key: string): ExperienceRange | undefined {
  return EXPERIENCE_RANGES.find((r) => r.key === key);
}

/** Tolerant lookup for values read back from the sheet (label or key, any dash style). */
export function experienceRangeByLabel(label: string): ExperienceRange | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[–—-]/g, '-').replace(/\s+/g, ' ').trim();
  const wanted = norm(label);
  return EXPERIENCE_RANGES.find((r) => norm(r.label) === wanted || r.key === wanted);
}

export const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'CAD', 'AUD'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const QUESTION_TYPES = [
  { value: 'short_text', label: 'Short answer' },
  { value: 'long_text', label: 'Paragraph' },
  { value: 'select', label: 'Dropdown' },
  { value: 'yes_no', label: 'Yes / No' },
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number]['value'];

export interface Question {
  id: string;
  label: string;
  type: QuestionType;
  required: boolean;
  /** Only used by the "select" type. */
  options: string[];
}

export const RESUME_EXTENSIONS = ['pdf', 'doc', 'docx'] as const;
export type ResumeExtension = (typeof RESUME_EXTENSIONS)[number];

export const RESUME_MIME_TYPES: Record<ResumeExtension, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export const LIMITS = {
  jobTitle: 150,
  jobLongText: 10_000,
  jobExperienceCriteria: 300,
  questionsPerJob: 20,
  questionLabel: 300,
  optionsPerQuestion: 30,
  optionLabel: 100,
  shortAnswer: 300,
  longAnswer: 3_000,
  notes: 5_000,
  name: 100,
  location: 100,
  url: 300,
  maxCtc: 100_000_000_000,
} as const;

export const PAGE_SIZES = [25, 50, 100] as const;
