import type { AppConfig } from '../config';
import { ACTIVITY } from '../schema';
import type { Storage } from '../storage';
import { EmailOutbox, type Settled } from './outbox';
import { RESEND_MAX_BATCH, ResendTransport } from './resend';
import { applicationReceivedEmail } from './templates';
import type { EmailTransport } from './transport';

export type { EmailTransport, OutgoingEmail, SendResult } from './transport';

interface SentFor {
  applicationId: string;
  jobId: string;
}

/**
 * Emails to candidates. Messages are queued and go out in batches a few
 * seconds later, so a burst of applications costs a handful of calls to the
 * email service rather than one each. The outcome of every message is added
 * to the application's activity history.
 */
export class CandidateEmails {
  private readonly outbox: EmailOutbox<SentFor>;

  constructor(
    private readonly config: AppConfig,
    private readonly storage: Storage,
    transport: EmailTransport,
    batchDelayMs: number,
  ) {
    this.outbox = new EmailOutbox<SentFor>(transport, {
      delayMs: batchDelayMs,
      batchSize: RESEND_MAX_BATCH,
      onSettled: (results) => this.record(results),
    });
  }

  /**
   * Queues the "we received your application" email. Never throws: the
   * application is already saved, and a confirmation must not make it look failed.
   */
  applicationReceived(
    job: { id: string; title: string },
    application: { id: string; fullName: string; email: string; submittedAt: string },
  ): void {
    try {
      const content = applicationReceivedEmail({
        companyName: this.config.companyName,
        jobTitle: job.title,
        candidateName: application.fullName,
        applicationId: application.id,
        submittedAt: application.submittedAt,
        timezone: this.config.timezone,
        repliesMonitored: Boolean(this.config.email?.replyTo),
      });
      this.outbox.enqueue({ ref: application.id, to: application.email, ...content }, { applicationId: application.id, jobId: job.id });
    } catch (err) {
      console.error(`[email] Could not prepare the confirmation for ${application.id}: ${(err as Error).message}`);
    }
  }

  /** Sends everything that is waiting, now. */
  flush(): Promise<void> {
    return this.outbox.flush();
  }

  /** Sends what is waiting before the server stops. */
  close(): Promise<void> {
    return this.outbox.close();
  }

  private async record(results: Settled<SentFor>[]): Promise<void> {
    const now = new Date().toISOString();
    const sent = results.filter((r) => r.result.ok).length;
    if (sent > 0) console.log(`[email] Sent ${sent} confirmation email(s) in one batch.`);
    await this.storage.tables.append(
      [
        {
          table: ACTIVITY.name,
          rows: results.map(({ context, result }) => ({
            timestamp: now,
            applicationId: context.applicationId,
            jobId: context.jobId,
            action: result.ok ? 'Confirmation email sent' : 'Confirmation email not sent',
            detail: result.ok ? (result.id ? `Resend ID ${result.id}` : '') : result.reason.slice(0, 300),
            actor: 'System',
          })),
        },
      ],
      { duplicatesHarmless: true },
    );
  }
}

/** Null when confirmation emails are not configured: nothing is sent. */
export function createCandidateEmails(
  config: AppConfig,
  storage: Storage,
  transport?: EmailTransport,
): CandidateEmails | null {
  if (!config.email) return null;
  const { resendApiKey, from, replyTo, batchDelayMs } = config.email;
  return new CandidateEmails(
    config,
    storage,
    transport ?? new ResendTransport({ apiKey: resendApiKey, from, replyTo }),
    batchDelayMs,
  );
}
