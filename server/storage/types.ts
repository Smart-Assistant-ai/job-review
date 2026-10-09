import type { Readable } from 'node:stream';

export type CellValue = string | number;

/**
 * The smallest set of spreadsheet operations the app needs. All logic about
 * headers, IDs, caching and retries lives above this interface so that it is
 * shared by the Google and local implementations.
 */
export interface SheetBackend {
  /** Creates any tabs that do not exist yet. */
  ensureTabs(names: string[]): Promise<void>;
  /** Returns every populated row of a tab, header row first. Rows may be ragged. */
  readTab(tab: string): Promise<CellValue[][]>;
  /** Appends rows to one or more tabs. Either every row is written or none are. */
  appendRows(appends: { tab: string; rows: CellValue[][] }[]): Promise<void>;
  /** Overwrites individual cells. Row and column indexes are zero-based. */
  writeCells(tab: string, cells: { row: number; col: number; value: CellValue }[]): Promise<void>;
}

export interface UploadInput {
  folderId: string;
  name: string;
  mimeType: string;
  data: Buffer;
}

export interface DriveBackend {
  findFolder(parentId: string, name: string): Promise<string | null>;
  createFolder(parentId: string, name: string): Promise<string>;
  rename(fileId: string, name: string): Promise<void>;
  uploadFile(input: UploadInput): Promise<{ id: string }>;
  downloadFile(fileId: string): Promise<Readable>;
  /** Moves a file or folder to the trash. Nothing is deleted permanently. */
  trash(fileId: string): Promise<void>;
}

export type StorageErrorKind =
  | 'not_found'
  | 'auth'
  | 'rate_limit'
  | 'unavailable'
  | 'config'
  | 'unknown';

export class StorageError extends Error {
  readonly kind: StorageErrorKind;
  /** True when repeating the same call may succeed (rate limits, transient outages). */
  readonly retryable: boolean;

  constructor(kind: StorageErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageError';
    this.kind = kind;
    this.retryable = kind === 'rate_limit' || kind === 'unavailable';
  }
}

export function isStorageError(err: unknown, kind?: StorageErrorKind): err is StorageError {
  return err instanceof StorageError && (kind === undefined || err.kind === kind);
}
