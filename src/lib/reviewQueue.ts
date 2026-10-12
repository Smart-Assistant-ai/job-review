/**
 * Remembers the list a recruiter was working through, so the candidate screen
 * can offer "previous / next" in the same order and with the same filters.
 * Kept per browser tab; it holds only application IDs.
 */
const KEY = 'review-queue';

export interface ReviewQueue {
  ids: string[];
  /** The candidate list address (with filters) the queue came from. */
  from: string;
}

export function saveReviewQueue(queue: ReviewQueue): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(queue));
  } catch {
    // Storage can be unavailable (private mode, full). Navigation still works without it.
  }
}

export function loadReviewQueue(): ReviewQueue | null {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    const queue = parsed as Partial<ReviewQueue> | null;
    if (queue && Array.isArray(queue.ids) && typeof queue.from === 'string') {
      return { ids: queue.ids.filter((id): id is string => typeof id === 'string'), from: queue.from };
    }
  } catch {
    // Ignore unreadable data.
  }
  return null;
}
