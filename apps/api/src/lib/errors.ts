/** Error codes from docs/03-api.md, plus INTERNAL for unexpected failures. */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'STALE_PRICE'
  | 'MARKET_CLOSED'
  | 'INSUFFICIENT_LIQUIDITY'
  | 'PROOF_INVALID'
  | 'NULLIFIER_SPENT'
  | 'RELAY_FAILED'
  | 'UNAVAILABLE'
  | 'INTERNAL';

export const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'BAD_REQUEST',
  'NOT_FOUND',
  'RATE_LIMITED',
  'STALE_PRICE',
  'MARKET_CLOSED',
  'INSUFFICIENT_LIQUIDITY',
  'PROOF_INVALID',
  'NULLIFIER_SPENT',
  'RELAY_FAILED',
  'UNAVAILABLE',
  'INTERNAL',
]);

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;

  constructor(statusCode: number, code: ErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const badRequest = (message: string) => new ApiError(400, 'BAD_REQUEST', message);
export const notFound = (message: string) => new ApiError(404, 'NOT_FOUND', message);

export interface ErrorBody {
  error: { code: ErrorCode; message: string };
}

export const errorBody = (code: ErrorCode, message: string): ErrorBody => ({ error: { code, message } });
