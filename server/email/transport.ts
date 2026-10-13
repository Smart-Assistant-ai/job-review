/** One message, ready to send. */
export interface OutgoingEmail {
  /** Identifies the message in the provider's dashboard and in logs. Contains no personal details. */
  ref: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** What happened to one message of a batch. */
export type SendResult = { ok: true; id: string } | { ok: false; reason: string };

export interface EmailTransport {
  /**
   * Sends several messages in one call and reports on each, in the same order.
   * Repeating a call with the same key and the same messages must not send
   * anything twice. Throws EmailSendError when the call as a whole fails.
   */
  sendBatch(emails: OutgoingEmail[], idempotencyKey: string): Promise<SendResult[]>;
}

/** A batch call that failed as a whole. Messages are written for administrators and contain no secrets. */
export class EmailSendError extends Error {
  /** Whether the same call may succeed if repeated later. */
  readonly retryable: boolean;
  /** How long the provider asked us to wait, when it said so. */
  readonly retryAfterMs?: number;

  constructor(message: string, options: { retryable: boolean; retryAfterMs?: number }) {
    super(message);
    this.name = 'EmailSendError';
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}
