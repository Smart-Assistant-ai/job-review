import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { StorageError, type CellValue, type DriveBackend, type SheetBackend, type UploadInput } from './types';

/**
 * File-based stand-ins for Google Sheets and Google Drive.
 *
 * They exist so the app can be run and tested without Google credentials.
 * They are not a database for production use: real deployments keep all data
 * in Google Workspace through the Google backend.
 */

class Mutex {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task, task);
    this.chain = result.catch(() => undefined);
    return result;
  }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}

type SheetData = Record<string, CellValue[][]>;

export class LocalSheetBackend implements SheetBackend {
  private readonly file: string;
  private readonly mutex = new Mutex();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'sheets.json');
  }

  private load(): Promise<SheetData> {
    return readJson<SheetData>(this.file, {});
  }

  ensureTabs(names: string[]): Promise<void> {
    return this.mutex.run(async () => {
      const data = await this.load();
      let changed = false;
      for (const name of names) {
        if (!data[name]) {
          data[name] = [];
          changed = true;
        }
      }
      if (changed) await writeJsonAtomic(this.file, data);
    });
  }

  async readTab(tab: string): Promise<CellValue[][]> {
    const data = await this.load();
    if (!data[tab]) throw new StorageError('not_found', `Tab "${tab}" does not exist`);
    return data[tab];
  }

  appendRows(appends: { tab: string; rows: CellValue[][] }[]): Promise<void> {
    return this.mutex.run(async () => {
      const data = await this.load();
      for (const { tab } of appends) {
        if (!data[tab]) throw new StorageError('not_found', `Tab "${tab}" does not exist`);
      }
      for (const { tab, rows } of appends) data[tab].push(...rows.map((r) => [...r]));
      await writeJsonAtomic(this.file, data);
    });
  }

  writeCells(tab: string, cells: { row: number; col: number; value: CellValue }[]): Promise<void> {
    return this.mutex.run(async () => {
      const data = await this.load();
      const rows = data[tab];
      if (!rows) throw new StorageError('not_found', `Tab "${tab}" does not exist`);
      for (const { row, col, value } of cells) {
        while (rows.length <= row) rows.push([]);
        while (rows[row].length <= col) rows[row].push('');
        rows[row][col] = value;
      }
      await writeJsonAtomic(this.file, data);
    });
  }
}

interface DriveItem {
  name: string;
  parentId: string;
  isFolder: boolean;
  mimeType?: string;
  trashed: boolean;
}
type DriveIndex = Record<string, DriveItem>;

export const LOCAL_ROOT_FOLDER_ID = 'local-root';

export class LocalDriveBackend implements DriveBackend {
  private readonly indexFile: string;
  private readonly filesDir: string;
  private readonly mutex = new Mutex();

  constructor(dataDir: string) {
    this.indexFile = path.join(dataDir, 'drive', 'index.json');
    this.filesDir = path.join(dataDir, 'drive', 'files');
  }

  private load(): Promise<DriveIndex> {
    return readJson<DriveIndex>(this.indexFile, {});
  }

  private newId(): string {
    return `local_${randomBytes(12).toString('hex')}`;
  }

  async findFolder(parentId: string, name: string): Promise<string | null> {
    const index = await this.load();
    const match = Object.entries(index).find(
      ([, item]) => item.isFolder && !item.trashed && item.parentId === parentId && item.name === name,
    );
    return match ? match[0] : null;
  }

  createFolder(parentId: string, name: string): Promise<string> {
    return this.mutex.run(async () => {
      const index = await this.load();
      const id = this.newId();
      index[id] = { name, parentId, isFolder: true, trashed: false };
      await writeJsonAtomic(this.indexFile, index);
      return id;
    });
  }

  rename(fileId: string, name: string): Promise<void> {
    return this.mutex.run(async () => {
      const index = await this.load();
      if (!index[fileId]) throw new StorageError('not_found', 'File not found');
      index[fileId].name = name;
      await writeJsonAtomic(this.indexFile, index);
    });
  }

  uploadFile(input: UploadInput): Promise<{ id: string }> {
    return this.mutex.run(async () => {
      const index = await this.load();
      const id = this.newId();
      await fs.mkdir(this.filesDir, { recursive: true });
      await fs.writeFile(path.join(this.filesDir, id), input.data);
      index[id] = {
        name: input.name,
        parentId: input.folderId,
        isFolder: false,
        mimeType: input.mimeType,
        trashed: false,
      };
      await writeJsonAtomic(this.indexFile, index);
      return { id };
    });
  }

  async downloadFile(fileId: string): Promise<Readable> {
    // IDs come from our own index, but never let one escape the files directory.
    if (!/^local_[a-f0-9]+$/.test(fileId)) throw new StorageError('not_found', 'File not found');
    const file = path.join(this.filesDir, fileId);
    try {
      await fs.access(file);
    } catch {
      throw new StorageError('not_found', 'File not found');
    }
    return createReadStream(file);
  }

  trash(fileId: string): Promise<void> {
    return this.mutex.run(async () => {
      const index = await this.load();
      if (!index[fileId]) throw new StorageError('not_found', 'File not found');
      index[fileId].trashed = true;
      await writeJsonAtomic(this.indexFile, index);
    });
  }
}
