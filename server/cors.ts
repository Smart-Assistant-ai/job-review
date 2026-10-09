import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from './config';

/**
 * Lets the site call this API from the browser when the two are on different
 * addresses, for example the site at https://example.com/hiring and the API
 * at https://example.com:8799.
 *
 * Only the configured site address (APP_BASE_URL) is allowed, and it is the
 * only one that may send the admin session cookie. Every other website gets
 * no permission at all.
 */
export function cors(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.get('origin');
    if (!origin || origin !== config.appOrigin) return next();

    res.vary('Origin');
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      // Lets the page read the suggested file name of downloads.
      'Access-Control-Expose-Headers': 'Content-Disposition',
    });

    // Browsers ask permission first for anything beyond a simple request.
    if (req.method === 'OPTIONS' && req.get('access-control-request-method')) {
      res.set({
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      });
      res.status(204).end();
      return;
    }
    next();
  };
}
