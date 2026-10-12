import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { normalizeBasePath } from '../shared/api-root';
import { createApp } from './app';
import { adminPasswordProblem, ConfigError, loadConfig, type AppConfig } from './config';
import { createStorage } from './storage';

/** Loads .env.local and .env if present. Variables already set in the environment win. */
function loadEnvFiles(): void {
  for (const name of ['.env.local', '.env']) {
    const file = path.resolve(process.cwd(), name);
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

/**
 * Reads the certificate files. Browsers need the whole chain (the site's
 * certificate followed by the authority's intermediates), so a separate
 * bundle file is appended to the certificate when one is configured.
 */
function readTlsFiles(tls: NonNullable<AppConfig['tls']>): { cert: string; key: Buffer } {
  const read = (file: string, setting: string) => {
    try {
      return readFileSync(file);
    } catch {
      throw new ConfigError(`${setting} points to a file that cannot be read: ${file}`);
    }
  };
  const chain = [read(tls.certFile, 'TLS_CERT_FILE').toString('utf8').trim()];
  if (tls.caFile) chain.push(read(tls.caFile, 'TLS_CA_FILE').toString('utf8').trim());
  return { cert: `${chain.join('\n')}\n`, key: read(tls.keyFile, 'TLS_KEY_FILE') };
}

async function main(): Promise<void> {
  loadEnvFiles();
  const config = loadConfig();
  const storage = createStorage(config);

  // In production the built site is served from here if it sits next to the
  // server bundle. When the site's files are hosted elsewhere, only the API runs.
  const clientDir = path.join(import.meta.dirname, 'client');
  const client = !config.isProduction ? 'vite' : existsSync(path.join(clientDir, 'index.html')) ? 'static' : 'none';

  const { app } = await createApp({ config, storage, client, clientDir });

  const server = config.tls ? https.createServer(readTlsFiles(config.tls), app) : http.createServer(app);

  server.listen(config.port, config.host, () => {
    const scheme = config.tls ? 'https' : 'http';
    console.log(`[server] Listening on ${scheme}://localhost:${config.port} (${config.isProduction ? 'production' : 'development'})`);
    console.log(`[server] Site: ${client === 'none' ? 'not served here (API only)' : `served from ${config.basePath || '/'}`}`);
    if (config.appBaseUrl) console.log(`[server] Public site address: ${config.appBaseUrl}`);
    console.log(`[server] Storage: ${storage.kind === 'google' ? 'Google Sheets + Drive' : `local stand-in at ${config.localDataDir}`}`);
    if (storage.kind === 'local' && config.isProduction) {
      console.warn('[server] WARNING: STORAGE_BACKEND=local keeps data on this machine. Use "google" for real recruitment data.');
    }
    // The site is built with VITE_BASE_PATH; links and routes here come from APP_BASE_URL. They must agree.
    const builtFor = normalizeBasePath(process.env.VITE_BASE_PATH);
    if (process.env.VITE_BASE_PATH !== undefined && builtFor !== `${config.basePath}/`) {
      console.warn(`[server] WARNING: VITE_BASE_PATH points to "${builtFor}" but APP_BASE_URL points to "${config.basePath}/". Make the folder the same in both.`);
    }
    const loginProblem = adminPasswordProblem(config);
    if (loginProblem) console.warn(`[server] Admin sign-in is disabled: ${loginProblem}`);
  });

  // Create missing worksheets/headers up front so configuration problems show in the logs at startup.
  storage.tables.init().then(
    () => console.log('[server] Storage is ready.'),
    (err: Error) => console.error(`[server] Storage is not ready: ${err.message}`),
  );

  const shutdown = (signal: string) => {
    console.log(`[server] ${signal} received, shutting down.`);
    server.close(() => process.exit(0));
    // In-flight downloads get a short grace period.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) console.error(`[server] Configuration error: ${err.message}`);
  else console.error('[server] Failed to start:', err);
  process.exit(1);
});
