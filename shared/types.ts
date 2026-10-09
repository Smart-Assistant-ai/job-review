// Shapes of the data exchanged between the React app and the server.

import type { Currency, JobStatus, Question } from './constants';

export interface JobDto {
  id: string;
  title: string;
  status: JobStatus;
  description: string;
  responsibilities: string;
  requirements: string;
  experienceCriteria: string;
  questions: Question[];
  createdAt: string;
  updatedAt: string;
}

export interface JobCounts {
  total: number;
  new: number;
  shortlisted: number;
}

export interface JobSummaryDto extends JobDto {
  counts: JobCounts;
  /** Public link candidates use to apply. */
  applyUrl: string;
}

export interface OverviewResponse {
  jobs: JobSummaryDto[];
  totals: { activeJobs: number; applications: number; new: number; shortlisted: number };
}

export interface PublicJobListItem {
  id: string;
  title: string;
  experienceCriteria: string;
}

export interface PublicJobResponse {
  companyName: string;
  job: Pick<
    JobDto,
    'id' | 'title' | 'description' | 'responsibilities' | 'requirements' | 'experienceCriteria' | 'questions'
  > & { open: boolean };
  /** Present only while the job accepts applications. */
  form: { token: string; maxResumeBytes: number; defaultCurrency: Currency } | null;
}

export interface ApplicationDto {
  id: string;
  jobId: string;
  jobTitle: string;
  fullName: string;
  email: string;
  phone: string;
  location: string;
  ctcCurrency: string;
  ctcAmount: number | null;
  experienceRange: string;
  experienceYears: string;
  linkedinUrl: string;
  resumeFileId: string;
  resumeFilename: string;
  resumeMimeType: string;
  resumeSize: number | null;
  submittedAt: string;
  /** Normally one of APPLICATION_STATUSES; anything typed by hand in the sheet is shown as is. */
  status: string;
  notes: string;
  updatedAt: string;
}

export interface AnswerDto {
  questionId: string;
  question: string;
  answer: string;
}

export interface ActivityDto {
  timestamp: string;
  action: string;
  detail: string;
  actor: string;
}

export interface ApplicationListResponse {
  items: ApplicationDto[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** IDs of every application matching the filters, across all pages. */
  allIds: string[];
  jobs: { id: string; title: string; status: JobStatus }[];
}

export interface ApplicationDetailResponse {
  application: ApplicationDto;
  answers: AnswerDto[];
  activity: ActivityDto[];
  job: { id: string; title: string; status: JobStatus } | null;
}

export interface SessionResponse {
  authenticated: boolean;
  companyName: string;
  timezone: string;
  storage: 'google' | 'local';
  /** Set when sign-in cannot work until the server configuration is fixed. */
  loginProblem: string | null;
}

export interface DownloadProgress {
  state: 'running' | 'done' | 'failed' | 'cancelled';
  total: number;
  added: number;
  missing: number;
  message?: string;
}

export interface ApiErrorBody {
  error: string;
  code?: string;
  fieldErrors?: Record<string, string>;
}

export const SORT_KEYS = ['submittedAt', 'name', 'job', 'experience', 'ctc', 'status'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
