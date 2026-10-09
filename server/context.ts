import type { Request } from 'express';
import { ApplicationsService } from './applications';
import { AdminAuth } from './auth';
import type { AppConfig } from './config';
import { DownloadTracker } from './downloads';
import { JobsService } from './jobs';
import type { Storage } from './storage';

/** Everything the route handlers need, built once at startup. */
export interface AppContext {
  config: AppConfig;
  storage: Storage;
  jobs: JobsService;
  applications: ApplicationsService;
  auth: AdminAuth;
  downloads: DownloadTracker;
}

export function createContext(config: AppConfig, storage: Storage): AppContext {
  const jobs = new JobsService(storage);
  return {
    config,
    storage,
    jobs,
    applications: new ApplicationsService(storage, jobs, config.timezone),
    auth: new AdminAuth(config),
    downloads: new DownloadTracker(),
  };
}

/**
 * Public address of the site (including any sub-folder), used to build links
 * that people open in a browser. Falls back to the address of this request.
 */
export function publicBaseUrl(ctx: AppContext, req: Request): string {
  return ctx.config.appBaseUrl ?? `${req.protocol}://${req.get('host')}`;
}

/** Content-Disposition value that is safe for any file name, including non-ASCII ones. */
export function contentDisposition(kind: 'attachment' | 'inline', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
