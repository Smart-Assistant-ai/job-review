import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The env file the scripts read and update: .env.local if present, otherwise .env. */
export function resolveEnvFile(): string {
  const flag = process.argv.indexOf('--env');
  if (flag !== -1 && process.argv[flag + 1]) return path.resolve(process.cwd(), process.argv[flag + 1]);
  const local = path.resolve(process.cwd(), '.env.local');
  const plain = path.resolve(process.cwd(), '.env');
  return existsSync(local) || !existsSync(plain) ? local : plain;
}

export function loadEnvFile(file: string): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

/** Sets KEY=value lines in an env file, replacing existing lines and keeping everything else. */
export function saveEnvValues(file: string, values: Record<string, string>): void {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const index = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (index === -1) {
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.splice(lines.length - 1, 0, line);
      else lines.push(line);
    } else {
      lines[index] = line;
    }
  }
  writeFileSync(file, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  // The file holds credentials: make it readable by its owner only, even if it already existed.
  if (process.platform !== 'win32') chmodSync(file, 0o600);
}
