import type { FieldErrors } from '../shared/validation';

/** An error that is safe to show to the person making the request. */
export class HttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly fieldErrors?: FieldErrors;

  constructor(status: number, message: string, options: { code?: string; fieldErrors?: FieldErrors } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = options.code;
    this.fieldErrors = options.fieldErrors;
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} was not found.`, { code: 'not_found' });
