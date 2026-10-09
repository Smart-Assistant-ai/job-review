import { readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { auth as googleAuth, drive as driveApi, type drive_v3 } from '@googleapis/drive';
import { sheets as sheetsApi, type sheets_v4 } from '@googleapis/sheets';
import type { GoogleAuthConfig } from '../config';
import { StorageError, type CellValue, type DriveBackend, type SheetBackend, type UploadInput } from './types';

/**
 * Thin adapters over the Google Sheets and Drive REST APIs.
 *
 * The server signs in to Google in one of two ways, chosen by GOOGLE_AUTH_MODE:
 *
 *   service_account  A robot account with its own key file. It reaches only
 *                    what has been shared with it. It has no Drive storage, so
 *                    it can save resumes only when the folder is in a Shared Drive.
 *   oauth            Acts as a real Google user through a refresh token. Works
 *                    with folders in that user's My Drive.
 *
 * Either way the credentials stay on the server and are never sent to a browser.
 */

/** OAuth: access limited to files this app created itself. */
export const OAUTH_SCOPE_APP_FILES = 'https://www.googleapis.com/auth/drive.file';
/** OAuth: access to the user's whole Drive. Needed to use a folder or sheet that already exists. */
export const OAUTH_SCOPE_FULL_DRIVE = 'https://www.googleapis.com/auth/drive';
/** A service account can reach only what is shared with it, whatever the scope says. */
const SERVICE_ACCOUNT_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
];
export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
export const SPREADSHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet';

const SHEETS_TIMEOUT_MS = 30_000;
const DRIVE_TIMEOUT_MS = 120_000;

export const NO_STORAGE_MESSAGE =
  'The Google service account has no Drive storage of its own, so it cannot save files into a folder in someone\'s My Drive. ' +
  'Either move the Recruitment System folder into a Shared Drive, or set GOOGLE_AUTH_MODE=oauth and run "npm run google:setup".';

/** Reads and checks a service-account key file, without ever echoing its contents. */
function readServiceAccountKey(keyFile: string): { client_email: string; private_key: string } {
  let raw: string;
  try {
    const stat = statSync(keyFile);
    // Anyone who can read this file can act as the service account.
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      console.warn(`[google] The service account key file is readable by other users of this machine. Restrict it with: chmod 600 "${keyFile}"`);
    }
    raw = readFileSync(keyFile, 'utf8');
  } catch {
    throw new StorageError('config', `The service account key file could not be read: ${keyFile}. Check GOOGLE_SERVICE_ACCOUNT_KEY_FILE.`);
  }
  let parsed: { type?: unknown; client_email?: unknown; private_key?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new StorageError('config', `The service account key file is not valid JSON: ${keyFile}.`);
  }
  if (parsed.type !== 'service_account' || typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
    throw new StorageError(
      'config',
      `${keyFile} is not a service account key. Download a JSON key for the service account from Google Cloud (IAM & Admin → Service Accounts → Keys).`,
    );
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

export function createGoogleClients(config: GoogleAuthConfig): {
  sheets: sheets_v4.Sheets;
  drive: drive_v3.Drive;
  /** Who the server acts as, when that is known without calling Google. */
  identity: string | null;
} {
  if (config.mode === 'oauth') {
    const client = new googleAuth.OAuth2(config.clientId, config.clientSecret);
    client.setCredentials({ refresh_token: config.refreshToken });
    return { sheets: sheetsApi({ version: 'v4', auth: client }), drive: driveApi({ version: 'v3', auth: client }), identity: null };
  }

  const credentials = config.keyFile
    ? readServiceAccountKey(config.keyFile)
    : { client_email: config.clientEmail ?? '', private_key: config.privateKey ?? '' };
  if (!credentials.client_email || !credentials.private_key.includes('PRIVATE KEY')) {
    throw new StorageError('config', 'The service account email or private key is missing or malformed.');
  }
  const client = new googleAuth.GoogleAuth({ credentials, scopes: SERVICE_ACCOUNT_SCOPES });
  return {
    sheets: sheetsApi({ version: 'v4', auth: client }),
    drive: driveApi({ version: 'v3', auth: client }),
    identity: credentials.client_email,
  };
}

interface GoogleErrorLike {
  message?: string;
  status?: number;
  code?: string | number;
  response?: { status?: number; data?: unknown };
}

function parseErrorBody(data: unknown): { oauthError?: string; reason?: string } {
  let body = data;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return {};
    }
  }
  if (!body || typeof body !== 'object') return {};
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return { oauthError: error };
  if (error && typeof error === 'object') {
    const e = error as { status?: string; errors?: { reason?: string }[] };
    return { reason: e.errors?.[0]?.reason ?? e.status };
  }
  return {};
}

/** Converts a Google client error into the app's storage error categories. */
export function toStorageError(err: unknown, action: string): StorageError {
  if (err instanceof StorageError) return err;
  const e = (err ?? {}) as GoogleErrorLike;
  const status = e.status ?? e.response?.status ?? (typeof e.code === 'number' ? e.code : undefined);
  const { oauthError, reason } = parseErrorBody(e.response?.data);
  const detail = reason ?? oauthError ?? (typeof e.code === 'string' ? e.code : undefined);
  const suffix = `${status ? ` (HTTP ${status}` : ' ('}${detail ? `${status ? ', ' : ''}${detail}` : ''})`;
  const describe = (text: string) => `${text} while trying to ${action}${suffix === ' ()' ? '' : suffix}`;
  const options = { cause: err };

  const message = e.message ?? '';
  if (oauthError === 'invalid_grant' || /invalid_grant/.test(message)) {
    return new StorageError(
      'auth',
      'Google rejected the saved credentials: they have expired, been revoked, or do not belong to this project. ' +
        'For OAuth, run "npm run google:setup -- --reauth". For a service account, create a new JSON key and replace the key file.',
      options,
    );
  }
  // The key could not even be used to sign a request (damaged file, or line breaks lost when pasting).
  if (typeof e.code === 'string' && /^ERR_OSSL|DECODER/i.test(`${e.code} ${message}`)) {
    return new StorageError('config', 'The service account private key is damaged or incomplete. Download a fresh JSON key and use that file.', options);
  }
  if (reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED' || /has not been used in project|it is disabled/i.test(message)) {
    return new StorageError(
      'config',
      'The Google Drive API and Google Sheets API must both be enabled for the Google Cloud project (APIs & Services → Library). Enable them, wait a minute, and try again.',
      options,
    );
  }
  if (status === 401) {
    return new StorageError('auth', describe('Google rejected the stored credentials'), options);
  }
  if (status === 404) {
    return new StorageError('not_found', describe('Google could not find the item'), options);
  }
  // Not throttling: the account simply has nowhere to put files. Retrying cannot help.
  if (reason === 'storageQuotaExceeded' || /do not have storage quota/i.test(e.message ?? '')) {
    return new StorageError('config', NO_STORAGE_MESSAGE, options);
  }
  const rateLimited = /^(userRateLimitExceeded|rateLimitExceeded|RESOURCE_EXHAUSTED)$/i.test(reason ?? '');
  if (status === 429 || (status === 403 && (rateLimited || !reason))) {
    // A 403 with no readable reason is treated as throttling: retrying costs
    // only a few seconds, while giving up early would fail large downloads.
    return new StorageError('rate_limit', describe('Google is rate limiting requests'), options);
  }
  if (status === 403) {
    return new StorageError('auth', describe('Google refused access'), options);
  }
  if (status !== undefined && status >= 500) {
    return new StorageError('unavailable', describe('Google is temporarily unavailable'), options);
  }
  if (status === undefined) {
    return new StorageError('unavailable', describe('Could not reach Google'), options);
  }
  return new StorageError('unknown', describe('Google rejected the request'), options);
}

async function call<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toStorageError(err, action);
  }
}

function quoteTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`;
}

/** Zero-based column index to spreadsheet letters: 0 -> A, 26 -> AA. */
export function columnLetters(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Text is stored as text and never interpreted, so "=FORMULA()" input stays inert. */
function toCellData(value: CellValue): sheets_v4.Schema$CellData {
  if (value === '') return {};
  if (typeof value === 'number') return { userEnteredValue: { numberValue: value } };
  return { userEnteredValue: { stringValue: value } };
}

export class GoogleSheetBackend implements SheetBackend {
  private readonly sheetIds = new Map<string, number>();

  constructor(
    private readonly sheets: sheets_v4.Sheets,
    private readonly spreadsheetId: string,
  ) {}

  private async refreshSheetIds(): Promise<void> {
    const res = await call('read the spreadsheet', () =>
      this.sheets.spreadsheets.get(
        { spreadsheetId: this.spreadsheetId, fields: 'sheets.properties(sheetId,title)' },
        { timeout: SHEETS_TIMEOUT_MS },
      ),
    );
    this.sheetIds.clear();
    for (const sheet of res.data.sheets ?? []) {
      const { title, sheetId } = sheet.properties ?? {};
      if (typeof title === 'string' && typeof sheetId === 'number') this.sheetIds.set(title, sheetId);
    }
  }

  private async sheetId(tab: string): Promise<number> {
    if (!this.sheetIds.has(tab)) await this.refreshSheetIds();
    const id = this.sheetIds.get(tab);
    if (id === undefined) throw new StorageError('not_found', `Worksheet "${tab}" does not exist`);
    return id;
  }

  async ensureTabs(names: string[]): Promise<void> {
    await this.refreshSheetIds();
    const missing = names.filter((name) => !this.sheetIds.has(name));
    if (missing.length === 0) return;
    const res = await call('create worksheets', () =>
      this.sheets.spreadsheets.batchUpdate(
        {
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            requests: missing.map((title) => ({
              addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } },
            })),
          },
        },
        { timeout: SHEETS_TIMEOUT_MS, retry: false },
      ),
    );
    (res.data.replies ?? []).forEach((reply, i) => {
      const id = reply.addSheet?.properties?.sheetId;
      if (typeof id === 'number') this.sheetIds.set(missing[i], id);
    });
  }

  async readTab(tab: string): Promise<CellValue[][]> {
    const res = await call(`read worksheet "${tab}"`, () =>
      this.sheets.spreadsheets.values.get(
        {
          spreadsheetId: this.spreadsheetId,
          range: quoteTab(tab),
          valueRenderOption: 'UNFORMATTED_VALUE',
          dateTimeRenderOption: 'FORMATTED_STRING',
        },
        { timeout: SHEETS_TIMEOUT_MS },
      ),
    );
    return (res.data.values ?? []) as CellValue[][];
  }

  async appendRows(appends: { tab: string; rows: CellValue[][] }[]): Promise<void> {
    const requests: sheets_v4.Schema$Request[] = [];
    for (const { tab, rows } of appends) {
      requests.push({
        appendCells: {
          sheetId: await this.sheetId(tab),
          fields: 'userEnteredValue',
          rows: rows.map((row) => ({ values: row.map(toCellData) })),
        },
      });
    }
    // One batchUpdate is applied atomically: either every row lands or none do.
    await call('save rows', () =>
      this.sheets.spreadsheets.batchUpdate(
        { spreadsheetId: this.spreadsheetId, requestBody: { requests } },
        { timeout: SHEETS_TIMEOUT_MS, retry: false },
      ),
    );
  }

  async writeCells(tab: string, cells: { row: number; col: number; value: CellValue }[]): Promise<void> {
    if (cells.length === 0) return;
    await call(`update worksheet "${tab}"`, () =>
      this.sheets.spreadsheets.values.batchUpdate(
        {
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            // RAW stores values exactly as given, without parsing formulas or dates.
            valueInputOption: 'RAW',
            data: cells.map((cell) => ({
              range: `${quoteTab(tab)}!${columnLetters(cell.col)}${cell.row + 1}`,
              values: [[cell.value]],
            })),
          },
        },
        { timeout: SHEETS_TIMEOUT_MS },
      ),
    );
  }

  /** Removes a worksheet. Only used by the connection check for its scratch tab. */
  async deleteTab(tab: string): Promise<void> {
    const sheetId = await this.sheetId(tab);
    await call(`delete worksheet "${tab}"`, () =>
      this.sheets.spreadsheets.batchUpdate(
        { spreadsheetId: this.spreadsheetId, requestBody: { requests: [{ deleteSheet: { sheetId } }] } },
        { timeout: SHEETS_TIMEOUT_MS, retry: false },
      ),
    );
    this.sheetIds.delete(tab);
  }
}

function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export class GoogleDriveBackend implements DriveBackend {
  constructor(private readonly drive: drive_v3.Drive) {}

  async findFolder(parentId: string, name: string): Promise<string | null> {
    const res = await call('look up a Drive folder', () =>
      this.drive.files.list(
        {
          q: `'${escapeQueryValue(parentId)}' in parents and name = '${escapeQueryValue(name)}' and mimeType = '${FOLDER_MIME_TYPE}' and trashed = false`,
          fields: 'files(id)',
          pageSize: 1,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        },
        { timeout: DRIVE_TIMEOUT_MS },
      ),
    );
    return res.data.files?.[0]?.id ?? null;
  }

  async createFolder(parentId: string, name: string): Promise<string> {
    const res = await call('create a Drive folder', () =>
      this.drive.files.create(
        {
          requestBody: { name, mimeType: FOLDER_MIME_TYPE, parents: [parentId] },
          fields: 'id',
          supportsAllDrives: true,
        },
        { timeout: DRIVE_TIMEOUT_MS, retry: false },
      ),
    );
    if (!res.data.id) throw new StorageError('unknown', 'Google Drive did not return a folder ID');
    return res.data.id;
  }

  async rename(fileId: string, name: string): Promise<void> {
    await call('rename a Drive item', () =>
      this.drive.files.update(
        { fileId, requestBody: { name }, fields: 'id', supportsAllDrives: true },
        { timeout: DRIVE_TIMEOUT_MS },
      ),
    );
  }

  /**
   * Uploads a file into a folder. No sharing permission is ever added, so the
   * file stays private to the Google account that owns the folder.
   */
  async uploadFile(input: UploadInput): Promise<{ id: string }> {
    const res = await call('upload a file to Drive', () =>
      this.drive.files.create(
        {
          requestBody: { name: input.name, parents: [input.folderId] },
          media: { mimeType: input.mimeType, body: Readable.from([input.data]) },
          fields: 'id',
          supportsAllDrives: true,
        },
        { timeout: DRIVE_TIMEOUT_MS, retry: false },
      ),
    );
    if (!res.data.id) throw new StorageError('unknown', 'Google Drive did not return a file ID');
    return { id: res.data.id };
  }

  async downloadFile(fileId: string): Promise<Readable> {
    const res = await call('download a file from Drive', () =>
      this.drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream', timeout: DRIVE_TIMEOUT_MS },
      ),
    );
    const body = res.data as unknown;
    if (body && typeof (body as Readable).pipe === 'function') return body as Readable;
    if (body) return Readable.fromWeb(body as WebReadableStream);
    throw new StorageError('unknown', 'Google Drive returned an empty download');
  }

  async trash(fileId: string): Promise<void> {
    await call('move a Drive item to trash', () =>
      this.drive.files.update(
        { fileId, requestBody: { trashed: true }, fields: 'id', supportsAllDrives: true },
        { timeout: DRIVE_TIMEOUT_MS },
      ),
    );
  }
}
