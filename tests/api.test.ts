import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { StorageError, type DriveBackend, type SheetBackend } from '../server/storage/types';
import {
  ADMIN_PASSWORD,
  asObjects,
  createJob,
  docxBytes,
  pdfBytes,
  startTestApp,
  submit,
  type TestApp,
  type TestAppOptions,
} from './helpers';

let app: TestApp;
const start = async (options?: TestAppOptions) => (app = await startTestApp(options));
afterEach(() => app?.close());

const json = (cookie: string, body?: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: body === undefined ? undefined : JSON.stringify(body),
});
type Selection = { ids: string[] } | { filters: Record<string, string> };

/** Asks for a ZIP of the selection and returns the download ID from the first step. */
async function prepareZip(cookie: string, selection: Selection): Promise<{ status: number; downloadId: string }> {
  const res = await fetch(`${app.baseUrl}/api/admin/resumes/zip`, json(cookie, selection));
  const body = (await res.json()) as { downloadId?: string };
  return { status: res.status, downloadId: body.downloadId ?? '' };
}

/** Runs both steps of a ZIP download, the way the dashboard does. */
async function zip(cookie: string, selection: Selection, init: RequestInit = {}): Promise<Response> {
  const { status, downloadId } = await prepareZip(cookie, selection);
  expect(status).toBe(200);
  return fetch(`${app.baseUrl}/api/admin/resumes/zip/${downloadId}`, { ...get(cookie), ...init });
}

const get = (cookie: string): RequestInit => ({ headers: { Cookie: cookie } });

async function storedFiles(a: TestApp): Promise<string[]> {
  return readdir(path.join(a.dataDir, 'drive', 'files')).catch(() => []);
}

/** Submits several distinct candidates and returns their application IDs in order. */
async function seed(a: TestApp, job: { id: string; questions: { id: string }[] }, people: Record<string, string>[]) {
  const ids: string[] = [];
  for (const fields of people) {
    const res = await submit(a, job, { fields });
    expect(res.status).toBe(201);
    ids.push(((await res.json()) as { applicationId: string }).applicationId);
  }
  return ids;
}

describe('admin authentication', () => {
  it('rejects every privileged endpoint without a session', async () => {
    await start();
    const endpoints: [string, string][] = [
      ['GET', '/api/admin/overview'],
      ['GET', '/api/admin/jobs/abcdefghij'],
      ['POST', '/api/admin/jobs'],
      ['PUT', '/api/admin/jobs/abcdefghij'],
      ['POST', '/api/admin/jobs/abcdefghij/status'],
      ['GET', '/api/admin/jobs/abcdefghij/email-preview'],
      ['GET', '/api/admin/applications'],
      ['GET', '/api/admin/applications/APP-ABCDEFGHJK'],
      ['PATCH', '/api/admin/applications/APP-ABCDEFGHJK'],
      ['POST', '/api/admin/applications/bulk-status'],
      ['GET', '/api/admin/applications/APP-ABCDEFGHJK/resume'],
      ['POST', '/api/admin/resumes/zip'],
      ['GET', '/api/admin/resumes/zip/11111111-2222-3333-4444-555555555555'],
      ['GET', '/api/admin/downloads/12345678'],
      ['POST', '/api/admin/export'],
      ['GET', '/api/admin/anything-else'],
    ];
    for (const [method, url] of endpoints) {
      const res = await fetch(app.baseUrl + url, { method });
      expect(res.status, `${method} ${url}`).toBe(401);
    }
    const forged = await fetch(`${app.baseUrl}/api/admin/overview`, get('job_applicants_admin_session=eyJhbGciOiJub25lIn0.eyJyb2xlIjoiYWRtaW4ifQ.'));
    expect(forged.status).toBe(401);
  });

  it('signs in with the right password only, and signs out', async () => {
    await start();
    const wrong = await fetch(`${app.baseUrl}/api/admin/login`, json('', { password: 'nope' }));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.getSetCookie()).toEqual([]);

    const cookie = await app.login();
    expect(cookie).toContain('job_applicants_admin_session=');
    expect((await fetch(`${app.baseUrl}/api/admin/overview`, get(cookie))).status).toBe(200);
    const session = (await (await fetch(`${app.baseUrl}/api/admin/session`, get(cookie))).json()) as { authenticated: boolean };
    expect(session.authenticated).toBe(true);

    const out = await fetch(`${app.baseUrl}/api/admin/logout`, json(cookie));
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie()[0]).toMatch(/job_applicants_admin_session=;/);
  });

  it('marks the session cookie HttpOnly and SameSite', async () => {
    await start();
    const res = await fetch(`${app.baseUrl}/api/admin/login`, json('', { password: ADMIN_PASSWORD }));
    const cookie = res.headers.getSetCookie()[0];
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('invalidates sessions signed with a different password or secret', async () => {
    await start();
    const cookie = await app.login();
    await app.close();
    await start({ env: { ADMIN_PASSWORD: 'a-completely-different-password' } });
    expect((await fetch(`${app.baseUrl}/api/admin/overview`, get(cookie))).status).toBe(401);
  });

  it('disables sign-in when the password is missing or too short', async () => {
    await start({ env: { ADMIN_PASSWORD: 'short' } });
    const res = await fetch(`${app.baseUrl}/api/admin/login`, json('', { password: 'short' }));
    expect(res.status).toBe(503);
    const session = (await (await fetch(`${app.baseUrl}/api/admin/session`)).json()) as { loginProblem: string };
    expect(session.loginProblem).toContain('12');
  });

  it('throttles repeated wrong passwords', async () => {
    await start({ env: { LOGIN_ATTEMPTS_PER_15_MIN: '3' } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await fetch(`${app.baseUrl}/api/admin/login`, json('', { password: `wrong-${i}` }))).status);
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
  });

  it('blocks state-changing requests that come from another website', async () => {
    await start();
    const cookie = await app.login();
    const res = await fetch(`${app.baseUrl}/api/admin/jobs`, {
      ...json(cookie, { job: {}, publish: true }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    for (const origin of ['null', 'not a url', `${app.baseUrl}.evil.example`]) {
      const blocked = await fetch(`${app.baseUrl}/api/admin/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
      expect(blocked.status, origin).toBe(403);
    }
    const same = await fetch(`${app.baseUrl}/api/admin/logout`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: app.baseUrl },
    });
    expect(same.status).toBe(204);
  });
});

describe('job management', () => {
  it('creates a draft that is not public, then publishes it at a unique URL', async () => {
    await start();
    const cookie = await app.login();
    const draft = await createJob(app, cookie, {}, false);
    expect((await fetch(`${app.baseUrl}/api/public/jobs/${draft.id}`)).status).toBe(404);

    const publish = await fetch(`${app.baseUrl}/api/admin/jobs/${draft.id}/status`, json(cookie, { status: 'Published' }));
    expect(publish.status).toBe(200);

    const pub = await fetch(`${app.baseUrl}/api/public/jobs/${draft.id}`);
    expect(pub.status).toBe(200);
    const body = (await pub.json()) as { job: { title: string; open: boolean; questions: unknown[] }; form: { token: string } };
    expect(body.job.title).toBe('Senior Backend Engineer');
    expect(body.job.open).toBe(true);
    expect(body.job.questions).toHaveLength(3);
    expect(body.form.token).toContain(draft.id);
    // Internal details never reach the public response.
    expect(JSON.stringify(body)).not.toContain('driveFolderId');

    const other = await createJob(app, cookie, { title: 'Designer' });
    expect(other.id).not.toBe(draft.id);
    const overview = (await (await fetch(`${app.baseUrl}/api/admin/overview`, get(cookie))).json()) as {
      jobs: { id: string; applyUrl: string }[];
      totals: { activeJobs: number };
    };
    expect(overview.totals.activeJobs).toBe(2);
    expect(overview.jobs.find((j) => j.id === draft.id)?.applyUrl).toBe(`${app.baseUrl}/apply/${draft.id}`);
  });

  it('uses the configured public address in application links', async () => {
    await start({ env: { APP_BASE_URL: 'https://careers.example.com/' } });
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const overview = (await (await fetch(`${app.baseUrl}/api/admin/overview`, get(cookie))).json()) as { jobs: { applyUrl: string }[] };
    expect(overview.jobs[0].applyUrl).toBe(`https://careers.example.com/apply/${job.id}`);
  });

  it('edits a job, keeps question IDs stable and persists to the Jobs sheet', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const firstQuestionId = job.questions[0].id;

    const res = await fetch(`${app.baseUrl}/api/admin/jobs/${job.id}`, json(cookie, {
      job: {
        title: 'Staff Backend Engineer',
        description: 'Updated',
        responsibilities: '',
        requirements: '',
        experienceCriteria: '8+ years',
        questions: [
          { id: firstQuestionId, label: 'Notice period in days?', type: 'short_text', required: true, options: ['ignored'] },
          { label: 'Brand new question?', type: 'yes_no', required: false, options: [] },
        ],
      },
    }, 'PUT'));
    expect(res.status).toBe(200);
    const updated = ((await res.json()) as { job: { title: string; questions: { id: string; options: string[] }[] } }).job;
    expect(updated.title).toBe('Staff Backend Engineer');
    expect(updated.questions[0].id).toBe(firstQuestionId);
    expect(updated.questions[0].options).toEqual([]);
    expect(updated.questions[1].id).toMatch(/^q_/);

    const row = asObjects(await app.rawTab('Jobs'))[0];
    expect(row['Title']).toBe('Staff Backend Engineer');
    expect(row['Status']).toBe('Published');
    expect(String(row['Drive Folder ID'])).toMatch(/^local_/);
  });

  it('rejects invalid job details with messages per field', async () => {
    await start();
    const cookie = await app.login();
    const res = await fetch(`${app.baseUrl}/api/admin/jobs`, json(cookie, {
      job: { title: '', description: '', responsibilities: '', requirements: '', experienceCriteria: '', questions: [{ label: 'Pick', type: 'select', required: true, options: ['only one'] }] },
      publish: true,
    }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { fieldErrors: Record<string, string> };
    expect(Object.keys(body.fieldErrors).sort()).toEqual(['description', 'questions.0.options', 'title']);
    expect(asObjects(await app.rawTab('Jobs'))).toHaveLength(0);
  });

  it('stops accepting applications when a job is closed and can reopen it', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    await fetch(`${app.baseUrl}/api/admin/jobs/${job.id}/status`, json(cookie, { status: 'Closed' }));

    const pub = (await (await fetch(`${app.baseUrl}/api/public/jobs/${job.id}`)).json()) as { job: { open: boolean }; form: unknown };
    expect(pub.job.open).toBe(false);
    expect(pub.form).toBeNull();
    expect((await submit(app, job)).status).toBe(410);

    await fetch(`${app.baseUrl}/api/admin/jobs/${job.id}/status`, json(cookie, { status: 'Published' }));
    expect((await submit(app, job)).status).toBe(201);
  });

  it('returns 404 for unknown jobs', async () => {
    await start();
    const cookie = await app.login();
    expect((await fetch(`${app.baseUrl}/api/public/jobs/doesnotexist`)).status).toBe(404);
    expect((await fetch(`${app.baseUrl}/api/public/jobs/..%2F..%2Fetc`)).status).toBe(404);
    expect((await fetch(`${app.baseUrl}/api/admin/jobs/doesnotexist`, get(cookie))).status).toBe(404);
    expect((await fetch(`${app.baseUrl}/api/admin/jobs/doesnotexist/status`, json(cookie, { status: 'Closed' }))).status).toBe(404);
  });
});

describe('submitting an application', () => {
  it('stores the resume in the job folder and the record in the sheets', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const res = await submit(app, job, {
      answers: { [job.questions[0].id]: '30 days', [job.questions[1].id]: 'Yes', [job.questions[2].id]: 'I like\nhard problems' },
    });
    expect(res.status).toBe(201);
    const { applicationId } = (await res.json()) as { applicationId: string };
    expect(applicationId).toMatch(/^APP-[A-Z0-9]{10}$/);

    const [row] = asObjects(await app.rawTab('Applications'));
    expect(row).toMatchObject({
      'Application ID': applicationId,
      'Job ID': job.id,
      'Job Title': 'Senior Backend Engineer',
      'Candidate Name': 'Asha Rao',
      Email: 'asha.rao@example.com',
      Phone: '+91 98765 43210',
      'Current Location': 'Bengaluru',
      'CTC Currency': 'INR',
      'Current Annual CTC': 1800000,
      'Experience Range': '5–8 years',
      'Exact Experience (Years)': '6',
      'LinkedIn URL': 'https://linkedin.com/in/asha-rao',
      'Resume Filename': `Asha Rao - ${applicationId}.pdf`,
      'Resume Type': 'application/pdf',
      'Resume Size (Bytes)': pdfBytes().length,
      Status: 'New',
      'Internal Notes': '',
    });
    expect(new Date(String(row['Submitted At'])).getTime()).toBeGreaterThan(Date.now() - 60_000);

    const answers = asObjects(await app.rawTab('Application Answers'));
    expect(answers.map((a) => [a['Application ID'], a['Question'], a['Answer']])).toEqual([
      [applicationId, 'What is your notice period?', '30 days'],
      [applicationId, 'Are you willing to relocate?', 'Yes'],
      [applicationId, 'Why do you want this role?', 'I like\nhard problems'],
    ]);
    const activity = asObjects(await app.rawTab('Application Activity'));
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ 'Application ID': applicationId, Action: 'Submitted' });

    // The file sits in this job's folder, under Jobs, under the root.
    const index = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(app.dataDir, 'drive', 'index.json'), 'utf8')) as Record<string, { name: string; parentId: string; isFolder: boolean }>;
    const fileId = String(row['Resume File ID']);
    const jobFolder = index[index[fileId].parentId];
    expect(index[fileId].name).toBe(`Asha Rao - ${applicationId}.pdf`);
    expect(jobFolder.name).toBe(`Senior Backend Engineer [${job.id}]`);
    expect(index[jobFolder.parentId].name).toBe('Jobs');
    expect(index[jobFolder.parentId].parentId).toBe('local-root');

    const overview = (await (await fetch(`${app.baseUrl}/api/admin/overview`, get(cookie))).json()) as { jobs: { counts: { total: number; new: number } }[] };
    expect(overview.jobs[0].counts).toMatchObject({ total: 1, new: 1 });
  });

  it('accepts DOC and DOCX resumes and applicants with under a year of experience', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie, { questions: [] });
    const a = await submit(app, job, { answers: {}, file: { name: 'cv.docx', data: docxBytes() }, fields: { email: 'a@example.com', experienceRange: 'lt1', experienceYears: '' } });
    expect(a.status).toBe(201);
    const rows = asObjects(await app.rawTab('Applications'));
    expect(rows[0]['Experience Range']).toBe('Less than 1 year');
    expect(rows[0]['Exact Experience (Years)']).toBe('');
    expect(String(rows[0]['Resume Filename'])).toMatch(/\.docx$/);
  });

  it('returns field-level errors and stores nothing when details are invalid', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const res = await submit(app, job, {
      fields: { fullName: '', email: 'bad', ctcAmount: 'lots', experienceRange: '3-5', experienceYears: '', linkedinUrl: 'https://example.com/me' },
      answers: {},
      file: { name: 'resume.png', data: pdfBytes() },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { fieldErrors: Record<string, string> };
    expect(Object.keys(body.fieldErrors).sort()).toEqual([
      `answers.${job.questions[0].id}`, 'ctcAmount', 'email', 'experienceYears', 'fullName', 'linkedinUrl', 'resume',
    ]);
    expect(await app.rawTab('Applications')).toHaveLength(1);
    expect(await storedFiles(app)).toEqual([]);
  });

  it('rejects a missing resume, disguised content and oversized files', async () => {
    await start({ env: { MAX_RESUME_SIZE_MB: '0.01' } });
    const cookie = await app.login();
    const job = await createJob(app, cookie);

    const none = await submit(app, job, { file: null });
    expect(none.status).toBe(422);
    expect(((await none.json()) as { fieldErrors: Record<string, string> }).fieldErrors.resume).toBe('Attach your resume.');

    const fake = await submit(app, job, { file: { name: 'resume.pdf', data: Buffer.from('MZ this is really an exe') } });
    expect(fake.status).toBe(422);

    const big = await submit(app, job, { file: { name: 'resume.pdf', data: Buffer.concat([pdfBytes(), Buffer.alloc(20_000)]) } });
    expect(big.status).toBe(413);
    expect(((await big.json()) as { fieldErrors: Record<string, string> }).fieldErrors.resume).toContain('too large');

    expect(await app.rawTab('Applications')).toHaveLength(1);
    expect(await storedFiles(app)).toEqual([]);
  });

  it('blocks a second application to the same job from the same email, but not to another job', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const other = await createJob(app, cookie, { title: 'Designer' });

    expect((await submit(app, job)).status).toBe(201);
    const again = await submit(app, job, { fields: { email: '  ASHA.RAO@example.com ' } });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('duplicate');
    expect((await submit(app, other)).status).toBe(201);
    expect((await submit(app, job, { fields: { email: 'someone.else@example.com' } })).status).toBe(201);

    expect(await app.rawTab('Applications')).toHaveLength(4);
    expect(await storedFiles(app)).toHaveLength(3);
  });

  it('stores exactly one record when the same form is submitted several times at once', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const statuses = (await Promise.all(Array.from({ length: 6 }, () => submit(app, job)))).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
    expect(await app.rawTab('Applications')).toHaveLength(2);
    expect(await storedFiles(app)).toHaveLength(1);
  });

  it('handles a burst of different applicants without losing or mixing records', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const responses = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        submit(app, job, { fields: { fullName: `Person ${i}`, email: `person${i}@example.com` }, file: { name: 'cv.pdf', data: pdfBytes(`resume ${i}`) } }),
      ),
    );
    expect(responses.every((r) => r.status === 201)).toBe(true);
    const rows = asObjects(await app.rawTab('Applications'));
    expect(rows).toHaveLength(25);
    expect(new Set(rows.map((r) => r['Application ID'])).size).toBe(25);
    expect(new Set(rows.map((r) => r['Resume File ID'])).size).toBe(25);
    for (const row of rows) {
      expect(String(row['Resume Filename'])).toBe(`${row['Candidate Name']} - ${row['Application ID']}.pdf`);
    }
    // All resumes share one job folder even though the folder was first needed concurrently.
    const index = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(app.dataDir, 'drive', 'index.json'), 'utf8')) as Record<string, { parentId: string; isFolder: boolean }>;
    expect(new Set(rows.map((r) => index[String(r['Resume File ID'])].parentId)).size).toBe(1);
  });

  it('silently discards submissions that fill the hidden honeypot field', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const res = await submit(app, job, { fields: { website: 'http://spam.example' } });
    expect(res.status).toBe(201);
    expect(await app.rawTab('Applications')).toHaveLength(1);
    expect(await storedFiles(app)).toEqual([]);
  });

  it('rejects submissions without a valid form token or sent instantly', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const other = await createJob(app, cookie, { title: 'Designer' });

    expect((await submit(app, job, { token: 'forged.token.value' })).status).toBe(400);
    expect((await submit(app, job, { token: app.formToken(other.id) })).status).toBe(400);
    const fresh = ((await (await fetch(`${app.baseUrl}/api/public/jobs/${job.id}`)).json()) as { form: { token: string } }).form.token;
    expect((await submit(app, job, { token: fresh })).status).toBe(429);
    expect(await app.rawTab('Applications')).toHaveLength(1);
  });

  it('limits how many applications one network address can submit', async () => {
    await start({ env: { SUBMISSIONS_PER_IP_PER_HOUR: '2' } });
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const statuses: number[] = [];
    // A failed attempt in between must not use up the allowance.
    statuses.push((await submit(app, job, { fields: { email: 'bad' } })).status);
    for (let i = 0; i < 4; i++) {
      statuses.push((await submit(app, job, { fields: { email: `p${i}@example.com` } })).status);
    }
    expect(statuses).toEqual([422, 201, 201, 429, 429]);
    expect(await app.rawTab('Applications')).toHaveLength(3);
  });
});

describe('partial failures', () => {
  const failing = <T extends object>(inner: T, overrides: Partial<T>): T =>
    new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop in overrides) return (overrides as Record<string | symbol, unknown>)[prop];
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });

  it('creates no record when the resume upload fails', async () => {
    await start({
      wrapDrive: (d) => failing<DriveBackend>(d, { uploadFile: async () => { throw new StorageError('unknown', 'upload refused'); } }),
    });
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const res = await submit(app, job);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('could not save your application');
    expect(body.error).not.toContain('upload refused');
    expect(await app.rawTab('Applications')).toHaveLength(1);
    expect(await app.rawTab('Application Answers')).toHaveLength(1);
  });

  it('retries a rate-limited upload and still stores a single record', async () => {
    let failures = 2;
    await start({
      wrapDrive: (d) => failing<DriveBackend>(d, {
        uploadFile: async (input) => {
          if (failures-- > 0) throw new StorageError('rate_limit', 'slow down');
          return d.uploadFile(input);
        },
      }),
    });
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    expect((await submit(app, job)).status).toBe(201);
    expect(await app.rawTab('Applications')).toHaveLength(2);
    expect(await storedFiles(app)).toHaveLength(1);
  });

  it('discards the uploaded resume when the spreadsheet write fails', async () => {
    let jobSaved = false;
    await start({
      wrapSheet: (s) => failing<SheetBackend>(s, {
        appendRows: async (appends) => {
          // Let the job row through, then fail application writes.
          if (!jobSaved) { jobSaved = true; return s.appendRows(appends); }
          throw new StorageError('unknown', 'sheet refused the write');
        },
      }),
    });
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const res = await submit(app, job);
    expect(res.status).toBe(503);
    expect(await app.rawTab('Applications')).toHaveLength(1);
    expect(await app.rawTab('Application Answers')).toHaveLength(1);

    const index = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(app.dataDir, 'drive', 'index.json'), 'utf8')) as Record<string, { isFolder: boolean; trashed: boolean }>;
    const files = Object.values(index).filter((item) => !item.isFolder);
    expect(files).toHaveLength(1);
    expect(files[0].trashed).toBe(true);

    // The candidate can simply try again once the problem clears.
    jobSaved = false;
    expect((await submit(app, job)).status).toBe(201);
  });

  it('treats the application as saved when the write succeeded but the reply was lost', async () => {
    let calls = 0;
    await start({
      wrapSheet: (s) => failing<SheetBackend>(s, {
        appendRows: async (appends) => {
          calls += 1;
          await s.appendRows(appends);
          if (calls === 2) throw new StorageError('unavailable', 'connection reset');
        },
      }),
    });
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const res = await submit(app, job);
    expect(res.status).toBe(201);
    expect(await app.rawTab('Applications')).toHaveLength(2);
    const index = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(app.dataDir, 'drive', 'index.json'), 'utf8')) as Record<string, { isFolder: boolean; trashed: boolean }>;
    expect(Object.values(index).filter((i) => !i.isFolder && !i.trashed)).toHaveLength(1);
  });

  it('shows administrators the storage problem instead of a blank failure', async () => {
    await start({
      wrapSheet: (s) => failing<SheetBackend>(s, { readTab: async () => { throw new StorageError('auth', 'Google authorization has expired'); } }),
    });
    const cookie = await app.login();
    const res = await fetch(`${app.baseUrl}/api/admin/overview`, get(cookie));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain('authorization has expired');
  });
});

describe('reviewing candidates', () => {
  const people: Record<string, string>[] = [
    { fullName: 'Asha Rao', email: 'asha@example.com', location: 'Bengaluru', ctcAmount: '1800000', experienceRange: '5-8', experienceYears: '6' },
    { fullName: 'Bilal Khan', email: 'bilal@example.com', location: 'Mumbai', ctcAmount: '900000', experienceRange: '1-3', experienceYears: '2' },
    { fullName: 'Chen Wei', email: 'chen@example.com', location: 'Pune', ctcAmount: '3200000', experienceRange: '8plus', experienceYears: '12' },
    { fullName: 'Divya Nair', email: 'divya@example.com', location: 'Bengaluru', ctcAmount: '60000', ctcCurrency: 'USD', experienceRange: 'lt1', experienceYears: '' },
  ];
  type List = { items: { id: string; fullName: string; status: string }[]; total: number; page: number; pageCount: number; allIds: string[] };
  const list = async (cookie: string, query: string) =>
    (await (await fetch(`${app.baseUrl}/api/admin/applications?${query}`, get(cookie))).json()) as List;
  const names = (l: List) => l.items.map((i) => i.fullName);

  it('searches, filters, sorts and paginates', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const other = await createJob(app, cookie, { title: 'Designer', questions: [] });
    const ids = await seed(app, job, people);
    await seed(app, other, [{ fullName: 'Esha Roy', email: 'esha@example.com' }]);
    await fetch(`${app.baseUrl}/api/admin/applications/${ids[2]}`, json(cookie, { status: 'Shortlisted' }, 'PATCH'));

    expect((await list(cookie, '')).total).toBe(5);
    expect(names(await list(cookie, `job=${job.id}&sort=name&dir=asc`))).toEqual(['Asha Rao', 'Bilal Khan', 'Chen Wei', 'Divya Nair']);
    expect(names(await list(cookie, 'q=BILAL'))).toEqual(['Bilal Khan']);
    expect(names(await list(cookie, 'q=chen%40example.com'))).toEqual(['Chen Wei']);
    expect(names(await list(cookie, 'q=bengaluru&sort=name&dir=asc'))).toEqual(['Asha Rao', 'Divya Nair', 'Esha Roy']);
    expect(names(await list(cookie, 'q=designer'))).toEqual(['Esha Roy']);
    expect(names(await list(cookie, 'status=Shortlisted'))).toEqual(['Chen Wei']);
    expect(names(await list(cookie, 'experience=1-3'))).toEqual(['Bilal Khan']);
    expect(names(await list(cookie, 'experience=lt1'))).toEqual(['Divya Nair']);
    expect(names(await list(cookie, `job=${job.id}&ctcCurrency=INR&ctcMin=1000000&sort=ctc&dir=asc`))).toEqual(['Asha Rao', 'Chen Wei']);
    expect(names(await list(cookie, `job=${job.id}&ctcCurrency=INR&ctcMax=1000000`))).toEqual(['Bilal Khan']);
    expect(names(await list(cookie, 'ctcCurrency=USD'))).toEqual(['Divya Nair']);
    expect(names(await list(cookie, `job=${job.id}&sort=experience&dir=desc`))).toEqual(['Chen Wei', 'Asha Rao', 'Bilal Khan', 'Divya Nair']);
    expect(names(await list(cookie, `job=${job.id}&sort=status&dir=asc`)).at(-1)).toBe('Chen Wei');

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    expect((await list(cookie, `from=${today}&to=${today}`)).total).toBe(5);
    expect((await list(cookie, 'to=2020-01-01')).total).toBe(0);
    expect((await list(cookie, 'from=2999-01-01')).total).toBe(0);

    const page2 = await list(cookie, 'sort=name&dir=asc&pageSize=25&page=2');
    expect(page2.page).toBe(1); // out-of-range pages clamp to the last page
    expect(page2.allIds).toHaveLength(5);
  });

  it('paginates large result sets', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie, { questions: [] });
    await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        submit(app, job, { answers: {}, fields: { fullName: `Person ${String(i).padStart(2, '0')}`, email: `p${i}@example.com` } }),
      ),
    );
    const first = await list(cookie, 'sort=name&dir=asc&pageSize=25');
    expect([first.total, first.pageCount, first.items.length]).toEqual([60, 3, 25]);
    expect(first.items[0].fullName).toBe('Person 00');
    const last = await list(cookie, 'sort=name&dir=asc&pageSize=25&page=3');
    expect(last.items.map((i) => i.fullName)).toEqual(Array.from({ length: 10 }, (_, i) => `Person ${50 + i}`));
    expect((await list(cookie, 'pageSize=100')).items).toHaveLength(60);
  });

  it('saves status changes and notes to the sheet and records the history', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const [id, otherId] = await seed(app, job, people.slice(0, 2));

    const patch = await fetch(`${app.baseUrl}/api/admin/applications/${id}`, json(cookie, { status: 'Under Review', notes: '  Strong systems background.\r\nCall Monday. ' }, 'PATCH'));
    expect(patch.status).toBe(200);

    const rows = asObjects(await app.rawTab('Applications'));
    expect(rows.find((r) => r['Application ID'] === id)).toMatchObject({ Status: 'Under Review', 'Internal Notes': 'Strong systems background.\nCall Monday.' });
    expect(rows.find((r) => r['Application ID'] === otherId)).toMatchObject({ Status: 'New', 'Internal Notes': '' });

    // Still there on a fresh read, as after a page refresh.
    const detail = (await (await fetch(`${app.baseUrl}/api/admin/applications/${id}`, get(cookie))).json()) as {
      application: { status: string; notes: string };
      answers: { question: string; answer: string }[];
      activity: { action: string; detail: string }[];
      job: { title: string };
    };
    expect(detail.application.status).toBe('Under Review');
    expect(detail.application.notes).toContain('Call Monday.');
    expect(detail.answers).toEqual([{ questionId: job.questions[0].id, question: 'What is your notice period?', answer: '30 days' }]);
    expect(detail.job.title).toBe('Senior Backend Engineer');
    expect(detail.activity.map((a) => a.action).sort()).toEqual(['Notes updated', 'Status changed', 'Submitted']);
    expect(detail.activity.find((a) => a.action === 'Status changed')?.detail).toBe('New → Under Review');

    // Saving the same values again changes nothing and logs nothing.
    await fetch(`${app.baseUrl}/api/admin/applications/${id}`, json(cookie, { status: 'Under Review' }, 'PATCH'));
    expect(asObjects(await app.rawTab('Application Activity')).filter((a) => a['Application ID'] === id)).toHaveLength(3);
  });

  it('reports pipeline counts for the dashboard and for the status tabs', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const other = await createJob(app, cookie, { title: 'Designer', questions: [] });
    const ids = await seed(app, job, people);
    const [otherId] = await seed(app, other, [{ fullName: 'Esha Roy', email: 'esha@example.com' }]);
    await fetch(`${app.baseUrl}/api/admin/applications/bulk-status`, json(cookie, { ids: [ids[0], ids[1]], status: 'Shortlisted' }));
    await fetch(`${app.baseUrl}/api/admin/applications/${ids[2]}`, json(cookie, { status: 'Rejected' }, 'PATCH'));
    await fetch(`${app.baseUrl}/api/admin/applications/${otherId}`, json(cookie, { status: 'Under Review' }, 'PATCH'));

    const overview = (await (await fetch(`${app.baseUrl}/api/admin/overview`, get(cookie))).json()) as {
      jobs: { id: string; counts: Record<string, number> }[];
      totals: Record<string, number>;
      recent: { id: string; fullName: string; jobTitle: string; status: string }[];
    };
    expect(overview.jobs.find((j) => j.id === job.id)?.counts).toEqual({ total: 4, new: 1, underReview: 0, shortlisted: 2, rejected: 1, hired: 0 });
    expect(overview.jobs.find((j) => j.id === other.id)?.counts).toEqual({ total: 1, new: 0, underReview: 1, shortlisted: 0, rejected: 0, hired: 0 });
    expect(overview.totals).toEqual({ total: 5, new: 1, underReview: 1, shortlisted: 2, rejected: 1, hired: 0, activeJobs: 2 });
    // Newest first, with the job's current title.
    expect(overview.recent).toHaveLength(5);
    expect(overview.recent[0]).toMatchObject({ id: otherId, fullName: 'Esha Roy', jobTitle: 'Designer', status: 'Under Review' });
    expect(Object.keys(overview.recent[0]).sort()).toEqual(['fullName', 'id', 'jobId', 'jobTitle', 'status', 'submittedAt']);

    type Counted = { total: number; statusCounts: Record<string, number> };
    const counted = async (query: string) => (await (await fetch(`${app.baseUrl}/api/admin/applications?${query}`, get(cookie))).json()) as Counted;
    expect((await counted('')).statusCounts).toEqual({ all: 5, New: 1, 'Under Review': 1, Shortlisted: 2, Rejected: 1, Hired: 0 });
    // Choosing a tab narrows the list but not the numbers shown on the other tabs.
    const shortlisted = await counted(`job=${job.id}&status=Shortlisted`);
    expect(shortlisted.total).toBe(2);
    expect(shortlisted.statusCounts).toEqual({ all: 4, New: 1, 'Under Review': 0, Shortlisted: 2, Rejected: 1, Hired: 0 });
    // Other filters do narrow them.
    expect((await counted('q=bilal')).statusCounts).toMatchObject({ all: 1, Shortlisted: 1, New: 0 });
  });

  it('rejects unknown statuses, overlong notes and unknown applications', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const [id] = await seed(app, job, people.slice(0, 1));
    const url = `${app.baseUrl}/api/admin/applications/${id}`;
    expect((await fetch(url, json(cookie, { status: 'Maybe' }, 'PATCH'))).status).toBe(422);
    expect((await fetch(url, json(cookie, { notes: 'x'.repeat(5001) }, 'PATCH'))).status).toBe(422);
    expect((await fetch(url, json(cookie, {}, 'PATCH'))).status).toBe(422);
    expect((await fetch(`${app.baseUrl}/api/admin/applications/APP-NOTREAL123`, json(cookie, { status: 'Hired' }, 'PATCH'))).status).toBe(404);
    expect((await fetch(`${app.baseUrl}/api/admin/applications/APP-NOTREAL123`, get(cookie))).status).toBe(404);
    expect(asObjects(await app.rawTab('Applications'))[0].Status).toBe('New');
  });

  it('updates the status of many candidates at once', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const ids = await seed(app, job, people);
    const res = await fetch(`${app.baseUrl}/api/admin/applications/bulk-status`, json(cookie, { ids: [ids[0], ids[2], 'APP-MISSING999'], status: 'Rejected' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: [ids[0], ids[2]], notFound: ['APP-MISSING999'] });
    const rows = asObjects(await app.rawTab('Applications'));
    expect(rows.map((r) => r.Status)).toEqual(['Rejected', 'New', 'Rejected', 'New']);
  });

  it('updates the right candidate after the sheet was sorted and a column inserted by hand', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const ids = await seed(app, job, people);

    // Administrator sorts rows in reverse and inserts a column at the front.
    const [header, ...rows] = await app.rawTab('Applications');
    const edited = [['Recruiter', ...header], ...rows.reverse().map((r) => ['Priya', ...r])];
    await app.sheet.writeCells('Applications', edited.flatMap((row, r) => row.map((value, c) => ({ row: r, col: c, value }))));

    await fetch(`${app.baseUrl}/api/admin/applications/${ids[0]}`, json(cookie, { status: 'Hired' }, 'PATCH'));
    const after = asObjects(await app.rawTab('Applications'));
    expect(after.find((r) => r['Application ID'] === ids[0])).toMatchObject({ Status: 'Hired', 'Candidate Name': 'Asha Rao', Recruiter: 'Priya' });
    expect(after.filter((r) => r['Application ID'] !== ids[0]).every((r) => r.Status === 'New')).toBe(true);

    // New applications still line up under the right headers.
    expect((await submit(app, job, { fields: { fullName: 'Late Arrival', email: 'late@example.com' } })).status).toBe(201);
    const last = asObjects(await app.rawTab('Applications')).at(-1)!;
    expect(last).toMatchObject({ Recruiter: '', 'Candidate Name': 'Late Arrival', Email: 'late@example.com', Status: 'New' });
  });

  it('shows statuses typed by hand in the sheet', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const [id] = await seed(app, job, people.slice(0, 1));
    const [header] = await app.rawTab('Applications');
    await app.sheet.writeCells('Applications', [{ row: 1, col: header.indexOf('Status'), value: 'shortlisted' }]);
    const item = (await list(cookie, '')).items.find((i) => i.id === id);
    expect(item?.status).toBe('Shortlisted');
  });
});

describe('resume downloads and exports', () => {
  const people = [
    { fullName: 'Asha Rao', email: 'asha@example.com' },
    { fullName: 'Bilal Khan', email: 'bilal@example.com' },
    { fullName: 'Chen Wei', email: 'chen@example.com' },
  ];

  async function unzip(res: Response): Promise<Record<string, string>> {
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, Buffer.from(data).toString('utf8')]));
  }

  it('downloads one resume as an attachment with a safe content type', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const res0 = await submit(app, job, { file: { name: 'cv.pdf', data: pdfBytes('asha') } });
    const { applicationId } = (await res0.json()) as { applicationId: string };

    const res = await fetch(`${app.baseUrl}/api/admin/applications/${applicationId}/resume`, get(cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain(`attachment; filename="Asha Rao - ${applicationId}.pdf"`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await res.arrayBuffer()).equals(pdfBytes('asha'))).toBe(true);

    const inline = await fetch(`${app.baseUrl}/api/admin/applications/${applicationId}/resume?inline=1`, get(cookie));
    expect(inline.headers.get('content-disposition')).toMatch(/^inline;/);
  });

  it('explains when a resume file is missing from Drive', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const { applicationId } = (await (await submit(app, job)).json()) as { applicationId: string };
    const [fileName] = await storedFiles(app);
    await rm(path.join(app.dataDir, 'drive', 'files', fileName));

    const res = await fetch(`${app.baseUrl}/api/admin/applications/${applicationId}/resume`, get(cookie));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('resume_missing');
  });

  it('downloads selected resumes as a ZIP', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const ids = await seed(app, job, people);
    const files = await unzip(await zip(cookie, { ids: [ids[0], ids[2]] }));
    expect(Object.keys(files).sort()).toEqual([`Asha Rao - ${ids[0]}.pdf`, `Chen Wei - ${ids[2]}.pdf`, '_download-report.txt']);
    expect(files[`Asha Rao - ${ids[0]}.pdf`]).toContain('%PDF-');
    expect(files['_download-report.txt']).toContain('Included: 2');
  });

  it('downloads all resumes for a job, and only shortlisted ones on request', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const other = await createJob(app, cookie, { title: 'Designer', questions: [] });
    const ids = await seed(app, job, people);
    await seed(app, other, [{ fullName: 'Esha Roy', email: 'esha@example.com' }]);
    await fetch(`${app.baseUrl}/api/admin/applications/bulk-status`, json(cookie, { ids: [ids[1]], status: 'Shortlisted' }));

    const all = await zip(cookie, { filters: { job: job.id } });
    expect(all.headers.get('content-disposition')).toContain('Senior Backend Engineer');
    expect(Object.keys(await unzip(all)).filter((n) => n.endsWith('.pdf')).sort()).toEqual(
      [`Asha Rao - ${ids[0]}.pdf`, `Bilal Khan - ${ids[1]}.pdf`, `Chen Wei - ${ids[2]}.pdf`],
    );

    const shortlisted = await unzip(await zip(cookie, { filters: { job: job.id, status: 'Shortlisted' } }));
    expect(Object.keys(shortlisted).filter((n) => n.endsWith('.pdf'))).toEqual([`Bilal Khan - ${ids[1]}.pdf`]);

    // An empty selection is reported in the first step, before any download starts.
    const none = await fetch(`${app.baseUrl}/api/admin/resumes/zip`, json(cookie, { filters: { job: other.id, status: 'Hired' } }));
    expect(none.status).toBe(404);
    expect(((await none.json()) as { code: string }).code).toBe('empty_selection');
  });

  it('skips missing files, lists them in the report and reports progress', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const ids = await seed(app, job, people);
    const rows = asObjects(await app.rawTab('Applications'));
    await rm(path.join(app.dataDir, 'drive', 'files', String(rows[1]['Resume File ID'])));

    const { downloadId } = await prepareZip(cookie, { filters: { job: job.id } });
    const before = await (await fetch(`${app.baseUrl}/api/admin/downloads/${downloadId}`, get(cookie))).json();
    expect(before).toEqual({ state: 'running', total: 3, added: 0, missing: 0 });
    const files = await unzip(await fetch(`${app.baseUrl}/api/admin/resumes/zip/${downloadId}`, get(cookie)));
    expect(Object.keys(files).filter((n) => n.endsWith('.pdf'))).toHaveLength(2);
    expect(files['_download-report.txt']).toContain('Not included: 1');
    expect(files['_download-report.txt']).toContain(`- Bilal Khan (${ids[1]}): file not found in Drive`);

    const progress = await (await fetch(`${app.baseUrl}/api/admin/downloads/${downloadId}`, get(cookie))).json();
    expect(progress).toEqual({ state: 'done', total: 3, added: 2, missing: 1 });
  });

  it('keeps every file when two resumes would have the same name', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const ids = await seed(app, job, people.slice(0, 2));
    // Force identical stored file names, as could happen if the sheet were edited.
    const [header] = await app.rawTab('Applications');
    const col = header.indexOf('Resume Filename');
    await app.sheet.writeCells('Applications', [{ row: 1, col, value: 'resume.pdf' }, { row: 2, col, value: 'resume.pdf' }]);
    const files = await unzip(await zip(cookie, { ids }));
    expect(Object.keys(files).sort()).toEqual(['_download-report.txt', 'resume (2).pdf', 'resume.pdf']);
  });

  it('retries rate-limited Drive downloads while building a ZIP', async () => {
    let throttled = 3;
    await start({
      wrapDrive: (d) => new Proxy(d, {
        get(target, prop) {
          if (prop === 'downloadFile') {
            return async (id: string) => {
              if (throttled-- > 0) throw new StorageError('rate_limit', 'slow down');
              return target.downloadFile(id);
            };
          }
          const value = Reflect.get(target, prop) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }),
    });
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    await seed(app, job, people);
    const files = await unzip(await zip(cookie, { filters: { job: job.id } }));
    expect(Object.keys(files).filter((n) => n.endsWith('.pdf'))).toHaveLength(3);
    expect(files['_download-report.txt']).toContain('Not included: 0');
  });

  it('streams a ZIP of several hundred resumes', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie, { questions: [] });
    const count = 300;
    const resume = Buffer.concat([pdfBytes(), Buffer.alloc(40_000, 7)]);
    for (let batch = 0; batch < count; batch += 50) {
      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          submit(app, job, { answers: {}, fields: { fullName: `Person ${batch + i}`, email: `p${batch + i}@example.com` }, file: { name: 'cv.pdf', data: resume } }),
        ),
      );
      expect(responses.every((r) => r.status === 201)).toBe(true);
    }
    const files = unzipSync(new Uint8Array(await (await zip(cookie, { filters: { job: job.id } })).arrayBuffer()));
    const pdfs = Object.entries(files).filter(([name]) => name.endsWith('.pdf'));
    expect(pdfs).toHaveLength(count);
    expect(pdfs.every(([, data]) => data.length === resume.length)).toBe(true);
  }, 60_000);

  it('stops fetching from Drive when the browser cancels the download', async () => {
    let downloads = 0;
    await start({
      wrapDrive: (d) => new Proxy(d, {
        get(target, prop) {
          if (prop === 'downloadFile') {
            return async (id: string) => {
              downloads += 1;
              await new Promise((r) => setTimeout(r, 40));
              return target.downloadFile(id);
            };
          }
          const value = Reflect.get(target, prop) as unknown;
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }),
    });
    const cookie = await app.login();
    const job = await createJob(app, cookie, { questions: [] });
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => submit(app, job, { answers: {}, fields: { fullName: `P ${i}`, email: `p${i}@example.com` } })),
    );
    const controller = new AbortController();
    const { downloadId } = await prepareZip(cookie, { filters: { job: job.id } });
    const res = await fetch(`${app.baseUrl}/api/admin/resumes/zip/${downloadId}`, { ...get(cookie), signal: controller.signal });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();
    await res.arrayBuffer().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    const seen = downloads;
    expect(seen).toBeLessThan(30);
    await new Promise((r) => setTimeout(r, 300));
    expect(downloads).toBe(seen);
    const progress = (await (await fetch(`${app.baseUrl}/api/admin/downloads/${downloadId}`, get(cookie))).json()) as { state: string };
    expect(progress.state).toBe('cancelled');
  });

  it('exports applicants with their answers as CSV, with formulas neutralised', async () => {
    await start({ env: { APP_BASE_URL: 'https://careers.example.com' } });
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const ids = await seed(app, job, [
      { fullName: 'Asha Rao', email: 'asha@example.com' },
      { fullName: '=HYPERLINK("http://evil.example","Click")', email: 'evil@example.com', location: 'Pune, India' },
    ]);
    await fetch(`${app.baseUrl}/api/admin/applications/${ids[0]}`, json(cookie, { status: 'Shortlisted', notes: 'Line one\nLine "two"' }, 'PATCH'));

    const res = await fetch(`${app.baseUrl}/api/admin/export`, json(cookie, { filters: { job: job.id, sort: 'name', dir: 'desc' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toContain('applicants.csv');
    const csv = await res.text();
    const header = csv.replace('﻿', '').split('\r\n')[0];
    expect(header).toContain('Application ID,Job ID,Job Title,Candidate Name,Email,Phone');
    expect(header).toContain('What is your notice period?');
    expect(header).toContain('Resume Filename,Resume Drive File ID,Resume Link (admin sign-in required)');
    expect(csv).toContain(`${ids[0]},${job.id},Senior Backend Engineer,Asha Rao,asha@example.com,'+91 98765 43210,Bengaluru,INR,1800000,5–8 years,6,https://linkedin.com/in/asha-rao,Shortlisted,`);
    expect(csv).toContain('"Line one\nLine ""two""",30 days,');
    expect(csv).toContain(`https://careers.example.com/admin/applications/${ids[0]}`);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""Click"")"`);
    expect(csv).toContain('"Pune, India"');
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);

    const selected = await (await fetch(`${app.baseUrl}/api/admin/export`, json(cookie, { ids: [ids[1]] }))).text();
    expect(selected.trim().split('\r\n')).toHaveLength(2);
    expect((await fetch(`${app.baseUrl}/api/admin/export`, json(cookie, { filters: { job: job.id, status: 'Hired' } }))).status).toBe(404);
  });
});

describe('download links', () => {
  it('work exactly once and only for a signed-in administrator', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie, { questions: [] });
    await seed(app, job, [{ fullName: 'Asha Rao', email: 'asha@example.com' }]);

    const { downloadId } = await prepareZip(cookie, { filters: { job: job.id } });
    const url = `${app.baseUrl}/api/admin/resumes/zip/${downloadId}`;
    // Knowing the ID is not enough without a session, and trying does not use it up.
    expect((await fetch(url)).status).toBe(401);
    const first = await fetch(url, get(cookie));
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    const second = await fetch(url, get(cookie));
    expect(second.status).toBe(404);
    expect(((await second.json()) as { code: string }).code).toBe('download_expired');
    expect((await fetch(`${app.baseUrl}/api/admin/resumes/zip/not-a-real-id-1234`, get(cookie))).status).toBe(404);
  });

  it('reject malformed selections', async () => {
    await start();
    const cookie = await app.login();
    for (const body of [{ ids: [] }, { ids: ['../../etc/passwd'] }, { ids: 'APP-ABCDEFGHJK' }, { filters: 'job' }]) {
      expect((await fetch(`${app.baseUrl}/api/admin/resumes/zip`, json(cookie, body))).status, JSON.stringify(body)).toBe(422);
      expect((await fetch(`${app.baseUrl}/api/admin/export`, json(cookie, body))).status, JSON.stringify(body)).toBe(422);
    }
  });
});

describe('site hosted in a sub-folder with the API on another port', () => {
  const SITE = 'https://dev.example.com';
  const env = { APP_BASE_URL: `${SITE}/job-applicants-review/` };

  it('builds application and export links under the sub-folder', async () => {
    await start({ env });
    expect(app.config.basePath).toBe('/job-applicants-review');
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const overview = (await (await fetch(`${app.baseUrl}/api/admin/overview`, get(cookie))).json()) as { jobs: { applyUrl: string }[] };
    expect(overview.jobs[0].applyUrl).toBe(`${SITE}/job-applicants-review/apply/${job.id}`);

    const [id] = await seed(app, job, [{ fullName: 'Asha Rao', email: 'asha@example.com' }]);
    const csv = await (await fetch(`${app.baseUrl}/api/admin/export`, json(cookie, { ids: [id] }))).text();
    expect(csv).toContain(`${SITE}/job-applicants-review/admin/applications/${id}`);
  });

  it('lets the site call the API with the session cookie, and no other website', async () => {
    await start({ env });
    const cookie = await app.login();

    const allowed = await fetch(`${app.baseUrl}/api/admin/overview`, { headers: { Cookie: cookie, Origin: SITE } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(SITE);
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
    expect(allowed.headers.get('access-control-expose-headers')).toBe('Content-Disposition');
    expect(allowed.headers.get('vary')).toContain('Origin');

    for (const origin of ['https://evil.example', 'http://dev.example.com', 'https://dev.example.com.evil.example', 'null']) {
      const other = await fetch(`${app.baseUrl}/api/public/site`, { headers: { Origin: origin } });
      expect(other.headers.get('access-control-allow-origin'), origin).toBeNull();
      expect(other.headers.get('access-control-allow-credentials'), origin).toBeNull();
    }
  });

  it('answers the browser\'s permission check before JSON and file-upload requests', async () => {
    await start({ env });
    const preflight = (origin: string, method: string) =>
      fetch(`${app.baseUrl}/api/admin/applications/APP-ABCDEFGHJK`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'content-type' },
      });
    const ok = await preflight(SITE, 'PATCH');
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-methods')).toContain('PATCH');
    expect(ok.headers.get('access-control-allow-headers')).toBe('Content-Type');
    expect(ok.headers.get('access-control-allow-origin')).toBe(SITE);

    const refused = await preflight('https://evil.example', 'PATCH');
    expect(refused.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('accepts sign-in, changes and applications sent from the site, and still blocks other websites', async () => {
    await start({ env });
    const login = await fetch(`${app.baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: SITE },
      body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    expect(login.status).toBe(204);
    expect(login.headers.get('access-control-allow-origin')).toBe(SITE);
    const setCookie = login.headers.getSetCookie()[0];
    // HTTPS site address means the cookie is never sent over plain HTTP.
    expect(setCookie).toMatch(/; Secure/i);
    const cookie = setCookie.split(';')[0];

    const job = await createJob(app, cookie);
    const fromSite = await fetch(`${app.baseUrl}/api/admin/jobs/${job.id}/status`, {
      ...json(cookie, { status: 'Closed' }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: SITE },
    });
    expect(fromSite.status).toBe(200);
    const fromElsewhere = await fetch(`${app.baseUrl}/api/admin/jobs/${job.id}/status`, {
      ...json(cookie, { status: 'Published' }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://evil.example' },
    });
    expect(fromElsewhere.status).toBe(403);

    // Errors are readable by the site too.
    const failed = await fetch(`${app.baseUrl}/api/public/jobs/doesnotexist`, { headers: { Origin: SITE } });
    expect(failed.status).toBe(404);
    expect(failed.headers.get('access-control-allow-origin')).toBe(SITE);
  });

  it('serves the site under the sub-folder and the API both at /api and under the sub-folder', async () => {
    await start({ env });
    const clientDir = await mkdtemp(path.join(os.tmpdir(), 'job-review-client-'));
    await mkdir(path.join(clientDir, 'assets'));
    await writeFile(path.join(clientDir, 'index.html'), '<!doctype html><div id="root"></div>');
    await writeFile(path.join(clientDir, 'assets', 'index-abc123.js'), 'console.log(1)');
    await writeFile(path.join(clientDir, '.htaccess'), 'RewriteEngine On');

    const { app: staticApp } = await createApp({ config: app.config, storage: app.ctx.storage, client: 'static', clientDir });
    const server = staticApp.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const url of ['/job-applicants-review/', '/job-applicants-review/apply/abcdefghij', '/job-applicants-review/admin']) {
        const res = await fetch(base + url);
        expect(res.status, url).toBe(200);
        expect(await res.text()).toContain('<div id="root">');
      }
      expect((await fetch(`${base}/job-applicants-review/assets/index-abc123.js`)).status).toBe(200);
      expect((await fetch(`${base}/job-applicants-review/assets/missing.js`)).status).toBe(404);
      // Server configuration files that happen to be in the folder are not handed out as content.
      expect(await (await fetch(`${base}/job-applicants-review/.htaccess`)).text()).not.toContain('RewriteEngine');

      const root = await fetch(`${base}/`, { redirect: 'manual' });
      expect(root.status).toBe(302);
      expect(root.headers.get('location')).toBe('/job-applicants-review/');
      // Nothing outside the sub-folder is answered by the site.
      expect((await fetch(`${base}/apply/abcdefghij`)).status).toBe(404);

      expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true });
      expect(await (await fetch(`${base}/job-applicants-review/api/health`)).json()).toEqual({ ok: true });
      expect((await fetch(`${base}/job-applicants-review/api/admin/overview`)).status).toBe(401);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(clientDir, { recursive: true, force: true });
    }
  });
});

describe('http hardening', () => {
  it('sets security headers and never caches API responses', async () => {
    await start();
    const res = await fetch(`${app.baseUrl}/api/public/site`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
  });

  it('answers malformed and unknown API requests with clean errors', async () => {
    await start();
    const bad = await fetch(`${app.baseUrl}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    expect(bad.status).toBe(400);
    const missing = await fetch(`${app.baseUrl}/api/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'not_found' });
  });

  it('lists only published jobs publicly', async () => {
    await start();
    const cookie = await app.login();
    await createJob(app, cookie, { title: 'Hidden Draft' }, false);
    const open = await createJob(app, cookie, { title: 'Open Role' });
    const body = (await (await fetch(`${app.baseUrl}/api/public/jobs`)).json()) as { jobs: { id: string; title: string }[] };
    expect(body.jobs).toEqual([{ id: open.id, title: 'Open Role', experienceCriteria: '5-8 years' }]);
  });
});

describe('serving the built React app', () => {
  it('serves the app shell for page URLs, caches hashed assets and returns 404 for missing ones', async () => {
    await start();
    const clientDir = await mkdtemp(path.join(os.tmpdir(), 'job-review-client-'));
    await mkdir(path.join(clientDir, 'assets'));
    await writeFile(path.join(clientDir, 'index.html'), '<!doctype html><div id="root"></div>');
    await writeFile(path.join(clientDir, 'assets', 'index-abc123.js'), 'console.log(1)');

    const { app: staticApp } = await createApp({ config: app.config, storage: app.ctx.storage, client: 'static', clientDir });
    const server = staticApp.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const url of ['/', '/apply/abcdefghij', '/admin/applications?status=New']) {
        const res = await fetch(base + url);
        expect(res.status, url).toBe(200);
        expect(await res.text()).toContain('<div id="root">');
        expect(res.headers.get('cache-control')).toBe('no-cache');
      }
      expect((await fetch(`${base}/admin`)).headers.get('x-robots-tag')).toContain('noindex');

      const asset = await fetch(`${base}/assets/index-abc123.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get('cache-control')).toContain('immutable');

      expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
      // Attempts to climb out of the assets folder are refused outright.
      const traversal = await fetch(`${base}/assets/..%2Findex.html`);
      expect(traversal.status).toBe(403);
      expect(await traversal.text()).not.toContain('<div id="root">');
      // API routes are never swallowed by the app shell.
      const api = await fetch(`${base}/api/unknown`);
      expect(api.status).toBe(404);
      expect(api.headers.get('content-type')).toContain('application/json');
      expect((await fetch(`${base}/api/health`)).status).toBe(200);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(clientDir, { recursive: true, force: true });
    }
  });
});
