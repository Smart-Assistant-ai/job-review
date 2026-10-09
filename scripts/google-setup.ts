/**
 * One-time connection to Google.
 *
 *   npm run google:setup
 *
 * What it does depends on GOOGLE_AUTH_MODE in your env file:
 *
 *   service_account  Checks that the service account can open the folder and
 *                    spreadsheet you configured, then prepares the worksheets.
 *
 *   oauth            Opens Google's approval page so you can sign in as the
 *                    Google user who owns the recruitment data, saves the
 *                    resulting refresh token, then prepares the folder and
 *                    worksheets. If no folder or spreadsheet is configured yet,
 *                    it creates them.
 *
 * Secrets are written only to your env file, never printed.
 *
 * Options:
 *   --client-file <path>  (oauth) Import the client ID and secret from the JSON file
 *                         downloaded from Google Cloud Console, instead of typing them in.
 *   --reauth        (oauth) Sign in again even if a refresh token is already saved.
 *   --port <n>      (oauth) Local port that receives Google's reply. Default 53682.
 *   --env <path>    Env file to read and update (default: .env.local, else .env).
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { auth as googleAuth, type drive_v3 } from '@googleapis/drive';
import { loadConfig } from '../server/config';
import { ALL_TABLES, JOBS_FOLDER_NAME, ROOT_FOLDER_NAME, SPREADSHEET_NAME } from '../server/schema';
import {
  createGoogleClients,
  FOLDER_MIME_TYPE,
  GoogleDriveBackend,
  GoogleSheetBackend,
  NO_STORAGE_MESSAGE,
  OAUTH_SCOPE_APP_FILES,
  OAUTH_SCOPE_FULL_DRIVE,
  SPREADSHEET_MIME_TYPE,
  toStorageError,
} from '../server/storage/google';
import { TableStore } from '../server/storage/tables';
import { loadEnvFile, resolveEnvFile, saveEnvValues } from './env-file';

const CONSENT_TIMEOUT_MS = 9 * 60 * 1000;
const DEFAULT_PORT = 53682;

const env = (name: string) => process.env[name]?.trim() || undefined;

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  // Best effort only: the URL is also printed for copying by hand.
  execFile(command as string, args as string[], () => undefined);
}

/**
 * Copies the client ID and secret from Google's downloaded client file into
 * the env file. The values are never printed.
 */
function importClientFile(file: string, envFile: string): void {
  const resolved = path.resolve(process.cwd(), file);
  let parsed: Record<string, { client_id?: unknown; client_secret?: unknown; project_id?: unknown } | undefined>;
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf8')) as typeof parsed;
  } catch {
    throw new Error(`Could not read an OAuth client file at ${resolved}.`);
  }
  const kind = parsed.web ? 'web' : parsed.installed ? 'installed' : null;
  const client = kind ? parsed[kind] : undefined;
  if (!kind || !client || typeof client.client_id !== 'string' || typeof client.client_secret !== 'string') {
    throw new Error(
      `${resolved} is not an OAuth client file. In Google Cloud Console open APIs & Services → Credentials, and use "Download JSON" on the OAuth client.`,
    );
  }
  saveEnvValues(envFile, { GOOGLE_AUTH_MODE: 'oauth', GOOGLE_CLIENT_ID: client.client_id, GOOGLE_CLIENT_SECRET: client.client_secret });
  process.env.GOOGLE_AUTH_MODE = 'oauth';
  process.env.GOOGLE_CLIENT_ID = client.client_id;
  process.env.GOOGLE_CLIENT_SECRET = client.client_secret;
  const project = typeof client.project_id === 'string' ? ` from project ${client.project_id}` : '';
  console.log(`Imported the OAuth client (${kind === 'web' ? 'Web application' : 'Desktop app'})${project} into ${envFile}.`);
}

/**
 * Asks Google, before sending you to the approval page, whether it will accept
 * this client and return address. Catches the usual setup mistakes with a clear
 * instruction instead of a Google error page. Best effort: if the question
 * cannot be asked, setup simply carries on.
 */
async function checkClientAccepted(consentUrl: string, redirectUri: string): Promise<void> {
  let finalUrl: URL;
  try {
    finalUrl = new URL((await fetch(consentUrl, { redirect: 'follow', signal: AbortSignal.timeout(15_000) })).url);
  } catch {
    return;
  }
  const encoded = finalUrl.searchParams.get('authError');
  if (!finalUrl.pathname.includes('/oauth/error') || !encoded) return;
  const detail = Buffer.from(encoded, 'base64').toString('latin1');

  if (detail.includes('redirect_uri_mismatch')) {
    throw new Error(
      'Google does not yet allow this OAuth client to return to this computer.\n\n' +
        'In Google Cloud Console open APIs & Services → Credentials, click the OAuth client, and under\n' +
        '"Authorized redirect URIs" add exactly:\n\n' +
        `    ${redirectUri}\n\n` +
        'Save, wait a minute or two, then run "npm run google:setup" again.\n' +
        '(A client of type "Desktop app" does not need this step.)',
    );
  }
  if (detail.includes('deleted_client') || detail.includes('invalid_client')) {
    throw new Error('Google does not recognise this OAuth client ID. Check GOOGLE_CLIENT_ID, or download the client file again.');
  }
  const reason = detail.match(/[a-z]+(?:_[a-z]+)+/)?.[0];
  throw new Error(`Google refused to start the approval${reason ? ` (${reason})` : ''}. Check the OAuth client and consent screen settings.`);
}

/** Runs the OAuth approval flow with a temporary listener on this machine and returns a refresh token. */
async function obtainRefreshToken(clientId: string, clientSecret: string, scope: string, port: number): Promise<string> {
  const state = randomBytes(16).toString('hex');
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new Error(`Port ${port} is in use. Pass another one with --port <number>.`)));
    server.listen(port, '127.0.0.1', resolve);
  });
  const client = new googleAuth.OAuth2(clientId, clientSecret, redirectUri);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();

  const consentUrl = client.generateAuthUrl({
    access_type: 'offline',
    // Forces Google to issue a refresh token even if access was granted before.
    prompt: 'consent',
    scope: [scope],
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256' as never,
  });

  try {
    await checkClientAccepted(consentUrl, redirectUri);
    console.log('\nOpen this address in your browser and approve access with the Google account that owns the recruitment folder:\n');
    console.log(`  ${consentUrl}\n`);
    openInBrowser(consentUrl);

    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for Google approval.')), CONSENT_TIMEOUT_MS);
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri);
        if (url.pathname !== '/oauth2callback') {
          res.writeHead(404).end();
          return;
        }
        const finish = (message: string, error?: Error) => {
          res.writeHead(error ? 400 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><meta charset="utf-8"><title>Google connection</title><body style="font-family:system-ui;padding:3rem"><h2>${message}</h2><p>You can close this tab and return to the terminal.</p>`);
          clearTimeout(timer);
          if (error) reject(error);
        };
        if (url.searchParams.get('state') !== state) {
          finish('This approval did not match the request.', new Error('State mismatch in the OAuth response.'));
        } else if (url.searchParams.get('error')) {
          finish('Access was not granted.', new Error(`Google returned: ${url.searchParams.get('error')}`));
        } else if (!url.searchParams.get('code')) {
          finish('No authorization code was received.', new Error('Missing authorization code.'));
        } else {
          finish('Google is connected.');
          resolve(url.searchParams.get('code')!);
        }
      });
    });

    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) {
      throw new Error('Google did not return a refresh token. Remove the app at https://myaccount.google.com/permissions and run this again.');
    }
    return tokens.refresh_token;
  } finally {
    server.close();
  }
}

/** Opens a folder and reports its name and whether it is inside a Shared Drive. */
async function describeFolder(drive: drive_v3.Drive, folderId: string, hint: string): Promise<{ name: string; inSharedDrive: boolean }> {
  const res = await drive.files
    .get({ fileId: folderId, fields: 'id,name,mimeType,driveId', supportsAllDrives: true })
    .catch((err: unknown) => {
      throw new Error(`${toStorageError(err, 'open the configured folder').message}\n${hint}`);
    });
  if (res.data.mimeType !== FOLDER_MIME_TYPE) {
    throw new Error(`GOOGLE_DRIVE_ROOT_FOLDER_ID (${folderId}) is not a folder.`);
  }
  return { name: res.data.name ?? folderId, inSharedDrive: Boolean(res.data.driveId) };
}

async function main(): Promise<void> {
  const envFile = resolveEnvFile();
  loadEnvFile(envFile);
  const clientFile = flagValue('--client-file');
  if (clientFile) importClientFile(clientFile, envFile);
  const mode = loadConfig().googleAuthMode;
  console.log(`Google sign-in mode: ${mode === 'service_account' ? 'service account' : 'OAuth (acts as a Google user)'}`);

  // ---- Credentials ----
  if (mode === 'service_account') {
    if (!env('GOOGLE_SERVICE_ACCOUNT_KEY_FILE') && !(env('GOOGLE_SERVICE_ACCOUNT_EMAIL') && env('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY'))) {
      throw new Error(
        `No service account key is configured in ${envFile}.\n` +
          'Download a JSON key for the service account (Google Cloud Console → IAM & Admin → Service Accounts → Keys → Add key → JSON),\n' +
          'save it as secrets/google-service-account.json, and set GOOGLE_SERVICE_ACCOUNT_KEY_FILE=secrets/google-service-account.json.',
      );
    }
    if (!env('GOOGLE_DRIVE_ROOT_FOLDER_ID') || !env('GOOGLE_SHEET_ID')) {
      throw new Error(
        'A service account cannot create the folder or spreadsheet for you. Create them in Google Drive, share the folder with the\n' +
          'service account as Editor, and set GOOGLE_DRIVE_ROOT_FOLDER_ID and GOOGLE_SHEET_ID.',
      );
    }
  } else {
    const clientId = env('GOOGLE_CLIENT_ID');
    const clientSecret = env('GOOGLE_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw new Error(
        `GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in ${envFile}.\n` +
          'Copy them from your OAuth client in Google Cloud Console (APIs & Services → Credentials), then run this again.',
      );
    }
    // A folder or sheet that already exists was not created by this app, so the
    // narrow "files this app created" permission cannot reach it.
    const usingExisting = Boolean(env('GOOGLE_DRIVE_ROOT_FOLDER_ID') || env('GOOGLE_SHEET_ID'));
    const scopeName = env('GOOGLE_OAUTH_SCOPE') ?? (usingExisting ? 'drive' : 'drive.file');
    if (scopeName !== 'drive' && scopeName !== 'drive.file') throw new Error('GOOGLE_OAUTH_SCOPE must be "drive" or "drive.file".');

    if (!env('GOOGLE_REFRESH_TOKEN') || process.argv.includes('--reauth')) {
      console.log(
        scopeName === 'drive'
          ? 'Requesting access to Google Drive, because a folder or spreadsheet that already exists is configured.'
          : 'Requesting access only to files this app creates (no folder is configured yet, so one will be created).',
      );
      const port = Number(flagValue('--port') ?? DEFAULT_PORT);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be a number between 1024 and 65535.');
      const refreshToken = await obtainRefreshToken(
        clientId,
        clientSecret,
        scopeName === 'drive' ? OAUTH_SCOPE_FULL_DRIVE : OAUTH_SCOPE_APP_FILES,
        port,
      );
      // Save immediately so a later failure does not require approving again.
      saveEnvValues(envFile, { GOOGLE_AUTH_MODE: 'oauth', GOOGLE_OAUTH_SCOPE: scopeName, GOOGLE_REFRESH_TOKEN: refreshToken });
      process.env.GOOGLE_REFRESH_TOKEN = refreshToken;
      console.log(`Saved the refresh token to ${envFile}.`);
    } else {
      console.log('Using the refresh token already saved. Pass --reauth to sign in again.');
    }
  }

  // ---- Folder and spreadsheet ----
  const authConfig =
    mode === 'service_account'
      ? loadConfig().google!.auth
      : ({ mode: 'oauth', clientId: env('GOOGLE_CLIENT_ID')!, clientSecret: env('GOOGLE_CLIENT_SECRET')!, refreshToken: env('GOOGLE_REFRESH_TOKEN')! } as const);
  const { sheets, drive, identity } = createGoogleClients(authConfig);
  const driveBackend = new GoogleDriveBackend(drive);
  if (identity) console.log(`Acting as ${identity}.`);

  let rootFolderId = env('GOOGLE_DRIVE_ROOT_FOLDER_ID');
  if (rootFolderId) {
    const hint =
      mode === 'service_account'
        ? `Share the folder with ${identity} as Editor, and check the folder ID.`
        : 'Check the folder ID, and that you signed in as a Google user who can open the folder.';
    const folder = await describeFolder(drive, rootFolderId, hint);
    console.log(`Opened folder "${folder.name}" (${folder.inSharedDrive ? 'in a Shared Drive' : 'in My Drive'}).`);
    if (mode === 'service_account' && !folder.inSharedDrive) {
      console.warn(`\nWARNING: ${NO_STORAGE_MESSAGE}\nThe spreadsheet will work, but saving resumes will fail. "npm run google:check" will confirm.\n`);
    }
  } else {
    const created = await drive.files
      .create({ requestBody: { name: ROOT_FOLDER_NAME, mimeType: FOLDER_MIME_TYPE }, fields: 'id' })
      .catch((err: unknown) => {
        throw toStorageError(err, 'create the root folder');
      });
    rootFolderId = created.data.id!;
    saveEnvValues(envFile, { GOOGLE_DRIVE_ROOT_FOLDER_ID: rootFolderId });
    console.log(`Created Drive folder "${ROOT_FOLDER_NAME}".`);
  }

  if (!(await driveBackend.findFolder(rootFolderId, JOBS_FOLDER_NAME))) {
    await driveBackend.createFolder(rootFolderId, JOBS_FOLDER_NAME);
    console.log(`Created the "${JOBS_FOLDER_NAME}" folder inside it.`);
  }

  let sheetId = env('GOOGLE_SHEET_ID');
  let sheetIsNew = false;
  if (!sheetId) {
    const created = await drive.files
      .create({
        requestBody: { name: SPREADSHEET_NAME, mimeType: SPREADSHEET_MIME_TYPE, parents: [rootFolderId] },
        fields: 'id',
        supportsAllDrives: true,
      })
      .catch((err: unknown) => {
        throw toStorageError(err, 'create the spreadsheet');
      });
    sheetId = created.data.id!;
    sheetIsNew = true;
    saveEnvValues(envFile, { GOOGLE_SHEET_ID: sheetId });
    console.log(`Created spreadsheet "${SPREADSHEET_NAME}".`);
  }

  const sheetBackend = new GoogleSheetBackend(sheets, sheetId);
  await new TableStore(sheetBackend, ALL_TABLES).init();
  console.log(`Worksheets ready: ${ALL_TABLES.map((t) => t.name).join(', ')}.`);

  if (sheetIsNew) {
    // A new spreadsheet starts with an empty default tab that the app does not use.
    const leftover = await sheetBackend.readTab('Sheet1').catch(() => null);
    if (leftover && leftover.length === 0) await sheetBackend.deleteTab('Sheet1').catch(() => undefined);
  }

  saveEnvValues(envFile, { GOOGLE_AUTH_MODE: mode, STORAGE_BACKEND: 'google' });

  console.log(`\nGoogle is connected. Settings saved to ${envFile} (STORAGE_BACKEND is now "google").`);
  console.log(`  Folder:      https://drive.google.com/drive/folders/${rootFolderId}`);
  console.log(`  Spreadsheet: https://docs.google.com/spreadsheets/d/${sheetId}`);
  console.log('\nNext: run "npm run google:check" to verify reading, writing, uploading and downloading.');
}

main().catch((err: Error) => {
  console.error(`\nSetup failed: ${err.message}`);
  process.exit(1);
});
