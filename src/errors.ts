/**
 * Error types for the @orboto/mail SDK. Every non-2xx response from the
 * OMS API becomes an `OrbotoMailError` so consumers have one error
 * class to catch + branch on.
 */
import type { ApiErrorBody, QuotaState } from './types.js';

export class OrbotoMailError extends Error {
  public readonly statusCode: number;
  public readonly reason: string | undefined;
  public readonly remainingQuota: QuotaState | undefined;
  public readonly retryAfterMs: number | undefined;
  public readonly raw: ApiErrorBody | undefined;

  constructor(opts: {
    statusCode: number;
    body?: ApiErrorBody;
    fallbackMessage?: string;
  }) {
    const message =
      opts.body?.message ?? opts.fallbackMessage ?? `OMS request failed with status ${opts.statusCode}`;
    super(message);
    this.name = 'OrbotoMailError';
    this.statusCode = opts.statusCode;
    this.reason = opts.body?.reason;
    this.remainingQuota = opts.body?.remainingQuota;
    this.retryAfterMs = opts.body?.retryAfterMs;
    this.raw = opts.body;
  }

  /** True if the request is worth retrying with backoff (transient). */
  get isRetryable(): boolean {
    if (this.statusCode === 503) return true;
    if (this.statusCode === 502) return true;
    if (this.statusCode === 504) return true;
    return false;
  }
}
