import { JOB_STATUSES, LIMITS, QUESTION_TYPES, type JobStatus, type Question } from '../shared/constants';
import type { JobInput } from '../shared/job-schema';
import type { JobDto } from '../shared/types';
import { HttpError, notFound } from './errors';
import { newJobId, newQuestionId } from './ids';
import { safeName } from './resume-file';
import { JOBS, JOBS_FOLDER_NAME } from './schema';
import { withRetry } from './storage/retry';
import type { Row } from './storage/tables';
import type { Storage } from './storage';

export interface Job extends JobDto {
  /** Drive folder that receives this job's resumes. Empty until first needed. */
  driveFolderId: string;
}

// Google Sheets rejects cells above 50,000 characters.
const MAX_QUESTIONS_JSON = 45_000;
const QUESTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const QUESTION_TYPE_VALUES = QUESTION_TYPES.map((t) => t.value) as readonly string[];

function parseQuestions(raw: string): Question[] {
  if (!raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((q): q is Question => {
        const c = q as Partial<Question> | null;
        return (
          !!c &&
          typeof c.id === 'string' &&
          typeof c.label === 'string' &&
          typeof c.type === 'string' &&
          QUESTION_TYPE_VALUES.includes(c.type)
        );
      })
      .map((q) => ({
        id: q.id,
        label: q.label,
        type: q.type,
        required: q.required === true,
        options: Array.isArray(q.options) ? q.options.map(String) : [],
      }));
  } catch {
    // A hand-edited cell that is no longer valid JSON must not take the job page down.
    return [];
  }
}

function toJob(row: Row): Job {
  const status = JOB_STATUSES.find((s) => s.toLowerCase() === row.status.trim().toLowerCase());
  return {
    id: row.id,
    title: row.title,
    // An unrecognised status is treated as Draft so nothing becomes public by accident.
    status: status ?? 'Draft',
    description: row.description,
    responsibilities: row.responsibilities,
    requirements: row.requirements,
    experienceCriteria: row.experienceCriteria,
    questions: parseQuestions(row.questions),
    driveFolderId: row.driveFolderId.trim(),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toJobDto(job: Job): JobDto {
  const { driveFolderId: _driveFolderId, ...dto } = job;
  return dto;
}

/** Gives every question a stable, unique ID, keeping the IDs of existing questions. */
function withQuestionIds(questions: JobInput['questions']): Question[] {
  const used = new Set<string>();
  return questions.map((q) => {
    let id = q.id && QUESTION_ID_PATTERN.test(q.id) && !used.has(q.id) ? q.id : newQuestionId();
    while (used.has(id)) id = newQuestionId();
    used.add(id);
    return { id, label: q.label, type: q.type, required: q.required, options: q.options };
  });
}

function serializeQuestions(questions: Question[]): string {
  const json = JSON.stringify(questions);
  if (json.length > MAX_QUESTIONS_JSON) {
    throw new HttpError(422, 'The application questions are too long to save. Shorten or remove some.', {
      fieldErrors: { questions: 'The questions are too long in total. Shorten or remove some.' },
    });
  }
  return json;
}

function folderName(title: string, jobId: string): string {
  return `${safeName(title, LIMITS.jobTitle, 'Job')} [${jobId}]`;
}

export class JobsService {
  private jobsFolder: Promise<string> | null = null;
  private readonly folderCreation = new Map<string, Promise<string>>();

  constructor(private readonly storage: Storage) {}

  async list(): Promise<Job[]> {
    const rows = await this.storage.tables.read(JOBS.name);
    return rows.map(toJob).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<Job | null> {
    return (await this.list()).find((job) => job.id === id) ?? null;
  }

  async require(id: string): Promise<Job> {
    const job = await this.get(id);
    if (!job) throw notFound('This job');
    return job;
  }

  /** Finds or creates the "Jobs" folder inside the root folder. */
  private jobsFolderId(): Promise<string> {
    if (!this.jobsFolder) {
      const { drive, rootFolderId } = this.storage;
      this.jobsFolder = (async () => {
        const existing = await withRetry(() => drive.findFolder(rootFolderId, JOBS_FOLDER_NAME));
        return existing ?? (await drive.createFolder(rootFolderId, JOBS_FOLDER_NAME));
      })().catch((err) => {
        this.jobsFolder = null;
        throw err;
      });
    }
    return this.jobsFolder;
  }

  /**
   * Returns the job's Drive folder, creating it on first use. Concurrent
   * callers share one creation so a job never ends up with two folders.
   */
  ensureFolder(job: Job): Promise<string> {
    if (job.driveFolderId) return Promise.resolve(job.driveFolderId);
    const pending = this.folderCreation.get(job.id);
    if (pending) return pending;

    const creation = (async () => {
      // Another request may have created it since this job object was loaded.
      const rows = await this.storage.tables.read(JOBS.name, { fresh: true });
      const current = rows.find((r) => r.id === job.id)?.driveFolderId.trim();
      if (current) return current;

      const parent = await this.jobsFolderId();
      const name = folderName(job.title, job.id);
      const folderId =
        (await withRetry(() => this.storage.drive.findFolder(parent, name))) ??
        (await this.storage.drive.createFolder(parent, name));
      await this.storage.tables.updateById(JOBS.name, [{ id: job.id, patch: { driveFolderId: folderId } }]);
      return folderId;
    })().finally(() => this.folderCreation.delete(job.id));

    this.folderCreation.set(job.id, creation);
    return creation;
  }

  async create(input: JobInput, status: Extract<JobStatus, 'Draft' | 'Published'>): Promise<Job> {
    const now = new Date().toISOString();
    const id = newJobId();
    const questions = withQuestionIds(input.questions);
    const questionsJson = serializeQuestions(questions);

    const parent = await this.jobsFolderId();
    const driveFolderId = await this.storage.drive.createFolder(parent, folderName(input.title, id));

    const exists = async () =>
      (await this.storage.tables.read(JOBS.name, { fresh: true })).some((r) => r.id === id);
    try {
      await this.storage.tables.append(
        [
          {
            table: JOBS.name,
            rows: [
              {
                id,
                title: input.title,
                status,
                description: input.description,
                responsibilities: input.responsibilities,
                requirements: input.requirements,
                experienceCriteria: input.experienceCriteria,
                questions: questionsJson,
                driveFolderId,
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
        ],
        { alreadyDone: exists },
      );
    } catch (err) {
      // Remove the empty folder only when the job row definitely was not saved.
      const saved = await exists().catch(() => null);
      if (saved === false) await this.storage.drive.trash(driveFolderId).catch(() => undefined);
      if (saved !== true) throw err;
    }
    return this.require(id);
  }

  async update(id: string, input: JobInput): Promise<Job> {
    const existing = await this.require(id);
    const questions = withQuestionIds(input.questions);
    const { notFound: missing } = await this.storage.tables.updateById(JOBS.name, [
      {
        id,
        patch: {
          title: input.title,
          description: input.description,
          responsibilities: input.responsibilities,
          requirements: input.requirements,
          experienceCriteria: input.experienceCriteria,
          questions: serializeQuestions(questions),
          updatedAt: new Date().toISOString(),
        },
      },
    ]);
    if (missing.length > 0) throw notFound('This job');

    if (existing.driveFolderId && existing.title !== input.title) {
      // Keeping the folder name in step with the title is a nicety; never fail the save over it.
      await this.storage.drive
        .rename(existing.driveFolderId, folderName(input.title, id))
        .catch((err) => console.warn(`[jobs] Could not rename Drive folder for job ${id}: ${(err as Error).message}`));
    }
    return this.require(id);
  }

  async setStatus(id: string, status: JobStatus): Promise<Job> {
    const { notFound: missing } = await this.storage.tables.updateById(JOBS.name, [
      { id, patch: { status, updatedAt: new Date().toISOString() } },
    ]);
    if (missing.length > 0) throw notFound('This job');
    return this.require(id);
  }
}
