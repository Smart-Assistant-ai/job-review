import { randomUUID } from 'node:crypto';
import { EmailSendError, type EmailTransport, type OutgoingEmail, type SendResult } from './transport';

export interface OutboxOptions<C> {
  /** How long messages are collected before they go out together. */
  delayMs: number;
  /** Most messages per call. A full batch goes out at once without waiting. */
  batchSize: number;
  /** Total tries per batch, including the first. */
  maxAttempts?: number;
  /** Wait before the first retry; doubles with each further one, up to `retryMaxMs`. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Told about every message once it has been sent or given up on. */
  onSettled?: (results: Settled<C>[]) => void | Promise<void>;
}

export interface Settled<C> {
  email: OutgoingEmail;
  context: C;
  result: SendResult;
}

interface Item<C> {
  email: OutgoingEmail;
  context: C;
}

interface Batch<C> {
  /** Stays the same across retries, so the provider can tell a retry from a new batch. */
  key: string;
  items: Item<C>[];
  attempts: number;
  /** Earliest time of the next try. */
  notBefore: number;
}

/**
 * Collects outgoing emails for a short while and sends them in batches: one
 * call to the provider for many messages instead of one call each.
 *
 * Failed batches are retried with growing delays. Everything is held in
 * memory, so `close()` must run before the process exits.
 */
export class EmailOutbox<C = undefined> {
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  private queue: Item<C>[] = [];
  /** When the oldest message in the queue arrived: its collection window runs from here. */
  private queueSince = 0;
  private batches: Batch<C>[] = [];
  private timer: NodeJS.Timeout | null = null;
  private timerAt = Infinity;
  /** Sends run one after another; this is the end of the line. */
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly transport: EmailTransport,
    private readonly options: OutboxOptions<C>,
  ) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.retryBaseMs = options.retryBaseMs ?? 2_000;
    this.retryMaxMs = options.retryMaxMs ?? 60_000;
  }

  /** Messages accepted here and not yet sent or given up on. */
  get pending(): number {
    return this.queue.length + this.batches.reduce((sum, batch) => sum + batch.items.length, 0);
  }

  enqueue(email: OutgoingEmail, context: C): void {
    if (this.queue.length === 0) this.queueSince = Date.now();
    this.queue.push({ email, context });
    // While shutting down there is no later: send straight away.
    if (this.closed) void this.run(true);
    else this.wakeIn(this.queue.length >= this.options.batchSize ? 0 : this.options.delayMs);
  }

  /** Sends everything now, without waiting for the collection window or for retry delays. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = Infinity;
    return this.run(true);
  }

  /** Flushes, and from then on sends new messages immediately. Safe to call more than once. */
  close(): Promise<void> {
    this.closed = true;
    return this.flush();
  }

  private wakeIn(delayMs: number): void {
    const at = Date.now() + delayMs;
    if (this.timer && this.timerAt <= at) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerAt = Infinity;
      void this.run(false);
    }, delayMs);
    // A waiting batch must not keep a finished script or test run alive.
    this.timer.unref();
  }

  private run(final: boolean): Promise<void> {
    const done = this.tail.then(() => this.sendDue(final));
    this.tail = done.catch(() => undefined);
    return done;
  }

  /** With `final`, batches waiting out a retry delay are tried now, one last time. */
  private async sendDue(final: boolean): Promise<void> {
    const now = Date.now();
    // Full batches go at once; a partial one waits until its collection window is over.
    // A batch is fixed once formed: a retry has to repeat exactly the same request.
    const windowOver = final || now >= this.queueSince + this.options.delayMs;
    while (this.queue.length >= this.options.batchSize || (windowOver && this.queue.length > 0)) {
      this.batches.push({ key: randomUUID(), items: this.queue.splice(0, this.options.batchSize), attempts: 0, notBefore: 0 });
    }

    const due = this.batches.filter((batch) => final || batch.notBefore <= now);
    this.batches = this.batches.filter((batch) => !due.includes(batch));
    for (const batch of due) await this.send(batch, final);

    const wakeUps = this.batches.map((batch) => batch.notBefore);
    if (this.queue.length > 0) wakeUps.push(this.queueSince + this.options.delayMs);
    if (wakeUps.length > 0) this.wakeIn(Math.max(0, Math.min(...wakeUps) - Date.now()));
  }

  private async send(batch: Batch<C>, final: boolean): Promise<void> {
    batch.attempts += 1;
    let results: SendResult[];
    try {
      results = await this.transport.sendBatch(
        batch.items.map((item) => item.email),
        batch.key,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const canRetry = err instanceof EmailSendError && err.retryable && batch.attempts < this.maxAttempts && !final;
      if (canRetry) {
        const backoff = Math.min(this.retryBaseMs * 2 ** (batch.attempts - 1), this.retryMaxMs);
        const wait = Math.max(err.retryAfterMs ?? 0, backoff);
        batch.notBefore = Date.now() + wait;
        this.batches.push(batch);
        console.warn(
          `[email] ${batch.items.length} email(s) not sent yet (try ${batch.attempts} of ${this.maxAttempts}): ${reason} Trying again in ${Math.ceil(wait / 1000)}s.`,
        );
        return;
      }
      console.error(`[email] ${batch.items.length} email(s) could not be sent: ${reason}`);
      results = batch.items.map(() => ({ ok: false, reason }));
    }

    const settled = batch.items.map((item, index) => ({
      ...item,
      result: results[index] ?? ({ ok: false, reason: 'The email service gave no result for this message.' } as const),
    }));
    try {
      await this.options.onSettled?.(settled);
    } catch (err) {
      console.warn(`[email] Could not record the outcome of ${settled.length} email(s): ${(err as Error).message}`);
    }
  }
}
