import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app';
import { loadConfig, type AppConfig } from '../server/config';
import type { AppContext } from '../server/context';
import type { EmailTransport } from '../server/email';
import { createFormToken } from '../server/form-token';
import { ALL_TABLES } from '../server/schema';
import type { Storage } from '../server/storage';
import { LOCAL_ROOT_FOLDER_ID, LocalDriveBackend, LocalSheetBackend } from '../server/storage/local';
import { retrySettings } from '../server/storage/retry';
import { TableStore } from '../server/storage/tables';
import type { CellValue, DriveBackend, SheetBackend } from '../server/storage/types';

// Keep retry backoff out of the test run time.
retrySettings.baseDelayMs = 1;
retrySettings.maxDelayMs = 2;

export const ADMIN_PASSWORD = 'correct-horse-battery-staple';

export interface TestApp {
  baseUrl: string;
  ctx: AppContext;
  config: AppConfig;
  dataDir: string;
  sheet: SheetBackend;
  drive: DriveBackend;
  /** Raw contents of a worksheet as stored, header row first. */
  rawTab(name: string): Promise<CellValue[][]>;
  /** Cookie header for a signed-in administrator. */
  login(): Promise<string>;
  /** A form token old enough to pass the minimum-time check. */
  formToken(jobId: string): string;
  close(): Promise<void>;
}

export interface TestAppOptions {
  env?: Record<string, string>;
  /** Wrap the backends, for example to inject failures. */
  wrapSheet?: (backend: SheetBackend) => SheetBackend;
  wrapDrive?: (backend: DriveBackend) => DriveBackend;
  /** Stands in for Resend. Emails are only sent when the email settings are also in `env`. */
  emailTransport?: EmailTransport;
}

export async function startTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'job-review-test-'));
  const config = loadConfig({
    STORAGE_BACKEND: 'local',
    LOCAL_DATA_DIR: dataDir,
    ADMIN_PASSWORD,
    SESSION_SECRET: 'test-secret-test-secret-test-secret-1234',
    COMPANY_NAME: 'Test Co',
    SUBMISSIONS_PER_IP_PER_HOUR: '1000',
    ...options.env,
  });

  const localSheet = new LocalSheetBackend(dataDir);
  const localDrive = new LocalDriveBackend(dataDir);
  const sheet = options.wrapSheet ? options.wrapSheet(localSheet) : localSheet;
  const drive = options.wrapDrive ? options.wrapDrive(localDrive) : localDrive;
  const storage: Storage = {
    kind: 'local',
    // No read cache: tests edit the "spreadsheet" directly and expect to see it at once.
    tables: new TableStore(sheet, ALL_TABLES, 0),
    drive,
    rootFolderId: LOCAL_ROOT_FOLDER_ID,
  };

  const { app, ctx } = await createApp({ config, storage, client: 'none', emailTransport: options.emailTransport });
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl,
    ctx,
    config,
    dataDir,
    sheet: localSheet,
    drive: localDrive,
    async rawTab(name) {
      // The file does not exist until the app first touches storage.
      const text = await readFile(path.join(dataDir, 'sheets.json'), 'utf8').catch(() => '{}');
      return (JSON.parse(text) as Record<string, CellValue[][]>)[name] ?? [];
    },
    async login() {
      const res = await fetch(`${baseUrl}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: ADMIN_PASSWORD }),
      });
      if (res.status !== 204) throw new Error(`Login failed with status ${res.status}`);
      return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    },
    formToken(jobId) {
      return createFormToken(config.sessionSecret, jobId, Date.now() - 10_000);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Rows of a worksheet as objects keyed by header text. */
export function asObjects(tab: CellValue[][]): Record<string, CellValue>[] {
  const [header = [], ...rows] = tab;
  return rows.map((row) => Object.fromEntries(header.map((h, i) => [String(h), row[i] ?? ''])));
}

export const pdfBytes = (text = 'resume') => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`);
export const docBytes = () =>
  Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64, 1)]);
export const docxBytes = () =>
  Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....[Content_Types].xml....word/document.xml....')]);

export const sampleJob = {
  title: 'Senior Backend Engineer',
  description: 'Build and run our APIs.',
  responsibilities: '- Design services\n- Review code',
  requirements: '- 5+ years of experience',
  experienceCriteria: '5-8 years',
  questions: [
    { label: 'What is your notice period?', type: 'select', required: true, options: ['Immediate', '30 days', '60 days'] },
    { label: 'Are you willing to relocate?', type: 'yes_no', required: false, options: [] },
    { label: 'Why do you want this role?', type: 'long_text', required: false, options: [] },
  ],
};

export async function createJob(
  app: TestApp,
  cookie: string,
  overrides: Partial<typeof sampleJob> = {},
  publish = true,
): Promise<{ id: string; questions: { id: string; label: string }[] }> {
  const res = await fetch(`${app.baseUrl}/api/admin/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ job: { ...sampleJob, ...overrides }, publish }),
  });
  if (res.status !== 201) throw new Error(`Job creation failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { job: { id: string; questions: { id: string; label: string }[] } }).job;
}

export interface ApplicantOverrides {
  fields?: Record<string, string>;
  answers?: Record<string, string>;
  file?: { name: string; data: Buffer } | null;
  token?: string;
}

export function applicationForm(app: TestApp, job: { id: string; questions: { id: string }[] }, o: ApplicantOverrides = {}): FormData {
  const form = new FormData();
  const fields: Record<string, string> = {
    fullName: 'Asha Rao',
    email: 'asha.rao@example.com',
    phone: '+91 98765 43210',
    location: 'Bengaluru',
    ctcCurrency: 'INR',
    ctcAmount: '1800000',
    experienceRange: '5-8',
    experienceYears: '6',
    linkedinUrl: 'linkedin.com/in/asha-rao',
    formToken: o.token ?? app.formToken(job.id),
    ...o.fields,
  };
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const firstQuestion = job.questions[0]?.id;
  form.set('answers', JSON.stringify(o.answers ?? (firstQuestion ? { [firstQuestion]: '30 days' } : {})));
  const file = o.file === undefined ? { name: 'Asha Resume.pdf', data: pdfBytes() } : o.file;
  if (file) form.set('resume', new Blob([new Uint8Array(file.data)]), file.name);
  return form;
}

export function submit(app: TestApp, job: { id: string; questions: { id: string }[] }, o: ApplicantOverrides = {}): Promise<Response> {
  return fetch(`${app.baseUrl}/api/public/jobs/${job.id}/applications`, {
    method: 'POST',
    body: applicationForm(app, job, o),
  });
}
