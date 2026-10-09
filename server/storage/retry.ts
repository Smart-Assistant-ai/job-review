import { StorageError } from './types';

/** Tunable so tests do not have to wait for real backoff delays. */
export const retrySettings = {
  /** Total tries including the first one. */
  attempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter: roughly 0.5s, 1s, 2s between tries. */
async function backoff(attempt: number): Promise<void> {
  const exponential = retrySettings.baseDelayMs * 2 ** (attempt - 2);
  const delay = Math.min(exponential, retrySettings.maxDelayMs);
  await sleep(delay / 2 + Math.random() * (delay / 2));
}

function isRetryable(err: unknown): boolean {
  return err instanceof StorageError && err.retryable;
}

/**
 * Retries a call that is safe to repeat (reads, overwrites) when it fails with
 * a rate-limit or transient error. Any other error is rethrown immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retrySettings.attempts; attempt++) {
    if (attempt > 1) await backoff(attempt);
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) throw err;
    }
  }
  throw lastError;
}

/**
 * Retries a call that must not take effect twice (appending rows). Before each
 * retry, `alreadyDone` checks whether the earlier attempt actually went
 * through; if it did, the loop ends successfully. If that check itself fails,
 * its error propagates and nothing is written again.
 */
export async function withVerifiedRetry(
  fn: () => Promise<void>,
  alreadyDone: () => Promise<boolean>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retrySettings.attempts; attempt++) {
    if (attempt > 1) {
      await backoff(attempt);
      if (await alreadyDone()) return;
    }
    try {
      await fn();
      return;
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) throw err;
    }
  }
  throw lastError;
}
