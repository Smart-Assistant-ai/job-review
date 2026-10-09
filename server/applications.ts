import {
  APPLICATION_STATUSES,
  CURRENCIES,
  EXPERIENCE_RANGES,
  MAX_EXPERIENCE_YEARS_LABEL,
  experienceRangeByLabel,
  type ApplicationStatus,
} from '../shared/constants';
import {
  SORT_KEYS,
  type ActivityDto,
  type AnswerDto,
  type ApplicationDto,
  type JobCounts,
  type SortKey,
} from '../shared/types';
import { normalizeEmail, type ValidApplication } from '../shared/validation';
import { HttpError } from './errors';
import { newApplicationId } from './ids';
import type { Job, JobsService } from './jobs';
import { buildResumeFilename, type ValidResume } from './resume-file';
import { ACTIVITY, ANSWERS, APPLICATIONS } from './schema';
import { withRetry } from './storage/retry';
import type { Row } from './storage/tables';
import type { CellValue, Storage } from './storage';

export interface ApplicationFilters {
  q?: string;
  jobId?: string;
  status?: string;
  /** Key of an entry in EXPERIENCE_RANGES. */
  experience?: string;
  ctcCurrency?: string;
  ctcMin?: number;
  ctcMax?: number;
  /** Inclusive calendar dates (YYYY-MM-DD) in the configured time zone. */
  from?: string;
  to?: string;
  sort: SortKey;
  dir: 'asc' | 'desc';
}

function toNumber(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toApplication(row: Row): ApplicationDto {
  const status = row.status.trim();
  const known = APPLICATION_STATUSES.find((s) => s.toLowerCase() === status.toLowerCase());
  return {
    id: row.id,
    jobId: row.jobId.trim(),
    jobTitle: row.jobTitle,
    fullName: row.fullName,
    email: row.email,
    phone: row.phone,
    location: row.location,
    ctcCurrency: row.ctcCurrency.trim().toUpperCase(),
    ctcAmount: toNumber(row.ctcAmount),
    experienceRange: row.experienceRange,
    experienceYears: row.experienceYears.trim(),
    linkedinUrl: row.linkedinUrl,
    resumeFileId: row.resumeFileId.trim(),
    resumeFilename: row.resumeFilename,
    resumeMimeType: row.resumeMimeType,
    resumeSize: toNumber(row.resumeSize),
    submittedAt: row.submittedAt,
    status: known ?? (status || 'New'),
    notes: row.notes,
    updatedAt: row.updatedAt,
  };
}

/** Reads list filters from a query string or form body, ignoring anything malformed. */
export function parseFilters(input: Record<string, unknown>): ApplicationFilters {
  const str = (key: string): string | undefined => {
    const value = input[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 200) : undefined;
  };
  const num = (key: string): number | undefined => {
    const raw = str(key);
    if (raw === undefined) return undefined;
    const n = Number(raw.replace(/,/g, ''));
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const date = (key: string): string | undefined => {
    const raw = str(key);
    return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
  };

  const sort = str('sort');
  const currency = str('ctcCurrency')?.toUpperCase();
  return {
    q: str('q'),
    jobId: str('job'),
    status: str('status'),
    experience: EXPERIENCE_RANGES.some((r) => r.key === str('experience')) ? str('experience') : undefined,
    ctcCurrency: currency && (CURRENCIES as readonly string[]).includes(currency) ? currency : undefined,
    ctcMin: num('ctcMin'),
    ctcMax: num('ctcMax'),
    from: date('from'),
    to: date('to'),
    sort: (SORT_KEYS as readonly string[]).includes(sort ?? '') ? (sort as SortKey) : 'submittedAt',
    dir: str('dir') === 'asc' ? 'asc' : 'desc',
  };
}

/** Experience as a number for sorting: exact years when known, otherwise the start of the range. */
function experienceSortValue(app: ApplicationDto): number {
  if (app.experienceYears === MAX_EXPERIENCE_YEARS_LABEL) return 20.5;
  const exact = Number(app.experienceYears);
  if (app.experienceYears !== '' && Number.isFinite(exact)) return exact;
  const range = experienceRangeByLabel(app.experienceRange);
  if (!range) return -1;
  return range.key === 'lt1' ? 0.5 : range.order;
}

class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.catch(() => undefined);
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return result;
  }
}

export class ApplicationsService {
  private readonly submitLocks = new KeyedMutex();

  constructor(
    private readonly storage: Storage,
    private readonly jobs: JobsService,
    private readonly timezone: string,
  ) {}

  async list(options: { fresh?: boolean } = {}): Promise<ApplicationDto[]> {
    const rows = await this.storage.tables.read(APPLICATIONS.name, options);
    return rows.map(toApplication);
  }

  async get(id: string): Promise<ApplicationDto | null> {
    return (await this.list()).find((app) => app.id === id) ?? null;
  }

  /** Answers grouped by application ID. */
  async answersByApplication(): Promise<Map<string, AnswerDto[]>> {
    const rows = await this.storage.tables.read(ANSWERS.name);
    const grouped = new Map<string, AnswerDto[]>();
    for (const row of rows) {
      const id = row.applicationId.trim();
      const list = grouped.get(id) ?? [];
      list.push({ questionId: row.questionId.trim(), question: row.question, answer: row.answer });
      grouped.set(id, list);
    }
    return grouped;
  }

  async activityFor(applicationId: string): Promise<ActivityDto[]> {
    const rows = await this.storage.tables.read(ACTIVITY.name);
    return rows
      .filter((row) => row.applicationId.trim() === applicationId)
      .map((row) => ({ timestamp: row.timestamp, action: row.action, detail: row.detail, actor: row.actor }))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  async countsByJob(): Promise<Map<string, JobCounts>> {
    const counts = new Map<string, JobCounts>();
    for (const app of await this.list()) {
      const entry = counts.get(app.jobId) ?? { total: 0, new: 0, shortlisted: 0 };
      entry.total += 1;
      if (app.status === 'New') entry.new += 1;
      if (app.status === 'Shortlisted') entry.shortlisted += 1;
      counts.set(app.jobId, entry);
    }
    return counts;
  }

  /** Calendar date of a timestamp in the configured time zone, as YYYY-MM-DD. */
  private localDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  /** Returns every application matching the filters, sorted. Paging is left to the caller. */
  async query(filters: ApplicationFilters): Promise<ApplicationDto[]> {
    const needle = filters.q?.toLowerCase();
    const experienceLabel = EXPERIENCE_RANGES.find((r) => r.key === filters.experience)?.label;
    const filterByCtc = filters.ctcMin !== undefined || filters.ctcMax !== undefined;

    const matches = (await this.list()).filter((app) => {
      if (filters.jobId && app.jobId !== filters.jobId) return false;
      if (filters.status && app.status.toLowerCase() !== filters.status.toLowerCase()) return false;
      if (experienceLabel && experienceRangeByLabel(app.experienceRange)?.label !== experienceLabel) return false;
      if (filters.ctcCurrency && app.ctcCurrency !== filters.ctcCurrency) return false;
      if (filterByCtc) {
        if (app.ctcAmount === null) return false;
        if (filters.ctcMin !== undefined && app.ctcAmount < filters.ctcMin) return false;
        if (filters.ctcMax !== undefined && app.ctcAmount > filters.ctcMax) return false;
      }
      if (filters.from || filters.to) {
        const day = this.localDate(app.submittedAt);
        if (!day) return false;
        if (filters.from && day < filters.from) return false;
        if (filters.to && day > filters.to) return false;
      }
      if (needle) {
        const haystack = [
          app.fullName,
          app.email,
          app.phone,
          app.location,
          app.linkedinUrl,
          app.jobTitle,
          app.id,
          app.notes,
        ]
          .join('\n')
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });

    const direction = filters.dir === 'asc' ? 1 : -1;
    const statusOrder = (s: string) => {
      const i = (APPLICATION_STATUSES as readonly string[]).indexOf(s);
      return i === -1 ? APPLICATION_STATUSES.length : i;
    };
    const compare: Record<SortKey, (a: ApplicationDto, b: ApplicationDto) => number> = {
      submittedAt: (a, b) => a.submittedAt.localeCompare(b.submittedAt),
      name: (a, b) => a.fullName.localeCompare(b.fullName, undefined, { sensitivity: 'base' }),
      job: (a, b) => a.jobTitle.localeCompare(b.jobTitle, undefined, { sensitivity: 'base' }),
      experience: (a, b) => experienceSortValue(a) - experienceSortValue(b),
      ctc: (a, b) => (a.ctcAmount ?? -1) - (b.ctcAmount ?? -1),
      status: (a, b) => statusOrder(a.status) - statusOrder(b.status),
    };
    const primary = compare[filters.sort];
    return matches.sort(
      (a, b) => direction * primary(a, b) || b.submittedAt.localeCompare(a.submittedAt) || a.id.localeCompare(b.id),
    );
  }

  /**
   * Stores a new application: resume to Drive first, then the answer,
   * application and activity rows in one atomic spreadsheet write.
   *
   * The application row is the commit point. If it cannot be written, the
   * uploaded resume is moved to the trash so no half-finished record remains.
   */
  submit(job: Job, data: ValidApplication, resume: ValidResume): Promise<{ id: string }> {
    // Two submissions for the same job and email wait for each other, so a
    // double-click cannot slip past the duplicate check.
    return this.submitLocks.run(`${job.id}:${data.email}`, async () => {
      const existing = await this.list();
      if (existing.some((app) => app.jobId === job.id && normalizeEmail(app.email) === data.email)) {
        throw new HttpError(409, 'We have already received an application for this role from this email address.', {
          code: 'duplicate',
        });
      }

      const id = newApplicationId();
      const filename = buildResumeFilename(data.fullName, id, resume.extension);
      const folderId = await this.jobs.ensureFolder(job);
      const { id: fileId } = await withRetry(() =>
        this.storage.drive.uploadFile({ folderId, name: filename, mimeType: resume.mimeType, data: resume.data }),
      );

      const now = new Date().toISOString();
      const isSaved = async () =>
        (await this.storage.tables.read(APPLICATIONS.name, { fresh: true })).some((row) => row.id === id);

      try {
        await this.storage.tables.append(
          [
            {
              table: ANSWERS.name,
              rows: data.answers.map((a) => ({
                applicationId: id,
                jobId: job.id,
                questionId: a.questionId,
                question: a.question,
                answer: a.answer,
              })),
            },
            {
              table: APPLICATIONS.name,
              rows: [
                {
                  id,
                  jobId: job.id,
                  jobTitle: job.title,
                  fullName: data.fullName,
                  email: data.email,
                  phone: data.phone,
                  location: data.location,
                  ctcCurrency: data.ctcCurrency,
                  ctcAmount: data.ctcAmount,
                  experienceRange: data.experienceRange.label,
                  experienceYears: data.experienceYears,
                  linkedinUrl: data.linkedinUrl,
                  resumeFileId: fileId,
                  resumeFilename: filename,
                  resumeMimeType: resume.mimeType,
                  resumeSize: resume.data.length,
                  submittedAt: now,
                  status: 'New',
                  notes: '',
                  updatedAt: now,
                },
              ],
            },
            {
              table: ACTIVITY.name,
              rows: [
                { timestamp: now, applicationId: id, jobId: job.id, action: 'Submitted', detail: '', actor: 'Candidate' },
              ],
            },
          ],
          { alreadyDone: isSaved },
        );
      } catch (err) {
        // The write may have gone through even though the call failed. Only
        // discard the resume when the record is confirmed absent: an orphaned
        // file is harmless, a record pointing at a discarded file is not.
        const saved = await isSaved().catch(() => null);
        if (saved === true) return { id };
        if (saved === false) await this.storage.drive.trash(fileId).catch(() => undefined);
        throw err;
      }
      return { id };
    });
  }

  /** Changes status and/or notes for one or many applications and records the change. */
  async update(
    ids: string[],
    patch: { status?: ApplicationStatus; notes?: string },
  ): Promise<{ updated: string[]; notFound: string[] }> {
    const current = new Map((await this.list({ fresh: true })).map((app) => [app.id, app]));
    const now = new Date().toISOString();
    const updates: { id: string; patch: Record<string, CellValue> }[] = [];
    const activity: Record<string, CellValue>[] = [];
    const notFound: string[] = [];

    for (const id of new Set(ids)) {
      const app = current.get(id);
      if (!app) {
        notFound.push(id);
        continue;
      }
      const changes: Record<string, CellValue> = {};
      const log = (action: string, detail: string) =>
        activity.push({ timestamp: now, applicationId: id, jobId: app.jobId, action, detail, actor: 'Admin' });

      if (patch.status !== undefined && patch.status !== app.status) {
        changes.status = patch.status;
        log('Status changed', `${app.status} → ${patch.status}`);
      }
      if (patch.notes !== undefined && patch.notes !== app.notes) {
        changes.notes = patch.notes;
        log('Notes updated', '');
      }
      if (Object.keys(changes).length > 0) updates.push({ id, patch: { ...changes, updatedAt: now } });
    }

    const result = await this.storage.tables.updateById(APPLICATIONS.name, updates);
    notFound.push(...result.notFound);
    const gone = new Set(result.notFound);
    const updated = updates.map((u) => u.id).filter((id) => !gone.has(id));

    const recorded = activity.filter((row) => !gone.has(String(row.applicationId)));
    // The change itself is saved at this point; a failed log entry must not report it as failed.
    await this.storage.tables
      .append([{ table: ACTIVITY.name, rows: recorded }], { duplicatesHarmless: true })
      .catch((err) => console.warn(`[applications] Could not record activity: ${(err as Error).message}`));

    return { updated, notFound };
  }
}
