import type { Readable } from 'node:stream';
import { ZipArchive } from 'archiver';
import { withRetry } from './storage/retry';
import { isStorageError, type DriveBackend } from './storage/types';

export interface ZipItem {
  /** Empty when the application has no resume on record. */
  fileId: string;
  /** File name to use inside the archive. */
  name: string;
  /** How the entry is described in the report, e.g. "Asha Rao (APP-1234)". */
  label: string;
}

export interface ResumeZip {
  /** The archive bytes. Pipe this to the HTTP response. */
  stream: Readable;
  /** Settles when the archive is complete, or rejects if it had to stop. */
  done: Promise<void>;
  /** Stops work, for example when the browser cancels the download. */
  abort(): void;
}

export const ZIP_REPORT_NAME = '_download-report.txt';

// Far above any accepted resume; guards memory if something unexpected is in Drive.
const MAX_ENTRY_BYTES = 100 * 1024 * 1024;

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_ENTRY_BYTES) {
      stream.destroy();
      throw new Error('File is larger than expected');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Adds "(2)", "(3)"... before the extension if a name was already used in this archive. */
function uniqueName(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Builds a ZIP of resumes as a stream.
 *
 * Files are fetched from Drive and written one at a time, so memory use stays
 * at roughly one resume regardless of how many are requested, and a slow
 * browser connection naturally slows the fetching down. A file that is missing
 * or keeps failing is skipped and listed in a report inside the archive rather
 * than aborting the whole download.
 */
export function createResumeZip(
  drive: DriveBackend,
  items: ZipItem[],
  onProgress: (change: { added?: number; missing?: number }) => void = () => {},
): ResumeZip {
  // Resumes are already compressed formats, so storing them saves CPU for no size cost.
  const archive = new ZipArchive({ store: true });
  let aborted = false;
  let closed = false;
  archive.once('close', () => {
    closed = true;
  });

  const addEntry = (source: Buffer | string, name: string) =>
    new Promise<void>((resolve, reject) => {
      if (aborted || closed) return reject(new Error('Download cancelled'));
      const cleanup = () => {
        archive.off('entry', onEntry);
        archive.off('error', onError);
        archive.off('close', onClose);
      };
      const onEntry = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Download cancelled'));
      };
      archive.once('entry', onEntry);
      archive.once('error', onError);
      archive.once('close', onClose);
      archive.append(source, { name });
    });

  const build = async () => {
    const used = new Set<string>([ZIP_REPORT_NAME.toLowerCase()]);
    const skipped: string[] = [];
    let added = 0;

    for (const item of items) {
      if (aborted) throw new Error('Download cancelled');
      let data: Buffer | null = null;
      let reason = '';
      if (!item.fileId) {
        reason = 'no resume on record';
      } else {
        try {
          data = await withRetry(async () => readAll(await drive.downloadFile(item.fileId)));
        } catch (err) {
          reason = isStorageError(err, 'not_found')
            ? 'file not found in Drive (moved or deleted)'
            : 'could not be downloaded from Drive';
        }
      }
      if (aborted) throw new Error('Download cancelled');

      if (data) {
        await addEntry(data, uniqueName(item.name, used));
        added += 1;
        onProgress({ added: 1 });
      } else {
        skipped.push(`- ${item.label}: ${reason}`);
        onProgress({ missing: 1 });
      }
    }

    const report = [
      'Resume download report',
      `Generated: ${new Date().toISOString()}`,
      `Requested: ${items.length}`,
      `Included: ${added}`,
      `Not included: ${skipped.length}`,
      ...(skipped.length > 0 ? ['', 'Not included:', ...skipped] : []),
      '',
    ].join('\r\n');
    await addEntry(report, ZIP_REPORT_NAME);
    await archive.finalize();
  };

  const done = build().catch((err) => {
    if (!closed) archive.abort();
    throw err;
  });
  // The caller observes failures through `done`; avoid an unhandled rejection if it does so late.
  done.catch(() => undefined);

  return {
    stream: archive,
    done,
    abort() {
      aborted = true;
      if (!closed) archive.abort();
    },
  };
}
