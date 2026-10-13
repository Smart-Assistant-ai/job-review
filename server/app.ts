import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type ErrorRequestHandler, type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import type { ApiErrorBody } from '../shared/types';
import { sameOriginOnly } from './auth';
import type { AppConfig } from './config';
import { createContext, type AppContext, type ContextOptions } from './context';
import { cors } from './cors';
import { HttpError } from './errors';
import { adminRouter } from './routes/admin';
import { publicRouter } from './routes/public';
import { StorageError, type Storage } from './storage';

export interface AppOptions extends ContextOptions {
  config: AppConfig;
  storage: Storage;
  /**
   * How the React app is served: "static" from the production build, "vite"
   * through the Vite dev server (development), or "none" when the site's files
   * are hosted elsewhere and this process only provides the API.
   */
  client: 'static' | 'vite' | 'none';
  /** Folder containing the built React app. Required when client is "static". */
  clientDir?: string;
}

function errorHandler(): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const send = (status: number, body: ApiErrorBody) => res.status(status).json(body);

    if (err instanceof HttpError) {
      return send(err.status, { error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    }

    // Client errors raised by Express itself: malformed or oversized bodies, missing static files.
    const status = (err as { status?: unknown; statusCode?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return send(status, status === 404 ? { error: 'Not found.', code: 'not_found' } : { error: 'The request could not be read.', code: 'bad_request' });
    }

    if (err instanceof StorageError) {
      // Storage messages are written for administrators and contain no secrets or candidate data.
      console.error(`[storage] ${req.method} ${req.path}: ${err.message}`);
      const isAdminRoute = req.originalUrl.includes('/api/admin/');
      return send(err.kind === 'not_found' ? 404 : 503, {
        error: isAdminRoute
          ? err.message
          : 'We could not save your application right now. Please try again in a few minutes.',
        code: `storage_${err.kind}`,
      });
    }

    console.error(`[error] ${req.method} ${req.path}:`, err);
    send(500, { error: 'Something went wrong on our side. Please try again.', code: 'internal' });
  };
}

export async function createApp(options: AppOptions): Promise<{ app: Express; ctx: AppContext }> {
  const { config, storage } = options;
  const ctx = createContext(config, storage, { emailTransport: options.emailTransport });
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      // The Vite dev server injects inline scripts, so the policy applies to production builds only.
      contentSecurityPolicy:
        options.client === 'vite'
          ? false
          : {
              useDefaults: false,
              directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", 'data:', 'blob:'],
                fontSrc: ["'self'", 'data:'],
                connectSrc: ["'self'"],
                // Resume previews are shown from in-memory blob URLs.
                frameSrc: ["'self'", 'blob:'],
                objectSrc: ["'self'", 'blob:'],
                frameAncestors: ["'self'"],
                formAction: ["'self'"],
                baseUri: ["'self'"],
              },
            },
      strictTransportSecurity: config.isProduction,
      crossOriginEmbedderPolicy: false,
      // The site may be served from another port of the same domain.
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  // ---- API ----
  const api = express.Router();
  api.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    next();
  });
  // First, so that every later response (including errors) can be read by the site.
  api.use(cors(config));
  api.use(
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (_req, _res, next) =>
        next(new HttpError(429, 'Too many requests. Please slow down and try again shortly.', { code: 'rate_limited' })),
    }),
  );
  // For uptime monitors.
  api.get('/health', (_req, res) => {
    res.json({ ok: true });
  });
  api.use(cookieParser());
  api.use(sameOriginOnly(config));
  api.use(express.json({ limit: '256kb' }));
  api.use('/public', publicRouter(ctx));
  api.use('/admin', adminRouter(ctx));
  api.use((_req, _res, next) => next(new HttpError(404, 'Not found.', { code: 'not_found' })));

  // Reachable at /api and, when the site lives in a sub-folder, also under that
  // folder, so one reverse-proxy rule for the folder covers the site and its API.
  app.use('/api', api);
  if (config.basePath) app.use(`${config.basePath}/api`, api);

  // ---- React app ----
  if (options.client === 'static') {
    const clientDir = options.clientDir;
    if (!clientDir) throw new Error('clientDir is required when serving the built client');
    const site = express.Router();
    // File names under /assets contain a content hash, so they can be cached indefinitely.
    site.use('/assets', express.static(path.join(clientDir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }));
    site.use(express.static(clientDir, { index: false, maxAge: '1h', dotfiles: 'ignore' }));
    site.get(/.*/, (req, res) => {
      res.set('Cache-Control', 'no-cache');
      if (req.path.startsWith('/admin')) res.set('X-Robots-Tag', 'noindex, nofollow');
      res.sendFile(path.join(clientDir, 'index.html'));
    });
    if (config.basePath) {
      app.use(config.basePath, site);
      app.get('/', (_req, res) => res.redirect(`${config.basePath}/`));
    } else {
      app.use(site);
    }
  } else if (options.client === 'vite') {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  }

  app.use(errorHandler());
  return { app, ctx };
}
