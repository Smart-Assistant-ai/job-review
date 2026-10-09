import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A signed, time-stamped token embedded in each application form.
 *
 * It proves the submitter actually loaded the form for that job, and lets the
 * server reject submissions that arrive faster than a person could type —
 * a cheap, invisible barrier against scripted spam.
 */

const MIN_AGE_MS = 3_000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`form-token:${payload}`).digest('base64url');
}

export function createFormToken(secret: string, jobId: string, now = Date.now()): string {
  const payload = `${jobId}.${now}`;
  return `${payload}.${sign(secret, payload)}`;
}

export type FormTokenResult = 'ok' | 'invalid' | 'too_fast' | 'expired';

export function verifyFormToken(secret: string, jobId: string, token: unknown, now = Date.now()): FormTokenResult {
  if (typeof token !== 'string') return 'invalid';
  const parts = token.split('.');
  if (parts.length !== 3) return 'invalid';
  const [tokenJobId, issuedAtRaw, signature] = parts;
  const expected = Buffer.from(sign(secret, `${tokenJobId}.${issuedAtRaw}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'invalid';
  if (tokenJobId !== jobId) return 'invalid';
  const age = now - Number(issuedAtRaw);
  if (!Number.isFinite(age)) return 'invalid';
  if (age < MIN_AGE_MS) return 'too_fast';
  if (age > MAX_AGE_MS) return 'expired';
  return 'ok';
}
