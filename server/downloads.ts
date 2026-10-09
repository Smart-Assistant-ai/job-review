import { randomUUID } from 'node:crypto';
import type { DownloadProgress } from '../shared/types';
import type { ZipItem } from './zip';

const KEEP_MS = 15 * 60 * 1000;
const TICKET_VALID_MS = 5 * 60 * 1000;

interface Entry extends DownloadProgress {
  touchedAt: number;
  /** Present until the download is collected. */
  ticket?: { items: ZipItem[]; filename: string; createdAt: number };
}

/**
 * Prepared ZIP downloads and their progress.
 *
 * A download happens in two steps. First the dashboard asks for a set of
 * resumes; any problem (nothing selected, session expired) comes back as a
 * normal error it can display. If all is well it receives a one-time ID, and
 * the browser then fetches the ZIP for that ID as an ordinary file download.
 * Progress is kept under the same ID so the page can show "37 of 240 added".
 *
 * Held in memory: the app runs as a single process.
 */
export class DownloadTracker {
  private readonly entries = new Map<string, Entry>();

  static isValidId(id: unknown): id is string {
    return typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id);
  }

  private prune(): void {
    const cutoff = Date.now() - KEEP_MS;
    for (const [id, entry] of this.entries) {
      if (entry.touchedAt < cutoff) this.entries.delete(id);
    }
  }

  /** Registers a download that is ready to be collected and returns its one-time ID. */
  prepare(items: ZipItem[], filename: string): string {
    this.prune();
    const id = randomUUID();
    const now = Date.now();
    this.entries.set(id, {
      state: 'running',
      total: items.length,
      added: 0,
      missing: 0,
      touchedAt: now,
      ticket: { items, filename, createdAt: now },
    });
    return id;
  }

  /** Hands over a prepared download exactly once. Returns null if it was already used or has expired. */
  collect(id: string): { items: ZipItem[]; filename: string } | null {
    const entry = this.entries.get(id);
    const ticket = entry?.ticket;
    if (!entry || !ticket) return null;
    delete entry.ticket;
    if (Date.now() - ticket.createdAt > TICKET_VALID_MS) {
      this.finish(id, 'failed', 'The download took too long to start. Please try again.');
      return null;
    }
    entry.touchedAt = Date.now();
    return { items: ticket.items, filename: ticket.filename };
  }

  update(id: string, change: { added?: number; missing?: number }): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.added += change.added ?? 0;
    entry.missing += change.missing ?? 0;
    entry.touchedAt = Date.now();
  }

  finish(id: string, state: Exclude<DownloadProgress['state'], 'running'>, message?: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.state = state;
    entry.message = message;
    entry.touchedAt = Date.now();
  }

  get(id: string): DownloadProgress | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const { state, total, added, missing, message } = entry;
    return message === undefined ? { state, total, added, missing } : { state, total, added, missing, message };
  }
}
