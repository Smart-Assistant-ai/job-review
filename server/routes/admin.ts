import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { APPLICATION_STATUSES, LIMITS, PAGE_SIZES, RESUME_MIME_TYPES } from '../../shared/constants';
import { jobInputSchema, zodFieldErrors } from '../../shared/job-schema';
import type {
  ApplicationDetailResponse,
  ApplicationDto,
  ApplicationListResponse,
  JobSummaryDto,
  OverviewResponse,
  SessionResponse,
} from '../../shared/types';
import { cleanText, resumeExtension } from '../../shared/validation';
import { parseFilters } from '../applications';
import { adminPasswordProblem } from '../config';
import { contentDisposition, publicBaseUrl, type AppContext } from '../context';
import { toCsv } from '../csv';
import { DownloadTracker } from '../downloads';
import { HttpError, notFound } from '../errors';
import { isApplicationId, isJobId } from '../ids';
import { toJobDto } from '../jobs';
import { safeName } from '../resume-file';
import { withRetry } from '../storage/retry';
import { isStorageError } from '../storage/types';
import { createResumeZip, type ZipItem } from '../zip';

const MAX_SELECTION = 5_000;

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError(422, 'Some details need your attention. Please check the highlighted fields.', {
      code: 'validation',
      fieldErrors: zodFieldErrors(result.error),
    });
  }
  return result.data;
}

const statusSchema = z.enum(APPLICATION_STATUSES);
const idListSchema = z.array(z.string().refine(isApplicationId)).min(1).max(MAX_SELECTION);

export function adminRouter(ctx: AppContext): Router {
  const { config, storage, jobs, applications, auth, downloads } = ctx;
  const router = Router();

  // ---- Sign-in. These three routes are the only ones reachable without a session. ----

  router.get('/session', async (req, res) => {
    const body: SessionResponse = {
      authenticated: await auth.isAuthenticated(req),
      companyName: config.companyName,
      timezone: config.timezone,
      storage: storage.kind,
      loginProblem: adminPasswordProblem(config),
    };
    res.json(body);
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.loginAttemptsPer15Min,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (_req, _res, next) =>
      next(new HttpError(429, 'Too many sign-in attempts. Please wait 15 minutes and try again.', { code: 'rate_limited' })),
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const problem = adminPasswordProblem(config);
    if (problem) throw new HttpError(503, `Sign-in is not available: ${problem}`, { code: 'login_unavailable' });
    const password: unknown = (req.body as { password?: unknown } | undefined)?.password;
    if (typeof password !== 'string' || !auth.checkPassword(password)) {
      throw new HttpError(401, 'Incorrect password.', { code: 'bad_password' });
    }
    await auth.signIn(req, res);
    res.status(204).end();
  });

  router.post('/logout', (req, res) => {
    auth.signOut(req, res);
    res.status(204).end();
  });

  // ---- Everything registered below this line requires an admin session. ----
  router.use(auth.requireAdmin);

  // ---- Jobs ----

  router.get('/overview', async (req, res) => {
    const [allJobs, counts] = await Promise.all([jobs.list(), applications.countsByJob()]);
    const siteUrl = publicBaseUrl(ctx, req);
    const summaries: JobSummaryDto[] = allJobs.map((job) => ({
      ...toJobDto(job),
      counts: counts.get(job.id) ?? { total: 0, new: 0, shortlisted: 0 },
      applyUrl: `${siteUrl}/apply/${job.id}`,
    }));
    const body: OverviewResponse = {
      jobs: summaries,
      totals: {
        activeJobs: summaries.filter((j) => j.status === 'Published').length,
        applications: summaries.reduce((sum, j) => sum + j.counts.total, 0),
        new: summaries.reduce((sum, j) => sum + j.counts.new, 0),
        shortlisted: summaries.reduce((sum, j) => sum + j.counts.shortlisted, 0),
      },
    };
    res.json(body);
  });

  router.get('/jobs/:jobId', async (req, res) => {
    const job = await jobs.require(String(req.params.jobId));
    res.json({ job: toJobDto(job), applyUrl: `${publicBaseUrl(ctx, req)}/apply/${job.id}` });
  });

  router.post('/jobs', async (req, res) => {
    const body = (req.body ?? {}) as { job?: unknown; publish?: unknown };
    const input = parseBody(jobInputSchema, body.job);
    const job = await jobs.create(input, body.publish === true ? 'Published' : 'Draft');
    res.status(201).json({ job: toJobDto(job) });
  });

  router.put('/jobs/:jobId', async (req, res) => {
    const input = parseBody(jobInputSchema, (req.body as { job?: unknown } | undefined)?.job);
    const job = await jobs.update(String(req.params.jobId), input);
    res.json({ job: toJobDto(job) });
  });

  router.post('/jobs/:jobId/status', async (req, res) => {
    const { status } = parseBody(z.object({ status: z.enum(['Published', 'Closed']) }), req.body);
    const job = await jobs.setStatus(String(req.params.jobId), status);
    res.json({ job: toJobDto(job) });
  });

  // ---- Applications ----

  router.get('/applications', async (req, res) => {
    const query = req.query as Record<string, unknown>;
    const [matches, allJobs] = await Promise.all([applications.query(parseFilters(query)), jobs.list()]);

    const requestedSize = Number(query.pageSize);
    const pageSize = (PAGE_SIZES as readonly number[]).includes(requestedSize) ? requestedSize : PAGE_SIZES[0];
    const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
    const requestedPage = Math.floor(Number(query.page));
    const page = Number.isFinite(requestedPage) ? Math.min(Math.max(requestedPage, 1), pageCount) : 1;

    const body: ApplicationListResponse = {
      items: matches.slice((page - 1) * pageSize, page * pageSize),
      total: matches.length,
      page,
      pageSize,
      pageCount,
      allIds: matches.map((app) => app.id),
      jobs: allJobs.map((job) => ({ id: job.id, title: job.title, status: job.status })),
    };
    res.json(body);
  });

  router.post('/applications/bulk-status', async (req, res) => {
    const { ids, status } = parseBody(z.object({ ids: idListSchema, status: statusSchema }), req.body);
    res.json(await applications.update(ids, { status }));
  });

  router.get('/applications/:id', async (req, res) => {
    const id = String(req.params.id);
    const application = await applications.get(id);
    if (!application) throw notFound('This application');
    const [answers, activity, job] = await Promise.all([
      applications.answersByApplication(),
      applications.activityFor(id),
      jobs.get(application.jobId),
    ]);
    const body: ApplicationDetailResponse = {
      application,
      answers: answers.get(id) ?? [],
      activity,
      job: job ? { id: job.id, title: job.title, status: job.status } : null,
    };
    res.json(body);
  });

  router.patch('/applications/:id', async (req, res) => {
    const id = String(req.params.id);
    const patch = parseBody(
      z
        .object({
          status: statusSchema.optional(),
          notes: z
            .string()
            .transform(cleanText)
            .pipe(z.string().max(LIMITS.notes, `Keep notes under ${LIMITS.notes} characters.`))
            .optional(),
        })
        .refine((p) => p.status !== undefined || p.notes !== undefined, 'Nothing to update.'),
      req.body,
    );
    const result = await applications.update([id], patch);
    if (result.notFound.includes(id)) throw notFound('This application');
    res.json({ application: await applications.get(id) });
  });

  router.get('/applications/:id/resume', async (req, res) => {
    const application = await applications.get(String(req.params.id));
    if (!application) throw notFound('This application');
    if (!application.resumeFileId) {
      throw new HttpError(404, 'No resume is on record for this application.', { code: 'resume_missing' });
    }

    let stream;
    try {
      stream = await withRetry(() => storage.drive.downloadFile(application.resumeFileId));
    } catch (err) {
      if (isStorageError(err, 'not_found')) {
        throw new HttpError(404, 'The resume file could not be found in Drive. It may have been moved or deleted.', {
          code: 'resume_missing',
        });
      }
      throw err;
    }

    // The type comes from our own allow-list, never from the stored or uploaded value.
    const extension = resumeExtension(application.resumeFilename);
    const inline = req.query.inline === '1' && extension === 'pdf';
    res.status(200).set({
      'Content-Type': extension ? RESUME_MIME_TYPES[extension] : 'application/octet-stream',
      'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', application.resumeFilename || 'resume'),
      'X-Content-Type-Options': 'nosniff',
    });
    await pipeline(stream, res).catch((err) => {
      // The browser going away mid-download is not an error worth reporting.
      if (!res.destroyed) throw err;
    });
  });

  // ---- Bulk downloads and exports ----

  const selectionSchema = z.object({
    /** Explicit application IDs, or... */
    ids: idListSchema.optional(),
    /** ...the same filters the candidate list uses, meaning "everything that matches". */
    filters: z.record(z.string(), z.string()).optional(),
  });
  type Selection = z.infer<typeof selectionSchema>;

  async function selectApplications(selection: Selection): Promise<ApplicationDto[]> {
    if (selection.ids) {
      const wanted = new Set(selection.ids);
      return (await applications.query(parseFilters({}))).filter((app) => wanted.has(app.id));
    }
    return applications.query(parseFilters(selection.filters ?? {}));
  }

  async function exportLabel(selection: Selection): Promise<string> {
    const jobId = selection.filters?.job;
    const job = jobId && isJobId(jobId) ? await jobs.get(jobId) : null;
    const date = new Date().toISOString().slice(0, 10);
    return `${safeName(job?.title ?? 'candidates', 60, 'candidates')} - ${date}`;
  }

  // Step 1: choose the resumes. Problems are reported here, as normal API errors.
  router.post('/resumes/zip', async (req, res) => {
    const selection = parseBody(selectionSchema, req.body);
    const selected = await selectApplications(selection);
    if (selected.length === 0) {
      throw new HttpError(404, 'No candidates match this selection, so there is nothing to download.', { code: 'empty_selection' });
    }
    if (selected.length > MAX_SELECTION) {
      throw new HttpError(400, `Select at most ${MAX_SELECTION} candidates per download.`);
    }
    const items: ZipItem[] = selected.map((app) => ({
      fileId: app.resumeFileId,
      name: app.resumeFilename || `${safeName(app.fullName, 60, 'Candidate')} - ${app.id}`,
      label: `${app.fullName} (${app.id})`,
    }));
    const filename = `${await exportLabel(selection)} - resumes.zip`;
    res.json({ downloadId: downloads.prepare(items, filename), total: items.length, filename });
  });

  // Step 2: the browser collects the ZIP as an ordinary file download. The ID works once.
  router.get('/resumes/zip/:id', async (req, res) => {
    const downloadId = String(req.params.id);
    const prepared = DownloadTracker.isValidId(downloadId) ? downloads.collect(downloadId) : null;
    if (!prepared) {
      throw new HttpError(404, 'This download link has already been used or has expired. Start the download again.', {
        code: 'download_expired',
      });
    }

    const zip = createResumeZip(storage.drive, prepared.items, (change) => downloads.update(downloadId, change));
    let cancelled = false;
    res.on('close', () => {
      if (!res.writableFinished) {
        cancelled = true;
        zip.abort();
      }
    });

    res.status(200).set({
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition('attachment', prepared.filename),
    });
    zip.stream.pipe(res);

    try {
      await zip.done;
      downloads.finish(downloadId, 'done');
    } catch (err) {
      downloads.finish(downloadId, cancelled ? 'cancelled' : 'failed', 'The download was interrupted.');
      if (!cancelled) console.error(`[zip] Download failed: ${(err as Error).message}`);
      // Headers are already sent; cutting the connection makes the browser report a failed download.
      res.destroy();
    }
  });

  router.get('/downloads/:id', (req, res) => {
    const progress = DownloadTracker.isValidId(req.params.id) ? downloads.get(req.params.id) : null;
    if (!progress) throw notFound('This download');
    res.json(progress);
  });

  router.post('/export', async (req, res) => {
    const selection = parseBody(selectionSchema, req.body);
    const selected = await selectApplications(selection);
    if (selected.length === 0) {
      throw new HttpError(404, 'No candidates match this selection, so there is nothing to export.', { code: 'empty_selection' });
    }
    const answers = await applications.answersByApplication();

    // One column per custom question across the exported applications.
    const questionColumns = new Map<string, string>();
    for (const app of selected) {
      for (const answer of answers.get(app.id) ?? []) questionColumns.set(answer.questionId, answer.question);
    }
    const questionIds = [...questionColumns.keys()];

    const siteUrl = publicBaseUrl(ctx, req);
    const localTime = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const formatTime = (iso: string) => {
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? iso : localTime.format(date).replace(',', '');
    };

    const headers = [
      'Application ID',
      'Job ID',
      'Job Title',
      'Candidate Name',
      'Email',
      'Phone',
      'Current Location',
      'CTC Currency',
      'Current Annual CTC',
      'Experience Range',
      'Exact Experience (Years)',
      'LinkedIn URL',
      'Status',
      `Submitted At (${config.timezone})`,
      'Internal Notes',
      ...questionIds.map((id) => questionColumns.get(id) ?? id),
      'Resume Filename',
      'Resume Drive File ID',
      'Resume Link (admin sign-in required)',
    ];
    const rows = selected.map((app) => {
      const byQuestion = new Map((answers.get(app.id) ?? []).map((a) => [a.questionId, a.answer]));
      return [
        app.id,
        app.jobId,
        app.jobTitle,
        app.fullName,
        app.email,
        app.phone,
        app.location,
        app.ctcCurrency,
        app.ctcAmount ?? '',
        app.experienceRange,
        app.experienceYears,
        app.linkedinUrl,
        app.status,
        formatTime(app.submittedAt),
        app.notes,
        ...questionIds.map((id) => byQuestion.get(id) ?? ''),
        app.resumeFilename,
        app.resumeFileId,
        `${siteUrl}/admin/applications/${app.id}`,
      ];
    });

    res.status(200).set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': contentDisposition('attachment', `${await exportLabel(selection)} - applicants.csv`),
    });
    res.send(toCsv(headers, rows));
  });

  return router;
}
