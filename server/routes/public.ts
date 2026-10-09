import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import type { PublicJobListItem, PublicJobResponse } from '../../shared/types';
import {
  cleanLine,
  formatFileSize,
  validateApplication,
  type ApplicationFormValues,
} from '../../shared/validation';
import type { AppContext } from '../context';
import { HttpError, notFound } from '../errors';
import { createFormToken, verifyFormToken } from '../form-token';
import { isJobId, newApplicationId } from '../ids';
import { validateResume } from '../resume-file';

const HOUR_MS = 60 * 60 * 1000;

function parseAnswers(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => [key, value as string]),
    );
  } catch {
    return {};
  }
}

export function publicRouter(ctx: AppContext): Router {
  const { config, jobs, applications } = ctx;
  const router = Router();

  router.get('/site', (_req, res) => {
    res.json({ companyName: config.companyName });
  });

  router.get('/jobs', async (_req, res) => {
    const open: PublicJobListItem[] = (await jobs.list())
      .filter((job) => job.status === 'Published')
      .map((job) => ({ id: job.id, title: job.title, experienceCriteria: job.experienceCriteria }));
    res.json({ companyName: config.companyName, jobs: open });
  });

  router.get('/jobs/:jobId', async (req, res) => {
    const { jobId } = req.params;
    const job = isJobId(jobId) ? await jobs.get(jobId) : null;
    // Drafts are indistinguishable from jobs that do not exist.
    if (!job || job.status === 'Draft') throw notFound('This job');
    const open = job.status === 'Published';
    const body: PublicJobResponse = {
      companyName: config.companyName,
      job: {
        id: job.id,
        title: job.title,
        description: job.description,
        responsibilities: job.responsibilities,
        requirements: job.requirements,
        experienceCriteria: job.experienceCriteria,
        questions: open ? job.questions : [],
        open,
      },
      form: open
        ? {
            token: createFormToken(config.sessionSecret, job.id),
            maxResumeBytes: config.maxResumeBytes,
            defaultCurrency: config.defaultCurrency,
          }
        : null,
    };
    res.json(body);
  });

  const tooMany = (_req: Request, _res: Response, next: NextFunction) =>
    next(
      new HttpError(429, 'Too many applications have been sent from your network. Please try again later.', {
        code: 'rate_limited',
      }),
    );

  // Caps every attempt, valid or not, to blunt automated abuse.
  const attemptLimiter = rateLimit({
    windowMs: HOUR_MS,
    limit: Math.max(60, config.submissionsPerIpPerHour * 6),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: tooMany,
  });
  // Caps applications actually stored. Failed attempts (typos, wrong file type) are not counted.
  const submissionLimiter = rateLimit({
    windowMs: HOUR_MS,
    limit: config.submissionsPerIpPerHour,
    standardHeaders: false,
    legacyHeaders: false,
    skipFailedRequests: true,
    handler: tooMany,
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxResumeBytes, files: 1, fields: 40, fieldSize: 64 * 1024, parts: 45 },
  }).single('resume');

  const receiveForm = (req: Request, res: Response, next: NextFunction) => {
    upload(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        const message = `This file is too large. The limit is ${formatFileSize(config.maxResumeBytes)}.`;
        return next(new HttpError(413, message, { fieldErrors: { resume: message } }));
      }
      next(new HttpError(400, 'The form could not be read. Please refresh the page and try again.'));
    });
  };

  router.post('/jobs/:jobId/applications', attemptLimiter, submissionLimiter, receiveForm, async (req, res) => {
    const jobId = String(req.params.jobId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const field = (name: string) => (typeof body[name] === 'string' ? (body[name] as string) : '');

    // Hidden field that people never see or fill. Bots that fill every input
    // get a normal-looking success and nothing is stored.
    if (cleanLine(field('website')) !== '') {
      res.status(201).json({ applicationId: newApplicationId() });
      return;
    }

    switch (verifyFormToken(config.sessionSecret, jobId, body.formToken)) {
      case 'ok':
        break;
      case 'too_fast':
        throw new HttpError(429, 'Please take a moment to review your application, then submit again.', {
          code: 'too_fast',
        });
      default:
        throw new HttpError(400, 'This form has expired. Please refresh the page and try again.', {
          code: 'form_expired',
        });
    }

    const job = isJobId(jobId) ? await jobs.get(jobId) : null;
    if (!job || job.status === 'Draft') throw notFound('This job');
    if (job.status !== 'Published') {
      throw new HttpError(410, 'This position is no longer accepting applications.', { code: 'job_closed' });
    }

    const values: ApplicationFormValues = {
      fullName: field('fullName'),
      email: field('email'),
      phone: field('phone'),
      location: field('location'),
      ctcCurrency: field('ctcCurrency'),
      ctcAmount: field('ctcAmount'),
      experienceRange: field('experienceRange'),
      experienceYears: field('experienceYears'),
      linkedinUrl: field('linkedinUrl'),
      answers: parseAnswers(body.answers),
    };
    const validated = validateApplication(values, job.questions);
    const resume = validateResume(
      req.file ? { originalName: req.file.originalname, data: req.file.buffer } : null,
      config.maxResumeBytes,
    );
    if (!validated.ok || !resume.ok) {
      throw new HttpError(422, 'Some details need your attention. Please check the highlighted fields.', {
        code: 'validation',
        fieldErrors: {
          ...(validated.ok ? {} : validated.errors),
          ...(resume.ok ? {} : { resume: resume.error }),
        },
      });
    }

    const { id } = await applications.submit(job, validated.data, resume.resume);
    res.status(201).json({ applicationId: id });
  });

  return router;
}
