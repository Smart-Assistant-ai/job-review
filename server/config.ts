import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { CURRENCIES, type Currency } from '../shared/constants';

/**
 * How the server signs in to Google. Both kinds of credential stay on the
 * server: nothing here is ever sent to the browser or built into the site.
 */
export type GoogleAuthConfig =
  | {
      /** Acts as a real Google user through a refresh token created by `npm run google:setup`. */
      mode: 'oauth';
      clientId: string;
      clientSecret: string;
      refreshToken: string;
    }
  | {
      /**
       * Acts as a service account. It can only reach items shared with it. It has
       * no Drive storage of its own, so it can save files only inside a Shared Drive.
       */
      mode: 'service_account';
      /** Path to the JSON key file downloaded from Google Cloud... */
      keyFile: string | null;
      /** ...or the two values from that file, supplied directly. */
      clientEmail: string | null;
      privateKey: string | null;
    };

export interface GoogleConfig {
  auth: GoogleAuthConfig;
  rootFolderId: string;
  sheetId: string;
}

export interface AppConfig {
  port: number;
  host: string;
  /** Express "trust proxy" setting: number of reverse-proxy hops in front of the app. */
  trustProxy: number;
  isProduction: boolean;
  companyName: string;
  /** Public address of the site without a trailing slash, e.g. https://example.com/job-applicants-review */
  appBaseUrl: string | null;
  /** Scheme and host of that address, e.g. https://example.com. Requests from it are accepted cross-origin. */
  appOrigin: string | null;
  /** Sub-folder part of that address, e.g. "/job-applicants-review", or "" at the root of the domain. */
  basePath: string;
  /** Set to serve HTTPS directly from this process instead of through a reverse proxy. */
  tls: { certFile: string; keyFile: string } | null;
  adminPassword: string | null;
  sessionSecret: string;
  sessionHours: number;
  storageBackend: 'google' | 'local';
  /** Which kind of Google sign-in is selected, whether or not it is fully configured yet. */
  googleAuthMode: GoogleAuthConfig['mode'];
  google: GoogleConfig | null;
  /** Names of the Google settings still missing when the Google backend is selected. */
  googleMissing: string[];
  localDataDir: string;
  maxResumeBytes: number;
  defaultCurrency: Currency;
  timezone: string;
  submissionsPerIpPerHour: number;
  loginAttemptsPer15Min: number;
}

export const MIN_ADMIN_PASSWORD_LENGTH = 12;
const MIN_SESSION_SECRET_LENGTH = 32;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

/** Reads and validates configuration from environment variables. */
export function loadConfig(source: Env = process.env): AppConfig {
  const env = (name: string): string | undefined => {
    const value = source[name]?.trim();
    return value ? value : undefined;
  };
  const positiveNumber = (name: string, fallback: number): number => {
    const raw = env(name);
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive number.`);
    return n;
  };

  const isProduction = env('NODE_ENV') === 'production';

  const backendRaw = (env('STORAGE_BACKEND') ?? 'google').toLowerCase();
  if (backendRaw !== 'google' && backendRaw !== 'local') {
    throw new ConfigError('STORAGE_BACKEND must be "google" or "local".');
  }

  const serviceAccount = {
    keyFile: env('GOOGLE_SERVICE_ACCOUNT_KEY_FILE'),
    clientEmail: env('GOOGLE_SERVICE_ACCOUNT_EMAIL'),
    // Env files store the key on one line with "\n" where the line breaks belong.
    privateKey: env('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY')?.replace(/\\n/g, '\n'),
  };
  const oauth = {
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
    refreshToken: env('GOOGLE_REFRESH_TOKEN'),
  };
  const rootFolderId = env('GOOGLE_DRIVE_ROOT_FOLDER_ID');
  const sheetId = env('GOOGLE_SHEET_ID');

  const modeRaw = env('GOOGLE_AUTH_MODE')?.toLowerCase().replace(/-/g, '_');
  if (modeRaw !== undefined && modeRaw !== 'oauth' && modeRaw !== 'service_account') {
    throw new ConfigError('GOOGLE_AUTH_MODE must be "service_account" or "oauth".');
  }
  // Without an explicit choice, service-account settings win if any are present.
  const authMode: GoogleAuthConfig['mode'] =
    modeRaw ?? (serviceAccount.keyFile || serviceAccount.clientEmail || serviceAccount.privateKey ? 'service_account' : 'oauth');

  const googleMissing: string[] = [];
  let googleAuth: GoogleAuthConfig | null = null;
  if (authMode === 'service_account') {
    const hasPair = Boolean(serviceAccount.clientEmail && serviceAccount.privateKey);
    if (serviceAccount.keyFile || hasPair) {
      googleAuth = {
        mode: 'service_account',
        keyFile: serviceAccount.keyFile ? path.resolve(process.cwd(), serviceAccount.keyFile) : null,
        clientEmail: serviceAccount.clientEmail ?? null,
        privateKey: serviceAccount.privateKey ?? null,
      };
    } else {
      googleMissing.push('GOOGLE_SERVICE_ACCOUNT_KEY_FILE');
    }
  } else {
    if (!oauth.clientId) googleMissing.push('GOOGLE_CLIENT_ID');
    if (!oauth.clientSecret) googleMissing.push('GOOGLE_CLIENT_SECRET');
    if (!oauth.refreshToken) googleMissing.push('GOOGLE_REFRESH_TOKEN');
    if (oauth.clientId && oauth.clientSecret && oauth.refreshToken) {
      googleAuth = { mode: 'oauth', clientId: oauth.clientId, clientSecret: oauth.clientSecret, refreshToken: oauth.refreshToken };
    }
  }
  if (!rootFolderId) googleMissing.push('GOOGLE_DRIVE_ROOT_FOLDER_ID');
  if (!sheetId) googleMissing.push('GOOGLE_SHEET_ID');
  const google: GoogleConfig | null =
    googleAuth && rootFolderId && sheetId ? { auth: googleAuth, rootFolderId, sheetId } : null;

  let sessionSecret = env('SESSION_SECRET');
  if (sessionSecret && sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new ConfigError(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters. Generate one with: openssl rand -hex 32`,
    );
  }
  if (!sessionSecret) {
    if (isProduction) {
      throw new ConfigError('SESSION_SECRET is not set. Generate one with: openssl rand -hex 32');
    }
    // Development convenience: admin sessions simply reset when the server restarts.
    sessionSecret = randomBytes(32).toString('hex');
  }

  const defaultCurrency = (env('DEFAULT_CURRENCY') ?? 'INR').toUpperCase();
  if (!(CURRENCIES as readonly string[]).includes(defaultCurrency)) {
    throw new ConfigError(`DEFAULT_CURRENCY must be one of: ${CURRENCIES.join(', ')}.`);
  }

  const timezone = env('APP_TIMEZONE') ?? 'Asia/Kolkata';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
  } catch {
    throw new ConfigError(`APP_TIMEZONE "${timezone}" is not a valid IANA time zone.`);
  }

  let appBaseUrl: string | null = null;
  let appOrigin: string | null = null;
  let basePath = '';
  const baseUrlRaw = env('APP_BASE_URL');
  if (baseUrlRaw) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrlRaw);
    } catch {
      throw new ConfigError('APP_BASE_URL must be a full URL such as https://example.com/job-applicants-review');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ConfigError('APP_BASE_URL must start with http:// or https://');
    }
    appOrigin = parsed.origin;
    basePath = parsed.pathname.replace(/\/+$/, '');
    appBaseUrl = appOrigin + basePath;
  }

  const certFile = env('TLS_CERT_FILE');
  const keyFile = env('TLS_KEY_FILE');
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new ConfigError('Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither.');
  }

  const trustProxyRaw = env('TRUST_PROXY') ?? '0';
  const trustProxy = Number(trustProxyRaw);
  if (!Number.isInteger(trustProxy) || trustProxy < 0) {
    throw new ConfigError('TRUST_PROXY must be the number of reverse proxies in front of the app (0, 1, 2...).');
  }

  return {
    port: Math.round(positiveNumber('PORT', 3000)),
    host: env('HOST') ?? '0.0.0.0',
    trustProxy,
    isProduction,
    companyName: env('COMPANY_NAME') ?? 'Careers',
    appBaseUrl,
    appOrigin,
    basePath,
    tls: certFile && keyFile ? { certFile: path.resolve(process.cwd(), certFile), keyFile: path.resolve(process.cwd(), keyFile) } : null,
    adminPassword: env('ADMIN_PASSWORD') ?? null,
    sessionSecret,
    sessionHours: positiveNumber('SESSION_HOURS', 12),
    storageBackend: backendRaw,
    googleAuthMode: authMode,
    google,
    googleMissing,
    localDataDir: path.resolve(process.cwd(), env('LOCAL_DATA_DIR') ?? '.data'),
    maxResumeBytes: Math.round(positiveNumber('MAX_RESUME_SIZE_MB', 5) * 1024 * 1024),
    defaultCurrency: defaultCurrency as Currency,
    timezone,
    submissionsPerIpPerHour: Math.round(positiveNumber('SUBMISSIONS_PER_IP_PER_HOUR', 10)),
    loginAttemptsPer15Min: Math.round(positiveNumber('LOGIN_ATTEMPTS_PER_15_MIN', 10)),
  };
}

/** Why admin sign-in is unavailable, or null when it is correctly configured. */
export function adminPasswordProblem(config: AppConfig): string | null {
  if (!config.adminPassword) return 'ADMIN_PASSWORD is not set on the server.';
  if (config.adminPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return `ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}
