/**
 * Checks the confirmation email, using the same template and the same Resend
 * batch call as the app.
 *
 *   npm run email:test -- you@example.com   sends one sample confirmation to that address
 *   npm run email:test -- --preview         writes the email to a file to open in a browser, sends nothing
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../server/config';
import { ResendTransport } from '../server/email/resend';
import { applicationReceivedEmail } from '../server/email/templates';
import { isValidEmail } from '../shared/validation';
import { loadEnvFile, resolveEnvFile } from './env-file';

async function main(): Promise<void> {
  loadEnvFile(resolveEnvFile());
  const config = loadConfig();
  const args = process.argv.slice(2).filter((arg, i, all) => arg !== '--env' && all[i - 1] !== '--env');

  const content = applicationReceivedEmail({
    companyName: config.companyName,
    jobTitle: 'Customer & Technical Support Executive',
    candidateName: 'Asha Rao',
    applicationId: 'APP-SAMPLE1234',
    submittedAt: new Date().toISOString(),
    timezone: config.timezone,
    repliesMonitored: Boolean(config.email?.replyTo),
  });

  if (args.includes('--preview')) {
    const file = path.join(config.localDataDir, 'email-preview.html');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content.html);
    console.log(`Subject: ${content.subject}\nWritten to ${file}. Open it in a browser.`);
    return;
  }

  const to = args[0]?.trim().toLowerCase() ?? '';
  if (!isValidEmail(to)) {
    console.error('Give the address to send the sample to:  npm run email:test -- you@example.com');
    process.exit(1);
  }
  if (!config.email) {
    console.error(`Confirmation emails are off: ${config.emailProblem ?? 'RESEND_API_KEY and EMAIL_FROM are not set.'}`);
    process.exit(1);
  }

  const { resendApiKey, from, replyTo } = config.email;
  console.log(`Sending a sample confirmation from ${from} to ${to} ...`);
  const transport = new ResendTransport({ apiKey: resendApiKey, from, replyTo });
  const [result] = await transport.sendBatch([{ ref: 'email-test', to, ...content }], randomUUID());
  if (result.ok) {
    console.log(`  PASS  Accepted by Resend${result.id ? ` (ID ${result.id})` : ''}. Check the inbox, and the spam folder.`);
  } else {
    console.log(`  FAIL  Resend refused the message: ${result.reason}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(`  FAIL  ${(err as Error).message}`);
  process.exit(1);
});
