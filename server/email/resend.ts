import { EmailSendError, type EmailTransport, type OutgoingEmail, type SendResult } from './transport';

const BATCH_ENDPOINT = 'https://api.resend.com/emails/batch';

/** Most messages Resend accepts in one batch call. */
export const RESEND_MAX_BATCH = 100;

export interface ResendOptions {
  apiKey: string;
  /** Sender, e.g. "Acme Careers <careers@example.com>". Its domain must be verified in Resend. */
  from: string;
  replyTo: string | null;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface ResendErrorBody {
  name?: unknown;
  message?: unknown;
}

interface ResendBatchBody {
  data?: unknown;
  errors?: unknown;
}

/** Sends email through Resend's batch endpoint: one HTTPS call for up to 100 messages. */
export class ResendTransport implements EmailTransport {
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: ResendOptions) {
    this.fetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async sendBatch(emails: OutgoingEmail[], idempotencyKey: string): Promise<SendResult[]> {
    if (emails.length === 0) return [];
    if (emails.length > RESEND_MAX_BATCH) {
      throw new EmailSendError(`A batch holds at most ${RESEND_MAX_BATCH} emails, not ${emails.length}.`, { retryable: false });
    }

    let res: Response;
    try {
      res = await this.fetch(BATCH_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
          // Resend rejects requests that do not identify their client.
          'User-Agent': 'job-review/1.0',
          // A retry of this exact batch within 24 hours is recognised and not sent twice.
          'Idempotency-Key': idempotencyKey,
          // One unusable address must not hold back the rest of the batch.
          'x-batch-validation': 'permissive',
        },
        body: JSON.stringify(emails.map((email) => this.payload(email))),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = (err as Error).name === 'TimeoutError';
      throw new EmailSendError(
        timedOut ? `Resend did not answer within ${this.timeoutMs / 1000} seconds.` : 'Resend could not be reached.',
        { retryable: true },
      );
    }

    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw toSendError(res, body as ResendErrorBody | null);
    return toResults(emails.length, body as ResendBatchBody | null);
  }

  private payload(email: OutgoingEmail): Record<string, unknown> {
    return {
      from: this.options.from,
      to: [email.to],
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(this.options.replyTo ? { reply_to: this.options.replyTo } : {}),
      // Shown in the Resend dashboard, so a message can be traced back to its application.
      tags: [
        { name: 'category', value: 'application_received' },
        { name: 'ref', value: email.ref.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) },
      ],
    };
  }
}

/**
 * Matches the reply to the request. Refused messages are listed with their
 * position in the request; the IDs of the accepted ones follow in request order.
 */
function toResults(count: number, body: ResendBatchBody | null): SendResult[] {
  const refused = new Map<number, string>();
  if (Array.isArray(body?.errors)) {
    for (const entry of body.errors as { index?: unknown; message?: unknown }[]) {
      if (typeof entry?.index === 'number') {
        refused.set(entry.index, typeof entry.message === 'string' ? entry.message : 'Refused by Resend.');
      }
    }
  }
  const ids = Array.isArray(body?.data)
    ? (body.data as { id?: unknown }[]).map((entry) => (typeof entry?.id === 'string' ? entry.id : ''))
    : [];

  const results: SendResult[] = [];
  let next = 0;
  for (let index = 0; index < count; index++) {
    const reason = refused.get(index);
    if (reason !== undefined) results.push({ ok: false, reason });
    else results.push({ ok: true, id: ids[next++] ?? '' });
  }
  return results;
}

function toSendError(res: Response, body: ResendErrorBody | null): EmailSendError {
  const name = typeof body?.name === 'string' ? body.name : '';
  const detail = typeof body?.message === 'string' ? body.message : res.statusText || 'no details given';
  const message = `Resend answered ${res.status}${name ? ` ${name}` : ''}: ${detail}`;

  if (res.status === 429) {
    // A used-up daily or monthly allowance does not come back within a retry window.
    if (name.includes('quota')) return new EmailSendError(message, { retryable: false });
    const seconds = Number(res.headers.get('retry-after'));
    return new EmailSendError(message, {
      retryable: true,
      retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined,
    });
  }
  // The earlier attempt with this key is still being processed.
  if (res.status === 409 && name === 'concurrent_idempotent_requests') return new EmailSendError(message, { retryable: true });
  if (res.status >= 500) return new EmailSendError(message, { retryable: true });
  // Wrong key, unverified sender domain, malformed request: repeating it changes nothing.
  return new EmailSendError(message, { retryable: false });
}
