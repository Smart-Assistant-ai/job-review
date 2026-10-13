import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../server/config';
import { EmailOutbox, type Settled } from '../server/email/outbox';
import { ResendTransport } from '../server/email/resend';
import { applicationReceivedEmail, greetingName } from '../server/email/templates';
import { EmailSendError, type EmailTransport, type OutgoingEmail, type SendResult } from '../server/email/transport';
import { asObjects, createJob, startTestApp, submit, type TestApp, type TestAppOptions } from './helpers';

/** Stands in for Resend: records every batch call and answers as scripted, or accepts everything. */
class FakeTransport implements EmailTransport {
  calls: { emails: OutgoingEmail[]; key: string }[] = [];
  script: (Error | ((emails: OutgoingEmail[]) => SendResult[]))[] = [];

  async sendBatch(emails: OutgoingEmail[], key: string): Promise<SendResult[]> {
    this.calls.push({ emails, key });
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    const call = this.calls.length;
    return next ? next(emails) : emails.map((_, i) => ({ ok: true, id: `msg-${call}-${i}` }));
  }
}

const message = (n: number): OutgoingEmail => ({ ref: `APP-${n}`, to: `person${n}@example.com`, subject: 's', html: '<p>h</p>', text: 't' });
const temporary = (text = 'Resend answered 503: busy') => new EmailSendError(text, { retryable: true });
const permanent = (text = 'Resend answered 403 validation_error: The example.com domain is not verified.') =>
  new EmailSendError(text, { retryable: false });

function quiet(): void {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
}
afterEach(() => vi.restoreAllMocks());

describe('confirmation email template', () => {
  const input = {
    companyName: 'AI Assistant',
    jobTitle: 'Support Executive',
    candidateName: 'Asha Rao',
    applicationId: 'APP-ABCDEFGHJK',
    submittedAt: '2026-10-13T18:45:00.000Z',
    timezone: 'Asia/Kolkata',
    repliesMonitored: false,
  };

  it('thanks the candidate by first name and states the role, reference and date', () => {
    const { subject, html, text } = applicationReceivedEmail(input);
    expect(subject).toBe('We received your application – Support Executive');
    for (const body of [html, text]) {
      expect(body).toContain('Hi Asha,');
      expect(body).toContain('AI Assistant');
      expect(body).toContain('Support Executive');
      expect(body).toContain('APP-ABCDEFGHJK');
      // 18:45 UTC is already the next day in India.
      expect(body).toContain('14 October 2026');
      expect(body).toContain('If your profile matches the requirements, we will contact you shortly.');
      expect(body).toContain('This is an automated email.');
      expect(body).toContain('Please do not reply to it, as replies are not read.');
    }
    expect(text).not.toContain('<');
  });

  it('invites replies only when a reply address is configured', () => {
    const { html, text } = applicationReceivedEmail({ ...input, repliesMonitored: true });
    expect(html).toContain('Just reply to this email.');
    for (const body of [html, text]) {
      expect(body).not.toContain('automated');
      expect(body).not.toContain('do not reply');
    }
  });

  it('escapes everything it is given and loads nothing from the internet', () => {
    const { html } = applicationReceivedEmail({
      ...input,
      companyName: 'R&D <b>Labs</b>',
      jobTitle: 'Engineer"><script>alert(1)</script>',
      applicationId: '<img src=x>',
    });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>Labs');
    expect(html).not.toContain('<img');
    expect(html).toContain('R&amp;D &lt;b&gt;Labs&lt;/b&gt;');
    expect(html).toContain('Engineer&quot;&gt;&lt;script&gt;');

    const plain = applicationReceivedEmail(input).html;
    expect(plain).not.toMatch(/<a\s|<img|<link|<script|url\(|https?:/i);
  });

  it('greets by name only when the name field holds a name', () => {
    expect(greetingName('Asha Rao')).toBe('Asha');
    expect(greetingName("  O'Brien-Smith  ")).toBe("O'Brien-Smith");
    expect(greetingName('José María')).toBe('José');
    expect(greetingName('आशा राव')).toBe('आशा');
    expect(greetingName('win-a-prize.example.com now')).toBeNull();
    expect(greetingName('https://evil.example')).toBeNull();
    expect(greetingName('<b>Asha</b>')).toBeNull();
    expect(greetingName('A'.repeat(31))).toBeNull();

    const { html, text } = applicationReceivedEmail({ ...input, candidateName: 'Visit evil.example today' });
    expect(text).toContain('Hi Visit,');
    const spam = applicationReceivedEmail({ ...input, candidateName: 'evil.example/claim free money' });
    expect(spam.text).toContain('Hi there,');
    expect(spam.html).not.toContain('evil.example');
    expect(html).not.toContain('evil.example');
  });
});

describe('email settings', () => {
  const base = { STORAGE_BACKEND: 'local', SESSION_SECRET: 's'.repeat(32) };
  const on = { ...base, RESEND_API_KEY: 're_test_123', EMAIL_FROM: 'Acme Careers <careers@example.com>' };

  it('leaves confirmation emails off unless they are configured', () => {
    const config = loadConfig(base);
    expect(config.email).toBeNull();
    expect(config.emailProblem).toBeNull();
  });

  it('reads the sender, the reply address and the batching window', () => {
    expect(loadConfig(on).email).toEqual({
      resendApiKey: 're_test_123',
      from: 'Acme Careers <careers@example.com>',
      replyTo: null,
      batchDelayMs: 10_000,
    });
    const tuned = loadConfig({ ...on, EMAIL_FROM: 'careers@example.com', EMAIL_REPLY_TO: 'hr@example.com', EMAIL_BATCH_SECONDS: '2.5' });
    expect(tuned.email).toMatchObject({ from: 'careers@example.com', replyTo: 'hr@example.com', batchDelayMs: 2500 });
  });

  it('turns emails off with an explanation, rather than refusing to start, when the settings are incomplete or wrong', () => {
    const problem = (env: Record<string, string>) => {
      const config = loadConfig({ ...base, ...env });
      expect(config.email).toBeNull();
      return config.emailProblem;
    };
    expect(problem({ RESEND_API_KEY: 're_test_123' })).toMatch(/EMAIL_FROM is not set/);
    expect(problem({ EMAIL_FROM: 'careers@example.com' })).toMatch(/RESEND_API_KEY is not set/);
    expect(problem({ RESEND_API_KEY: 're_test_123', EMAIL_FROM: 'Acme Careers' })).toMatch(/EMAIL_FROM must look like/);
    expect(problem({ RESEND_API_KEY: 're_test_123', EMAIL_FROM: 'Acme <careers@example.com> extra' })).toMatch(/EMAIL_FROM/);
    expect(problem({ ...on, EMAIL_REPLY_TO: 'hr@example.com, boss@example.com' })).toMatch(/EMAIL_REPLY_TO/);
  });
});

describe('Resend batch call', () => {
  function transportWith(respond: (url: string, init: RequestInit) => Response | Promise<Response>, replyTo: string | null = null) {
    const requests: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return respond(String(url), init ?? {});
    }) as typeof fetch;
    const transport = new ResendTransport({ apiKey: 're_secret_key', from: 'Acme Careers <careers@example.com>', replyTo, fetch: fakeFetch });
    return { transport, requests };
  }
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const failure = async (promise: Promise<unknown>): Promise<EmailSendError> => {
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EmailSendError);
    return err as EmailSendError;
  };

  it('sends every message of a batch in one request to the batch endpoint', async () => {
    const { transport, requests } = transportWith(() => reply(200, { data: [{ id: 'a' }, { id: 'b' }] }), 'hr@example.com');
    const results = await transport.sendBatch([message(1), message(2)], 'key-1');
    expect(results).toEqual([
      { ok: true, id: 'a' },
      { ok: true, id: 'b' },
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.resend.com/emails/batch');
    expect(requests[0].init.method).toBe('POST');
    const headers = new Headers(requests[0].init.headers);
    expect(headers.get('authorization')).toBe('Bearer re_secret_key');
    expect(headers.get('idempotency-key')).toBe('key-1');
    expect(headers.get('x-batch-validation')).toBe('permissive');
    expect(headers.get('user-agent')).toBeTruthy();
    expect(JSON.parse(String(requests[0].init.body))).toEqual([
      {
        from: 'Acme Careers <careers@example.com>',
        to: ['person1@example.com'],
        subject: 's',
        html: '<p>h</p>',
        text: 't',
        reply_to: 'hr@example.com',
        tags: [
          { name: 'category', value: 'application_received' },
          { name: 'ref', value: 'APP-1' },
        ],
      },
      expect.objectContaining({ to: ['person2@example.com'], tags: expect.arrayContaining([{ name: 'ref', value: 'APP-2' }]) }),
    ]);
  });

  it('leaves out the reply address when none is configured', async () => {
    const { transport, requests } = transportWith(() => reply(200, { data: [{ id: 'a' }] }));
    await transport.sendBatch([message(1)], 'key');
    expect(JSON.parse(String(requests[0].init.body))[0]).not.toHaveProperty('reply_to');
  });

  it('reports a refused message without losing the others', async () => {
    const { transport } = transportWith(() =>
      reply(200, { data: [{ id: 'a' }, { id: 'c' }], errors: [{ index: 1, message: 'Invalid `to` field.' }] }),
    );
    expect(await transport.sendBatch([message(1), message(2), message(3)], 'key')).toEqual([
      { ok: true, id: 'a' },
      { ok: false, reason: 'Invalid `to` field.' },
      { ok: true, id: 'c' },
    ]);
  });

  it('tells temporary failures, which are worth repeating, from permanent ones', async () => {
    const outcome = async (status: number, body: unknown, headers?: Record<string, string>) => {
      const { transport } = transportWith(() => reply(status, body, headers));
      return failure(transport.sendBatch([message(1)], 'key'));
    };

    const limited = await outcome(429, { name: 'rate_limit_exceeded', message: 'Too many requests' }, { 'retry-after': '3' });
    expect(limited).toMatchObject({ retryable: true, retryAfterMs: 3000 });
    expect(await outcome(500, { name: 'application_error', message: 'Oops' })).toMatchObject({ retryable: true });
    expect(await outcome(503, null)).toMatchObject({ retryable: true });
    expect(await outcome(409, { name: 'concurrent_idempotent_requests', message: 'In progress' })).toMatchObject({ retryable: true });

    expect(await outcome(429, { name: 'daily_quota_exceeded', message: 'Quota reached' })).toMatchObject({ retryable: false });
    expect(await outcome(409, { name: 'invalid_idempotent_request', message: 'Body changed' })).toMatchObject({ retryable: false });
    expect(await outcome(401, { name: 'missing_api_key', message: 'Missing API key' })).toMatchObject({ retryable: false });
    const unverified = await outcome(403, { name: 'validation_error', message: 'The example.com domain is not verified.' });
    expect(unverified.retryable).toBe(false);
    expect(unverified.message).toBe('Resend answered 403 validation_error: The example.com domain is not verified.');
  });

  it('treats an unreachable service as temporary and never puts the API key in an error', async () => {
    const { transport } = transportWith(() => {
      throw new TypeError('fetch failed: Authorization: Bearer re_secret_key');
    });
    const err = await failure(transport.sendBatch([message(1)], 'key'));
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain('re_secret_key');
  });

  it('refuses a batch larger than Resend accepts without calling it', async () => {
    const { transport, requests } = transportWith(() => reply(200, { data: [] }));
    const err = await failure(transport.sendBatch(Array.from({ length: 101 }, (_, i) => message(i)), 'key'));
    expect(err.retryable).toBe(false);
    expect(requests).toHaveLength(0);
    expect(await transport.sendBatch([], 'key')).toEqual([]);
    expect(requests).toHaveLength(0);
  });
});

describe('email outbox', () => {
  function outboxWith(options: Partial<ConstructorParameters<typeof EmailOutbox<number>>[1]> = {}) {
    const transport = new FakeTransport();
    const settled: Settled<number>[] = [];
    const outbox = new EmailOutbox<number>(transport, {
      delayMs: 20,
      batchSize: 100,
      retryBaseMs: 1,
      onSettled: (results) => void settled.push(...results),
      ...options,
    });
    return { transport, settled, outbox };
  }

  it('sends messages that arrive close together in one call', async () => {
    const { transport, settled, outbox } = outboxWith();
    for (let i = 0; i < 7; i++) outbox.enqueue(message(i), i);
    expect(transport.calls).toHaveLength(0);
    expect(outbox.pending).toBe(7);

    await vi.waitFor(() => expect(settled).toHaveLength(7));
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].emails.map((e) => e.ref)).toEqual(['APP-0', 'APP-1', 'APP-2', 'APP-3', 'APP-4', 'APP-5', 'APP-6']);
    expect(settled.map((s) => [s.context, s.result])).toContainEqual([3, { ok: true, id: 'msg-1-3' }]);
    expect(outbox.pending).toBe(0);
  });

  it('starts a new batch for messages that arrive after the window', async () => {
    const { transport, settled, outbox } = outboxWith({ delayMs: 5 });
    outbox.enqueue(message(1), 1);
    await vi.waitFor(() => expect(settled).toHaveLength(1));
    outbox.enqueue(message(2), 2);
    await vi.waitFor(() => expect(settled).toHaveLength(2));
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0].key).not.toBe(transport.calls[1].key);
  });

  it('never puts more than 100 messages in a call, and sends a full batch without waiting', async () => {
    const { transport, settled, outbox } = outboxWith({ delayMs: 60_000 });
    for (let i = 0; i < 250; i++) outbox.enqueue(message(i), i);
    // The window is a minute long: only the full batches can have gone out by now.
    await vi.waitFor(() => expect(settled).toHaveLength(200));
    expect(transport.calls.map((c) => c.emails.length)).toEqual([100, 100]);

    await outbox.flush();
    expect(transport.calls.map((c) => c.emails.length)).toEqual([100, 100, 50]);
    expect(new Set(settled.map((s) => s.context)).size).toBe(250);
  });

  it('repeats a batch that failed temporarily, unchanged and under the same key', async () => {
    quiet();
    const { transport, settled, outbox } = outboxWith({ delayMs: 1 });
    transport.script = [temporary(), temporary()];
    outbox.enqueue(message(1), 1);
    outbox.enqueue(message(2), 2);

    await vi.waitFor(() => expect(settled).toHaveLength(2));
    expect(transport.calls).toHaveLength(3);
    expect(new Set(transport.calls.map((c) => c.key)).size).toBe(1);
    expect(transport.calls[2].emails).toEqual(transport.calls[0].emails);
    expect(settled.every((s) => s.result.ok)).toBe(true);
  });

  it('keeps later messages out of a batch that is being retried', async () => {
    quiet();
    const { transport, settled, outbox } = outboxWith({ delayMs: 1, retryBaseMs: 200 });
    transport.script = [temporary()];
    outbox.enqueue(message(1), 1);
    await vi.waitFor(() => expect(transport.calls).toHaveLength(1), { interval: 5 });
    outbox.enqueue(message(2), 2);

    await vi.waitFor(() => expect(settled).toHaveLength(2), { timeout: 2000 });
    expect(transport.calls.map((c) => c.emails.map((e) => e.ref))).toEqual([['APP-1'], ['APP-2'], ['APP-1']]);
    expect(transport.calls[2].key).toBe(transport.calls[0].key);
  });

  it('waits as long as the service asks before retrying', async () => {
    quiet();
    const { transport, settled, outbox } = outboxWith({ delayMs: 1 });
    transport.script = [new EmailSendError('Resend answered 429: slow down', { retryable: true, retryAfterMs: 120 })];
    const started = Date.now();
    outbox.enqueue(message(1), 1);
    await vi.waitFor(() => expect(settled).toHaveLength(1), { timeout: 2000 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });

  it('gives up after the last try and reports why', async () => {
    quiet();
    const { transport, settled, outbox } = outboxWith({ delayMs: 1, maxAttempts: 3 });
    transport.script = [temporary(), temporary(), temporary('Resend answered 503: still busy')];
    outbox.enqueue(message(1), 1);
    await vi.waitFor(() => expect(settled).toHaveLength(1));
    expect(transport.calls).toHaveLength(3);
    expect(settled[0].result).toEqual({ ok: false, reason: 'Resend answered 503: still busy' });
    expect(outbox.pending).toBe(0);
  });

  it('does not repeat a batch that failed for good', async () => {
    quiet();
    const { transport, settled, outbox } = outboxWith({ delayMs: 1 });
    transport.script = [permanent()];
    outbox.enqueue(message(1), 1);
    outbox.enqueue(message(2), 2);
    await vi.waitFor(() => expect(settled).toHaveLength(2));
    expect(transport.calls).toHaveLength(1);
    expect(settled.map((s) => s.result.ok)).toEqual([false, false]);

    // The next batch is unaffected.
    outbox.enqueue(message(3), 3);
    await vi.waitFor(() => expect(settled).toHaveLength(3));
    expect(settled[2].result).toMatchObject({ ok: true });
  });

  it('passes on which messages of a batch were refused', async () => {
    const { transport, settled, outbox } = outboxWith({ delayMs: 1 });
    transport.script = [() => [{ ok: true, id: 'a' }, { ok: false, reason: 'Invalid `to` field.' }]];
    outbox.enqueue(message(1), 1);
    outbox.enqueue(message(2), 2);
    await vi.waitFor(() => expect(settled).toHaveLength(2));
    expect(settled.map((s) => [s.email.ref, s.result.ok])).toEqual([
      ['APP-1', true],
      ['APP-2', false],
    ]);
  });

  it('on shutdown sends what is waiting, retries failed batches one last time, and sends late arrivals at once', async () => {
    quiet();
    const { transport, settled, outbox } = outboxWith({ delayMs: 60_000, retryBaseMs: 60_000, batchSize: 2 });
    transport.script = [temporary()];
    // A full batch goes out at once, fails, and now waits a minute for its retry.
    outbox.enqueue(message(1), 1);
    outbox.enqueue(message(2), 2);
    await vi.waitFor(() => expect(transport.calls).toHaveLength(1), { interval: 5 });
    // This one waits a minute for more messages to join it.
    outbox.enqueue(message(3), 3);
    expect(outbox.pending).toBe(3);

    await outbox.close();
    expect(transport.calls.map((c) => c.emails.map((e) => e.ref))).toEqual([['APP-1', 'APP-2'], ['APP-1', 'APP-2'], ['APP-3']]);
    expect(transport.calls[1].key).toBe(transport.calls[0].key);
    expect(settled.map((s) => s.result.ok)).toEqual([true, true, true]);
    expect(outbox.pending).toBe(0);

    outbox.enqueue(message(4), 4);
    await outbox.close();
    expect(settled).toHaveLength(4);
  });

  it('gives up on a batch that still fails while shutting down', async () => {
    quiet();
    const { transport, settled, outbox } = outboxWith({ delayMs: 60_000 });
    transport.script = [temporary('Resend could not be reached.')];
    outbox.enqueue(message(1), 1);
    await outbox.close();
    expect(transport.calls).toHaveLength(1);
    expect(settled.map((s) => s.result)).toEqual([{ ok: false, reason: 'Resend could not be reached.' }]);
  });

  it('keeps sending when recording an outcome fails', async () => {
    quiet();
    const transport = new FakeTransport();
    let recorded = 0;
    const outbox = new EmailOutbox<number>(transport, {
      delayMs: 1,
      batchSize: 100,
      onSettled: () => {
        recorded += 1;
        if (recorded === 1) throw new Error('sheet unavailable');
      },
    });
    outbox.enqueue(message(1), 1);
    await vi.waitFor(() => expect(recorded).toBe(1));
    outbox.enqueue(message(2), 2);
    await vi.waitFor(() => expect(recorded).toBe(2));
    expect(transport.calls).toHaveLength(2);
  });
});

describe('confirmation email after applying', () => {
  let app: TestApp;
  let transport: FakeTransport;
  const emailEnv = {
    RESEND_API_KEY: 're_test_123',
    EMAIL_FROM: 'Test Co Careers <careers@example.com>',
    // Long enough that nothing goes out until the test flushes.
    EMAIL_BATCH_SECONDS: '60',
  };
  const start = async (options: TestAppOptions = {}) => {
    transport = new FakeTransport();
    app = await startTestApp({ emailTransport: transport, ...options, env: { ...emailEnv, ...options.env } });
    return app;
  };
  afterEach(() => app?.close());

  const activityFor = async (applicationId: string) =>
    asObjects(await app.rawTab('Application Activity'))
      .filter((row) => row['Application ID'] === applicationId)
      .map((row) => ({ action: row['Action'], detail: row['Detail'], actor: row['Actor'] }));

  it('emails the candidate and records it in the application history', async () => {
    quiet();
    await start();
    const job = await createJob(app, await app.login());
    const res = await submit(app, job);
    expect(res.status).toBe(201);
    const { applicationId, confirmationEmail } = (await res.json()) as { applicationId: string; confirmationEmail: boolean };
    expect(confirmationEmail).toBe(true);

    // Queued, not sent inline: the candidate's response does not wait for the email service.
    expect(transport.calls).toHaveLength(0);
    await app.ctx.emails!.flush();

    expect(transport.calls).toHaveLength(1);
    const [email] = transport.calls[0].emails;
    expect(email).toMatchObject({
      ref: applicationId,
      to: 'asha.rao@example.com',
      subject: 'We received your application – Senior Backend Engineer',
    });
    expect(email.html).toContain('Hi Asha,');
    expect(email.html).toContain('Test Co');
    expect(email.html).toContain(applicationId);
    expect(email.text).toContain(`Reference: ${applicationId}`);

    expect(await activityFor(applicationId)).toEqual([
      { action: 'Submitted', detail: '', actor: 'Candidate' },
      { action: 'Confirmation email sent', detail: 'Resend ID msg-1-0', actor: 'System' },
    ]);
    const detail = (await (
      await fetch(`${app.baseUrl}/api/admin/applications/${applicationId}`, { headers: { Cookie: await app.login() } })
    ).json()) as { activity: { action: string }[] };
    expect(detail.activity.map((a) => a.action)).toContain('Confirmation email sent');
  });

  it('sends a burst of applications in a single batch call', async () => {
    quiet();
    await start();
    const job = await createJob(app, await app.login());
    const people = Array.from({ length: 12 }, (_, i) => ({ fullName: `Person ${i}`, email: `burst${i}@example.com` }));
    const responses = await Promise.all(people.map((fields) => submit(app, job, { fields })));
    expect(responses.map((r) => r.status)).toEqual(people.map(() => 201));

    await app.ctx.emails!.flush();
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].emails.map((e) => e.to).sort()).toEqual(people.map((p) => p.email).sort());
    const sent = asObjects(await app.rawTab('Application Activity')).filter((row) => row['Action'] === 'Confirmation email sent');
    expect(sent).toHaveLength(12);
  });

  it('still accepts the application when the email cannot be sent, and records why', async () => {
    quiet();
    await start();
    transport.script = [permanent()];
    const job = await createJob(app, await app.login());
    const res = await submit(app, job);
    expect(res.status).toBe(201);
    const { applicationId } = (await res.json()) as { applicationId: string };
    await app.ctx.emails!.flush();

    expect(asObjects(await app.rawTab('Applications'))).toHaveLength(1);
    expect(await activityFor(applicationId)).toContainEqual({
      action: 'Confirmation email not sent',
      detail: 'Resend answered 403 validation_error: The example.com domain is not verified.',
      actor: 'System',
    });
  });

  it('records a refused address against that application only', async () => {
    quiet();
    await start();
    transport.script = [(emails) => emails.map((e) => (e.to.startsWith('bad') ? { ok: false, reason: 'Invalid `to` field.' } : { ok: true, id: 'ok-1' }))];
    const job = await createJob(app, await app.login());
    const ids: Record<string, string> = {};
    for (const email of ['good@example.com', 'bad@example.com']) {
      const res = await submit(app, job, { fields: { email } });
      ids[email] = ((await res.json()) as { applicationId: string }).applicationId;
    }
    await app.ctx.emails!.flush();

    expect((await activityFor(ids['good@example.com'])).map((a) => a.action)).toEqual(['Submitted', 'Confirmation email sent']);
    expect(await activityFor(ids['bad@example.com'])).toContainEqual({
      action: 'Confirmation email not sent',
      detail: 'Invalid `to` field.',
      actor: 'System',
    });
  });

  it('sends nothing for rejected, duplicate or bot submissions', async () => {
    quiet();
    await start();
    const job = await createJob(app, await app.login());
    expect((await submit(app, job, { fields: { email: 'not-an-email' } })).status).toBe(422);
    expect((await submit(app, job, { fields: { website: 'https://spam.example' } })).status).toBe(201);
    expect((await submit(app, job)).status).toBe(201);
    expect((await submit(app, job)).status).toBe(409);

    await app.ctx.emails!.flush();
    expect(transport.calls.flatMap((c) => c.emails.map((e) => e.to))).toEqual(['asha.rao@example.com']);
  });

  it('sends nothing, and says so, when emails are not configured', async () => {
    await start({ env: { RESEND_API_KEY: '', EMAIL_FROM: '' } });
    expect(app.ctx.emails).toBeNull();
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    const res = await submit(app, job);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { confirmationEmail: boolean }).confirmationEmail).toBe(false);
    expect(transport.calls).toHaveLength(0);
    expect(asObjects(await app.rawTab('Application Activity'))).toHaveLength(1);

    const detail = (await (await fetch(`${app.baseUrl}/api/admin/jobs/${job.id}`, { headers: { Cookie: cookie } })).json()) as {
      confirmationEmail: unknown;
    };
    expect(detail.confirmationEmail).toEqual({ on: false, problem: null });
  });

  it('keeps taking applications when the email settings are wrong, and tells administrators what is wrong', async () => {
    await start({ env: { EMAIL_FROM: '' } });
    const cookie = await app.login();
    const job = await createJob(app, cookie);
    expect((await submit(app, job)).status).toBe(201);
    const detail = (await (await fetch(`${app.baseUrl}/api/admin/jobs/${job.id}`, { headers: { Cookie: cookie } })).json()) as {
      confirmationEmail: unknown;
    };
    expect(detail.confirmationEmail).toEqual({ on: false, problem: 'EMAIL_FROM is not set.' });
  });

  it('shows administrators, and only them, the email a candidate for the job would get', async () => {
    await start();
    const cookie = await app.login();
    const job = await createJob(app, cookie, { title: 'Support <Lead>' });
    const url = `${app.baseUrl}/api/admin/jobs/${job.id}/email-preview`;

    expect((await fetch(url)).status).toBe(401);
    const res = await fetch(url, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    const html = await res.text();
    expect(html).toContain('Application received');
    expect(html).toContain('Support &lt;Lead&gt;');
    expect(html).toContain('Test Co');
    expect((await fetch(`${app.baseUrl}/api/admin/jobs/zzzzzzzzzz/email-preview`, { headers: { Cookie: cookie } })).status).toBe(404);

    const detail = (await (await fetch(`${app.baseUrl}/api/admin/jobs/${job.id}`, { headers: { Cookie: cookie } })).json()) as {
      confirmationEmail: unknown;
    };
    expect(detail.confirmationEmail).toEqual({ on: true, problem: null });
    // Looking at the preview sends nothing.
    await app.ctx.emails!.flush();
    expect(transport.calls).toHaveLength(0);
  });
});
