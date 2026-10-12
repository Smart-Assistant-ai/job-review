import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../server/config';
import { toCsv } from '../server/csv';
import { createFormToken, verifyFormToken } from '../server/form-token';
import { createStorage } from '../server/storage';
import { columnLetters, createGoogleClients, toStorageError } from '../server/storage/google';
import { StorageError } from '../server/storage/types';
import { buildResumeFilename, safeName, validateResume } from '../server/resume-file';
import { devProxyTarget, normalizeBasePath, resolveApiRoot } from '../shared/api-root';
import { EXPERIENCE_RANGES, type Question } from '../shared/constants';
import { jobInputSchema } from '../shared/job-schema';
import {
  normalizeLinkedinUrl,
  parseAmount,
  validateApplication,
  validateBasicDetails,
  validateProfessionalDetails,
  validateResumeChoice,
  type ApplicationFormValues,
} from '../shared/validation';
import { docBytes, docxBytes, pdfBytes } from './helpers';

const valid: ApplicationFormValues = {
  fullName: 'Asha Rao',
  email: 'Asha.Rao@Example.com',
  phone: '+91 98765 43210',
  location: 'Bengaluru',
  ctcCurrency: 'INR',
  ctcAmount: '18,00,000',
  experienceRange: '3-5',
  experienceYears: '4',
  linkedinUrl: 'www.linkedin.com/in/asha-rao/?utm_source=share',
  answers: {},
};

describe('experience ranges', () => {
  it('offers the exact-year follow-up choices for each range', () => {
    const years = Object.fromEntries(EXPERIENCE_RANGES.map((r) => [r.label, r.years]));
    expect(years['Less than 1 year']).toEqual([]);
    expect(years['1–3 years']).toEqual(['1', '2', '3']);
    expect(years['3–5 years']).toEqual(['3', '4', '5']);
    expect(years['5–8 years']).toEqual(['5', '6', '7', '8']);
    expect(years['8+ years'][0]).toBe('8');
    expect(years['8+ years'].at(-1)).toBe('20+');
  });

  it('requires an exact year only when the range has a follow-up', () => {
    expect(validateProfessionalDetails({ ...valid, experienceYears: '' }, []).experienceYears).toBeDefined();
    expect(validateProfessionalDetails({ ...valid, experienceYears: '7' }, []).experienceYears).toBeDefined();
    expect(validateProfessionalDetails({ ...valid, experienceYears: '5' }, [])).toEqual({});
    expect(validateProfessionalDetails({ ...valid, experienceRange: 'lt1', experienceYears: '' }, [])).toEqual({});
    expect(validateProfessionalDetails({ ...valid, experienceRange: '', experienceYears: '' }, []).experienceRange).toBeDefined();
  });

  it('discards a stale exact year when the chosen range has no follow-up', () => {
    const result = validateApplication({ ...valid, experienceRange: 'lt1', experienceYears: '4' }, []);
    expect(result.ok && result.data.experienceYears).toBe('');
  });
});

describe('application validation', () => {
  it('accepts a complete application and normalises the values', () => {
    const result = validateApplication(valid, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.email).toBe('asha.rao@example.com');
    expect(result.data.ctcAmount).toBe(1800000);
    expect(result.data.linkedinUrl).toBe('https://www.linkedin.com/in/asha-rao');
    expect(result.data.experienceRange.label).toBe('3–5 years');
  });

  it('reports each missing basic detail next to its field', () => {
    const errors = validateBasicDetails({ ...valid, fullName: ' ', email: 'not-an-email', phone: 'call me', location: '' });
    expect(Object.keys(errors).sort()).toEqual(['email', 'fullName', 'location', 'phone']);
  });

  it.each(['a@b', 'a b@c.com', '@example.com', 'a@.com', 'a@example..com'])('rejects email %s', (email) => {
    expect(validateBasicDetails({ ...valid, email }).email).toBeDefined();
  });

  it.each(['12', '+91', '98765-43210-98765-43210', '98765 43210 ext'])('rejects phone %s', (phone) => {
    expect(validateBasicDetails({ ...valid, phone }).phone).toBeDefined();
  });

  it('parses amounts and rejects anything that is not a plain number', () => {
    expect(parseAmount('0')).toBe(0);
    expect(parseAmount('1200000.50')).toBe(1200000.5);
    expect(parseAmount('12 LPA')).toBeNull();
    expect(parseAmount('-5')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('1e9')).toBeNull();
  });

  it('only accepts LinkedIn profile URLs', () => {
    expect(normalizeLinkedinUrl('https://in.linkedin.com/in/someone')).toBe('https://in.linkedin.com/in/someone');
    expect(normalizeLinkedinUrl('https://linkedin.com')).toBeNull();
    expect(normalizeLinkedinUrl('https://evil.example/linkedin.com/in/x')).toBeNull();
    expect(normalizeLinkedinUrl('https://linkedin.com.evil.example/in/x')).toBeNull();
    expect(normalizeLinkedinUrl('javascript:alert(1)')).toBeNull();
  });

  const questions: Question[] = [
    { id: 'q1', label: 'Notice period?', type: 'select', required: true, options: ['Immediate', '30 days'] },
    { id: 'q2', label: 'Relocate?', type: 'yes_no', required: false, options: [] },
    { id: 'q3', label: 'Why?', type: 'short_text', required: false, options: [] },
  ];

  it('validates job-specific questions', () => {
    expect(validateProfessionalDetails(valid, questions)['answers.q1']).toBe('This question is required.');
    expect(validateProfessionalDetails({ ...valid, answers: { q1: '90 days' } }, questions)['answers.q1']).toBeDefined();
    expect(validateProfessionalDetails({ ...valid, answers: { q1: 'Immediate', q2: 'Maybe' } }, questions)['answers.q2']).toBeDefined();
    expect(validateProfessionalDetails({ ...valid, answers: { q1: 'Immediate', q3: 'x'.repeat(301) } }, questions)['answers.q3']).toBeDefined();
    const ok = validateApplication({ ...valid, answers: { q1: 'Immediate', q2: 'Yes', ignored: 'x' } }, questions);
    expect(ok.ok && ok.data.answers).toEqual([
      { questionId: 'q1', question: 'Notice period?', answer: 'Immediate' },
      { questionId: 'q2', question: 'Relocate?', answer: 'Yes' },
    ]);
  });

  it('strips control characters from text input', () => {
    const result = validateApplication({ ...valid, fullName: 'Asha\u0000\u0007  Rao\n' }, []);
    expect(result.ok && result.data.fullName).toBe('Asha Rao');
  });
});

describe('resume files', () => {
  const max = 1024 * 1024;

  it('accepts real PDF, DOC and DOCX content', () => {
    expect(validateResume({ originalName: 'cv.PDF', data: pdfBytes() }, max).ok).toBe(true);
    expect(validateResume({ originalName: 'cv.doc', data: docBytes() }, max).ok).toBe(true);
    expect(validateResume({ originalName: 'cv.docx', data: docxBytes() }, max).ok).toBe(true);
  });

  it('rejects other types, empty files, oversized files and disguised content', () => {
    expect(validateResume(null, max).ok).toBe(false);
    expect(validateResume({ originalName: 'cv.exe', data: pdfBytes() }, max).ok).toBe(false);
    expect(validateResume({ originalName: 'cv.pdf.html', data: pdfBytes() }, max).ok).toBe(false);
    expect(validateResume({ originalName: 'cv.pdf', data: Buffer.alloc(0) }, max).ok).toBe(false);
    expect(validateResume({ originalName: 'cv.pdf', data: Buffer.concat([pdfBytes(), Buffer.alloc(max)]) }, max).ok).toBe(false);
    expect(validateResume({ originalName: 'cv.pdf', data: Buffer.from('<html><script>alert(1)</script>') }, max).ok).toBe(false);
    expect(validateResume({ originalName: 'cv.docx', data: pdfBytes() }, max).ok).toBe(false);
    expect(validateResume({ originalName: 'cv.doc', data: docxBytes() }, max).ok).toBe(false);
  });

  it('checks the chosen file in the browser before upload', () => {
    expect(validateResumeChoice(null, max)).toBeTruthy();
    expect(validateResumeChoice({ name: 'photo.png', size: 10 }, max)).toBeTruthy();
    expect(validateResumeChoice({ name: 'cv.pdf', size: max + 1 }, max)).toContain('1 MB');
    expect(validateResumeChoice({ name: 'cv.docx', size: 10 }, max)).toBeNull();
  });

  it('builds unique, filesystem-safe file names', () => {
    expect(buildResumeFilename('Asha Rao', 'APP-ABC123', 'pdf')).toBe('Asha Rao - APP-ABC123.pdf');
    expect(buildResumeFilename('../../etc/passwd', 'APP-ABC123', 'pdf')).toBe('etc passwd - APP-ABC123.pdf');
    expect(buildResumeFilename('<>:"|?*', 'APP-ABC123', 'docx')).toBe('Candidate - APP-ABC123.docx');
    expect(buildResumeFilename('José Ñandú 李', 'APP-ABC123', 'doc')).toBe('José Ñandú 李 - APP-ABC123.doc');
    expect(safeName('a'.repeat(200), 60, 'x').length).toBe(60);
  });
});

describe('CSV export', () => {
  it('quotes special characters and neutralises formulas', () => {
    const csv = toCsv(['Name', 'Note', 'Amount'], [
      ['Rao, Asha', 'said "hi"\nthen left', 1200000],
      ['=HYPERLINK("http://evil","x")', '+1+1', -5],
      ['@SUM(A1)', '-2+3', ''],
    ]);
    expect(csv.startsWith('﻿Name,Note,Amount\r\n')).toBe(true);
    expect(csv).toContain('"Rao, Asha","said ""hi""\nthen left",1200000\r\n');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")",'+1+1,-5`);
    expect(csv).toContain(`'@SUM(A1),'-2+3,`);
    expect(csv.startsWith('﻿')).toBe(true);
  });
});

describe('form tokens', () => {
  const secret = 'a'.repeat(40);
  const now = 1_700_000_000_000;

  it('accepts a token for the same job after a few seconds', () => {
    const token = createFormToken(secret, 'job1234567', now - 10_000);
    expect(verifyFormToken(secret, 'job1234567', token, now)).toBe('ok');
  });

  it('rejects instant submissions, other jobs, tampering, other secrets and old tokens', () => {
    const token = createFormToken(secret, 'job1234567', now);
    expect(verifyFormToken(secret, 'job1234567', token, now + 500)).toBe('too_fast');
    expect(verifyFormToken(secret, 'otherjob99', token, now + 10_000)).toBe('invalid');
    expect(verifyFormToken(secret, 'job1234567', token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), now + 10_000)).toBe('invalid');
    expect(verifyFormToken('b'.repeat(40), 'job1234567', token, now + 10_000)).toBe('invalid');
    expect(verifyFormToken(secret, 'job1234567', token, now + 8 * 24 * 3600 * 1000)).toBe('expired');
    expect(verifyFormToken(secret, 'job1234567', undefined, now)).toBe('invalid');
    expect(verifyFormToken(secret, 'job1234567', 'a.b', now)).toBe('invalid');
  });
});

describe('job validation', () => {
  const base = { title: 'Engineer', description: 'Do things', responsibilities: '', requirements: '', experienceCriteria: '', questions: [] };

  it('requires a title and description', () => {
    expect(jobInputSchema.safeParse({ ...base, title: ' ' }).success).toBe(false);
    expect(jobInputSchema.safeParse({ ...base, description: '' }).success).toBe(false);
    expect(jobInputSchema.safeParse(base).success).toBe(true);
  });

  it('requires at least two distinct options for dropdown questions', () => {
    const q = (options: string[]) => ({ label: 'Pick one', type: 'select', required: true, options });
    expect(jobInputSchema.safeParse({ ...base, questions: [q(['A', 'A', ' '])] }).success).toBe(false);
    const ok = jobInputSchema.safeParse({ ...base, questions: [q(['A', 'B', 'A'])] });
    expect(ok.success && ok.data.questions[0].options).toEqual(['A', 'B']);
  });

  it('caps the number of questions', () => {
    const many = Array.from({ length: 21 }, () => ({ label: 'Question?', type: 'short_text', required: false, options: [] }));
    expect(jobInputSchema.safeParse({ ...base, questions: many }).success).toBe(false);
  });
});

describe('configuration', () => {
  const base = { STORAGE_BACKEND: 'local', SESSION_SECRET: 's'.repeat(32) };

  it('applies defaults', () => {
    const config = loadConfig(base);
    expect(config.maxResumeBytes).toBe(5 * 1024 * 1024);
    expect(config.defaultCurrency).toBe('INR');
    expect(config.storageBackend).toBe('local');
  });

  it('makes the resume size limit configurable', () => {
    expect(loadConfig({ ...base, MAX_RESUME_SIZE_MB: '2' }).maxResumeBytes).toBe(2 * 1024 * 1024);
    expect(() => loadConfig({ ...base, MAX_RESUME_SIZE_MB: 'big' })).toThrow();
  });

  it('refuses to start in production without a session secret', () => {
    expect(() => loadConfig({ STORAGE_BACKEND: 'local', NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  it('lists which Google settings are missing', () => {
    const config = loadConfig({ SESSION_SECRET: 's'.repeat(32), GOOGLE_CLIENT_ID: 'x' });
    expect(config.storageBackend).toBe('google');
    expect(config.google).toBeNull();
    expect(config.googleMissing).toContain('GOOGLE_REFRESH_TOKEN');
    expect(config.googleMissing).not.toContain('GOOGLE_CLIENT_ID');
  });
});

describe('site address settings', () => {
  it('turns VITE_BASE_PATH into the folder the site is served from', () => {
    expect(normalizeBasePath(undefined)).toBe('/');
    expect(normalizeBasePath('')).toBe('/');
    expect(normalizeBasePath('job-applicants-review')).toBe('/job-applicants-review/');
    expect(normalizeBasePath('/job-applicants-review/')).toBe('/job-applicants-review/');
    expect(normalizeBasePath(' a/b ')).toBe('/a/b/');
  });

  it('works out the API address from VITE_BASE_API_URL', () => {
    // Not set: same address as the site, inside its folder.
    expect(resolveApiRoot(undefined, '/', 'https:')).toBe('/api');
    expect(resolveApiRoot('', '/job-applicants-review/', 'https:')).toBe('/job-applicants-review/api');
    // Host and port only: uses whatever the page itself was loaded over.
    expect(resolveApiRoot('dev.aiassistant.co:8799', '/job-applicants-review/', 'https:')).toBe('https://dev.aiassistant.co:8799/api');
    expect(resolveApiRoot('localhost:8799', '/', 'http:')).toBe('http://localhost:8799/api');
    // Full address, with or without a trailing slash or its own path.
    expect(resolveApiRoot('https://api.example.com/', '/x/', 'http:')).toBe('https://api.example.com/api');
    expect(resolveApiRoot('http://example.com/hiring', '/', 'https:')).toBe('http://example.com/hiring/api');
  });

  it('works out where the frontend-only dev server forwards API calls', () => {
    expect(devProxyTarget(undefined)).toBeNull();
    expect(devProxyTarget('  ')).toBeNull();
    expect(devProxyTarget('dev.aiassistant.co:8799')).toBe('http://dev.aiassistant.co:8799');
    expect(devProxyTarget('https://dev.aiassistant.co/')).toBe('https://dev.aiassistant.co');
    expect(devProxyTarget('http://localhost:8799')).toBe('http://localhost:8799');
  });

  it('reads the sub-folder and origin from APP_BASE_URL', () => {
    const base = { STORAGE_BACKEND: 'local', SESSION_SECRET: 's'.repeat(32) };
    const sub = loadConfig({ ...base, APP_BASE_URL: 'https://dev.aiassistant.co/job-applicants-review/' });
    expect(sub.appBaseUrl).toBe('https://dev.aiassistant.co/job-applicants-review');
    expect(sub.appOrigin).toBe('https://dev.aiassistant.co');
    expect(sub.basePath).toBe('/job-applicants-review');
    const root = loadConfig({ ...base, APP_BASE_URL: 'https://careers.example.com' });
    expect([root.appBaseUrl, root.basePath]).toEqual(['https://careers.example.com', '']);
    expect(loadConfig(base).appOrigin).toBeNull();
    expect(() => loadConfig({ ...base, APP_BASE_URL: 'dev.aiassistant.co' })).toThrow(/APP_BASE_URL/);
    expect(() => loadConfig({ ...base, TLS_CERT_FILE: 'cert.pem' })).toThrow(/TLS_KEY_FILE/);
    expect(() => loadConfig({ ...base, TLS_CA_FILE: 'bundle.pem' })).toThrow(/TLS_CERT_FILE/);
    const tls = loadConfig({ ...base, TLS_CERT_FILE: '/c/site.crt', TLS_KEY_FILE: '/c/site.key', TLS_CA_FILE: '/c/bundle.crt' }).tls;
    expect(tls).toEqual({ certFile: '/c/site.crt', keyFile: '/c/site.key', caFile: '/c/bundle.crt' });
    expect(loadConfig({ ...base, TLS_CERT_FILE: '/c/site.crt', TLS_KEY_FILE: '/c/site.key' }).tls?.caFile).toBeNull();
  });
});

describe('Google sign-in settings', () => {
  const base = { SESSION_SECRET: 's'.repeat(32), GOOGLE_DRIVE_ROOT_FOLDER_ID: 'folder123', GOOGLE_SHEET_ID: 'sheet123' };
  const FAKE_KEY = '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n';
  let dir: string;
  const file = (name: string) => path.join(dir, name);

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'job-review-keys-'));
    await writeFile(file('good.json'), JSON.stringify({ type: 'service_account', client_email: 'robot@project.iam.gserviceaccount.com', private_key: FAKE_KEY }), { mode: 0o600 });
    await writeFile(file('oauth-client.json'), JSON.stringify({ installed: { client_id: 'x', client_secret: 'y' } }), { mode: 0o600 });
    await writeFile(file('broken.json'), '{ this is not json', { mode: 0o600 });
    await chmod(file('good.json'), 0o600);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('selects the service account when its key file is configured', () => {
    const config = loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_KEY_FILE: 'secrets/key.json' });
    expect(config.googleAuthMode).toBe('service_account');
    expect(config.googleMissing).toEqual([]);
    expect(config.google?.auth).toMatchObject({ mode: 'service_account', keyFile: path.resolve('secrets/key.json') });
    expect(config.google).toMatchObject({ rootFolderId: 'folder123', sheetId: 'sheet123' });
  });

  it('accepts the key as two env values with escaped line breaks', () => {
    const config = loadConfig({
      ...base,
      GOOGLE_SERVICE_ACCOUNT_EMAIL: 'robot@project.iam.gserviceaccount.com',
      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: FAKE_KEY.replace(/\n/g, '\\n'),
    });
    expect(config.google?.auth).toMatchObject({ mode: 'service_account', keyFile: null, privateKey: FAKE_KEY });
  });

  it('lets GOOGLE_AUTH_MODE choose between the two kinds of sign-in', () => {
    const both = { ...base, GOOGLE_SERVICE_ACCOUNT_KEY_FILE: 'key.json', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REFRESH_TOKEN: 'token' };
    expect(loadConfig(both).google?.auth.mode).toBe('service_account');
    expect(loadConfig({ ...both, GOOGLE_AUTH_MODE: 'oauth' }).google?.auth.mode).toBe('oauth');
    expect(loadConfig({ ...both, GOOGLE_AUTH_MODE: 'service-account' }).google?.auth.mode).toBe('service_account');
    expect(() => loadConfig({ ...both, GOOGLE_AUTH_MODE: 'api-key' })).toThrow(/GOOGLE_AUTH_MODE/);
  });

  it('names exactly what is missing for the selected kind of sign-in', () => {
    const serviceAccount = loadConfig({ SESSION_SECRET: 's'.repeat(32), GOOGLE_AUTH_MODE: 'service_account' });
    expect(serviceAccount.google).toBeNull();
    expect(serviceAccount.googleMissing).toEqual(['GOOGLE_SERVICE_ACCOUNT_KEY_FILE', 'GOOGLE_DRIVE_ROOT_FOLDER_ID', 'GOOGLE_SHEET_ID']);
    const oauth = loadConfig({ ...base, GOOGLE_AUTH_MODE: 'oauth', GOOGLE_CLIENT_ID: 'id' });
    expect(oauth.googleMissing).toEqual(['GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']);
    // Half a key pair is not enough.
    expect(loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_EMAIL: 'robot@x.iam.gserviceaccount.com' }).google).toBeNull();
  });

  it('builds clients from a valid key file and reports who it acts as', () => {
    const clients = createGoogleClients({ mode: 'service_account', keyFile: file('good.json'), clientEmail: null, privateKey: null });
    expect(clients.identity).toBe('robot@project.iam.gserviceaccount.com');
    expect(createGoogleClients({ mode: 'oauth', clientId: 'id', clientSecret: 'secret', refreshToken: 'token' }).identity).toBeNull();
  });

  it('explains a missing, broken or wrong key file without revealing its contents', () => {
    const attempt = (keyFile: string) => {
      try {
        createGoogleClients({ mode: 'service_account', keyFile, clientEmail: null, privateKey: null });
        return null;
      } catch (err) {
        return err as StorageError;
      }
    };
    for (const name of ['does-not-exist.json', 'broken.json', 'oauth-client.json']) {
      const err = attempt(file(name));
      expect(err, name).toBeInstanceOf(StorageError);
      expect(err?.kind, name).toBe('config');
      expect(err?.retryable, name).toBe(false);
      expect(err?.message, name).not.toContain('client_secret');
    }
    expect(attempt(file('oauth-client.json'))?.message).toContain('not a service account key');
    expect(() => createGoogleClients({ mode: 'service_account', keyFile: null, clientEmail: 'robot@x', privateKey: 'garbage' })).toThrow(/malformed/);
  });

  it('still starts with a bad key and reports the problem on every storage call', async () => {
    const storage = createStorage(loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_KEY_FILE: file('does-not-exist.json') }));
    await expect(storage.tables.read('Jobs')).rejects.toThrow(/key file could not be read/);
    await expect(storage.drive.findFolder('a', 'b')).rejects.toThrow(/key file could not be read/);
  });

  it('treats "service accounts have no storage" as a setup problem, not as throttling', () => {
    const quota = toStorageError({ status: 403, response: { status: 403, data: { error: { errors: [{ reason: 'storageQuotaExceeded' }] } } } }, 'upload a file to Drive');
    expect(quota.kind).toBe('config');
    expect(quota.retryable).toBe(false);
    expect(quota.message).toContain('Shared Drive');
    expect(quota.message).toContain('GOOGLE_AUTH_MODE=oauth');
    const byMessage = toStorageError({ status: 403, message: 'Service Accounts do not have storage quota. Leverage shared drives' }, 'upload');
    expect(byMessage.kind).toBe('config');
    // Real throttling is still retried.
    expect(toStorageError({ status: 429, response: { status: 429, data: { error: { status: 'RESOURCE_EXHAUSTED' } } } }, 'x').retryable).toBe(true);
  });

  it('gives a specific fix for the most likely first-run problems', () => {
    const disabled = toStorageError(
      { status: 403, message: 'Google Sheets API has not been used in project 123 before or it is disabled.', response: { status: 403, data: { error: { status: 'PERMISSION_DENIED', errors: [{ reason: 'accessNotConfigured' }] } } } },
      'read the spreadsheet',
    );
    expect(disabled.kind).toBe('config');
    expect(disabled.message).toContain('must both be enabled');

    const damagedKey = toStorageError({ code: 'ERR_OSSL_UNSUPPORTED', message: 'error:1E08010C:DECODER routines::unsupported' }, 'sign in');
    expect(damagedKey.kind).toBe('config');
    expect(damagedKey.message).toContain('private key is damaged');

    const revoked = toStorageError({ status: 400, response: { status: 400, data: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } } }, 'sign in');
    expect(revoked.kind).toBe('auth');
    expect(revoked.message).toContain('create a new JSON key');

    const notShared = toStorageError({ status: 404, response: { status: 404, data: { error: { errors: [{ reason: 'notFound' }] } } } }, 'open the folder');
    expect(notShared.kind).toBe('not_found');
  });
});

describe('Google adapter helpers', () => {
  it('converts column numbers to spreadsheet letters', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(columnLetters)).toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('classifies Google errors so only transient ones are retried', () => {
    const err = (status: number | undefined, data?: unknown, extra: object = {}) => ({ status, response: { status, data }, ...extra });
    const reason = (r: string) => ({ error: { errors: [{ reason: r }] } });
    expect(toStorageError(err(429), 'x').kind).toBe('rate_limit');
    expect(toStorageError(err(403, reason('userRateLimitExceeded')), 'x').kind).toBe('rate_limit');
    expect(toStorageError(err(403, JSON.stringify(reason('rateLimitExceeded'))), 'x').kind).toBe('rate_limit');
    expect(toStorageError(err(403, reason('insufficientPermissions')), 'x').kind).toBe('auth');
    expect(toStorageError(err(404), 'x').kind).toBe('not_found');
    expect(toStorageError(err(503), 'x').retryable).toBe(true);
    expect(toStorageError(err(400, reason('badRequest')), 'x').retryable).toBe(false);
    expect(toStorageError({ code: 'ECONNRESET', message: 'socket hang up' }, 'x').kind).toBe('unavailable');
    const revoked = toStorageError(err(400, { error: 'invalid_grant' }), 'x');
    expect(revoked.kind).toBe('auth');
    expect(revoked.message).toContain('google:setup');
  });
});
