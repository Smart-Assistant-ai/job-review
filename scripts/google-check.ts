/**
 * Verifies the live Google connection using the same code the app uses.
 *
 *   npm run google:check
 *
 * It reads the worksheets, then exercises every write path against a
 * scratch worksheet and a scratch Drive folder, and removes both afterwards.
 * Your real jobs and applications are only read, never changed.
 */
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../server/config';
import { ALL_TABLES, JOBS_FOLDER_NAME } from '../server/schema';
import { createGoogleClients, GoogleDriveBackend, GoogleSheetBackend, toStorageError } from '../server/storage/google';
import { TableStore } from '../server/storage/tables';
import { loadEnvFile, resolveEnvFile } from './env-file';

let failures = 0;

async function step(name: string, run: () => Promise<string | void>): Promise<boolean> {
  try {
    const detail = await run();
    console.log(`  PASS  ${name}${detail ? ` (${detail})` : ''}`);
    return true;
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(err as Error).message}`);
    return false;
  }
}

function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  }
}

async function main(): Promise<void> {
  loadEnvFile(resolveEnvFile());
  const config = loadConfig();
  if (!config.google) {
    throw new Error(`Google is not configured. Missing: ${config.googleMissing.join(', ')}. See "Connect Google" in the README.`);
  }

  const { sheets, drive, identity } = createGoogleClients(config.google.auth);
  const sheetBackend = new GoogleSheetBackend(sheets, config.google.sheetId);
  const driveBackend = new GoogleDriveBackend(drive);
  const tag = randomBytes(3).toString('hex');
  const serviceAccount = config.google.auth.mode === 'service_account';

  console.log(`\nSign-in (${serviceAccount ? 'service account' : 'OAuth'})`);
  const signedIn = await step('Sign in to Google', async () => {
    if (identity) {
      // Forces a real token exchange, so a wrong or revoked key is reported here.
      await drive.about.get({ fields: 'user(emailAddress)' }).catch((err: unknown) => {
        throw toStorageError(err, 'sign in with the service account key');
      });
      return `acting as ${identity}`;
    }
    const about = await drive.about.get({ fields: 'user(emailAddress)' }).catch((err: unknown) => {
      throw toStorageError(err, 'sign in with the saved refresh token');
    });
    return `acting as ${about.data.user?.emailAddress ?? 'an unknown user'}`;
  });
  if (!signedIn) {
    console.log('\nStopping: nothing else can work until sign-in does.');
    process.exit(1);
  }

  let inSharedDrive = false;
  await step('Open the Recruitment System folder', async () => {
    const res = await drive.files
      .get({ fileId: config.google!.rootFolderId, fields: 'name,mimeType,driveId', supportsAllDrives: true })
      .catch((err: unknown) => {
        const hint = serviceAccount ? ` Share the folder with ${identity} as Editor.` : ' Check GOOGLE_DRIVE_ROOT_FOLDER_ID and which Google user you signed in as.';
        throw new Error(toStorageError(err, 'open the folder').message + hint);
      });
    inSharedDrive = Boolean(res.data.driveId);
    return `"${res.data.name}", ${inSharedDrive ? 'in a Shared Drive' : 'in My Drive'}`;
  });
  if (serviceAccount && !inSharedDrive) {
    console.log('  NOTE  The folder is in My Drive. A service account can use the spreadsheet there, but usually cannot');
    console.log('        save files. The upload check below gives the definite answer.');
  }

  console.log('\nGoogle Sheets');
  const tables = new TableStore(sheetBackend, ALL_TABLES);
  const sheetsReachable = await step('Open the spreadsheet and confirm all worksheets and headers', () => tables.init());
  if (sheetsReachable) {
    for (const table of ALL_TABLES) {
      await step(`Read "${table.name}"`, async () => `${(await tables.read(table.name)).length} rows`);
    }

    const scratchTab = `_connection_check_${tag}`;
    const scratch = new TableStore(
      sheetBackend,
      [{ name: scratchTab, idKey: 'id', columns: [{ key: 'id', header: 'ID' }, { key: 'text', header: 'Text' }, { key: 'amount', header: 'Amount', type: 'number' }] }],
      0,
    );
    try {
      await step('Create a scratch worksheet with headers', () => scratch.init());
      await step('Append rows (formula-like text must stay as text)', async () => {
        await scratch.append([{ table: scratchTab, rows: [{ id: 'a', text: '=1+1', amount: 1200000 }, { id: 'b', text: '+91 98765 43210', amount: 5 }] }]);
        expectEqual(await scratch.read(scratchTab, { fresh: true }), [
          { id: 'a', text: '=1+1', amount: '1200000' },
          { id: 'b', text: '+91 98765 43210', amount: '5' },
        ], 'Rows read back');
      });
      await step('Update one row by ID', async () => {
        const result = await scratch.updateById(scratchTab, [{ id: 'b', patch: { text: 'updated', amount: 6 } }]);
        expectEqual(result.notFound, [], 'Rows not found');
        expectEqual(await scratch.read(scratchTab, { fresh: true }), [
          { id: 'a', text: '=1+1', amount: '1200000' },
          { id: 'b', text: 'updated', amount: '6' },
        ], 'Rows after update');
      });
    } finally {
      await step('Remove the scratch worksheet', () => sheetBackend.deleteTab(scratchTab));
    }
  }

  console.log('\nGoogle Drive');
  let scratchFolder: string | null = null;
  let scratchFile: string | null = null;
  let organisationWide: string | null = null;
  const content = Buffer.from(`%PDF-1.4\n% connection check ${tag}\n%%EOF\n`);
  try {
    await step('Open the root folder and find or create "Jobs"', async () => {
      const root = config.google!.rootFolderId;
      const jobsFolder = (await driveBackend.findFolder(root, JOBS_FOLDER_NAME)) ?? (await driveBackend.createFolder(root, JOBS_FOLDER_NAME));
      scratchFolder = await driveBackend.createFolder(jobsFolder, `_connection check ${tag}`);
    });
    if (scratchFolder) {
      await step('Upload a file', async () => {
        scratchFile = (await driveBackend.uploadFile({ folderId: scratchFolder!, name: `check-${tag}.pdf`, mimeType: 'application/pdf', data: content })).id;
      });
    }
    if (scratchFile) {
      await step('Download the file and compare it byte for byte', async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of await driveBackend.downloadFile(scratchFile!)) chunks.push(Buffer.from(chunk as Buffer));
        if (!Buffer.concat(chunks).equals(content)) throw new Error('Downloaded content differs from what was uploaded');
      });
      await step('Confirm the file has no public link', async () => {
        // A file inherits the sharing of the folder it is in, so this reports who can reach
        // new resumes. Access for named people is the folder owner's choice; a public link is not acceptable.
        const res = await drive.permissions.list({
          fileId: scratchFile!,
          fields: 'permissions(type,role,emailAddress,domain)',
          supportsAllDrives: true,
        });
        const permissions = res.data.permissions ?? [];
        if (permissions.some((p) => p.type === 'anyone')) {
          throw new Error(
            'Resumes saved here are reachable by anyone with the link, because the Recruitment System folder is shared that way. ' +
              'In Google Drive, open the folder\'s Share dialog and change "General access" to "Restricted".',
          );
        }
        const domains = permissions.filter((p) => p.type === 'domain').map((p) => p.domain);
        const others = permissions.filter((p) => p.role !== 'owner' && (p.type === 'user' || p.type === 'group')).map((p) => p.emailAddress);
        if (domains.length > 0) organisationWide = domains.join(', ');
        return others.length > 0 ? `also shared with: ${others.join(', ')}` : 'only the owner has access';
      });
    }
  } finally {
    if (scratchFile) await step('Move the scratch file to trash', () => driveBackend.trash(scratchFile!));
    if (scratchFolder) await step('Move the scratch folder to trash', () => driveBackend.trash(scratchFolder!));
  }

  if (organisationWide) {
    console.log(`\n  NOTE  The folder is shared with everyone at ${organisationWide}, so anyone in the organisation who has the`);
    console.log('        link can open resumes. Change the folder\'s "General access" to "Restricted" if that is not intended.');
  }
  console.log(failures === 0 ? '\nAll checks passed. Google storage is ready.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: Error) => {
  console.error(`\nCheck could not run: ${err.message}`);
  process.exit(1);
});
