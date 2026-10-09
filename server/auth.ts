import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, NextFunction, Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { adminPasswordProblem, type AppConfig } from './config';
import { HttpError } from './errors';

// Specific enough not to collide with cookies of other apps hosted on the same domain.
export const SESSION_COOKIE = 'job_applicants_admin_session';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/**
 * Shared-password admin sign-in with a signed, HTTP-only session cookie.
 *
 * The signing key is derived from both SESSION_SECRET and ADMIN_PASSWORD, so
 * changing either one immediately signs every administrator out.
 */
export class AdminAuth {
  private readonly key: Uint8Array;

  constructor(private readonly config: AppConfig) {
    this.key = createHmac('sha256', config.sessionSecret)
      .update(`admin-session:${config.adminPassword ?? ''}`)
      .digest();
  }

  checkPassword(candidate: string): boolean {
    if (adminPasswordProblem(this.config) || !this.config.adminPassword) return false;
    // Comparing fixed-length digests in constant time leaks nothing about the password.
    return timingSafeEqual(sha256(candidate), sha256(this.config.adminPassword));
  }

  private cookieOptions(req: Request): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure || (this.config.appBaseUrl?.startsWith('https://') ?? false),
      path: '/',
    };
  }

  async signIn(req: Request, res: Response): Promise<void> {
    const seconds = Math.round(this.config.sessionHours * 3600);
    const token = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + seconds)
      .sign(this.key);
    res.cookie(SESSION_COOKIE, token, { ...this.cookieOptions(req), maxAge: seconds * 1000 });
  }

  signOut(req: Request, res: Response): void {
    res.clearCookie(SESSION_COOKIE, this.cookieOptions(req));
  }

  async isAuthenticated(req: Request): Promise<boolean> {
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token === '') return false;
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] });
      return payload.role === 'admin';
    } catch {
      return false;
    }
  }

  /** Express middleware: rejects the request unless it carries a valid admin session. */
  requireAdmin = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (await this.isAuthenticated(req)) next();
    else next(new HttpError(401, 'Please sign in to continue.', { code: 'unauthenticated' }));
  };
}

/**
 * Blocks state-changing requests sent from another website (CSRF). Browsers
 * attach an Origin header to such requests; its host must be this site's.
 * Hosts are compared rather than full origins so that a proxy terminating
 * HTTPS in front of the app cannot cause false rejections.
 */
export function sameOriginOnly(config: AppConfig) {
  const configuredHost = config.appOrigin ? new URL(config.appOrigin).host : null;
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.get('origin');
    if (!origin) return next();
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // "null" or malformed origins never match.
    }
    if (originHost !== null && (originHost === req.get('host') || originHost === configuredHost)) return next();
    next(new HttpError(403, 'This request was blocked because it came from another website.', { code: 'bad_origin' }));
  };
}
