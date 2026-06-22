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

/**
 * 402 `payment_required` (OMS-98): the monthly included quota is used up
 * and the account wallet balance is too low to cover an above-quota
 * (overage) send. Distinct from `OrbotoMailError` with a generic 402 so
 * consumers can branch on `instanceof` to show a top-up / billing UI.
 * Not retryable - the balance won't change without a top-up.
 */
export class PaymentRequiredError extends OrbotoMailError {
  constructor(opts: { statusCode: number; body?: ApiErrorBody; fallbackMessage?: string }) {
    super(opts);
    this.name = 'PaymentRequiredError';
  }
}

/**
 * 503 `wallet_unavailable` (OMS-98): the overage-billing wallet was
 * unreachable, so an above-quota send was NOT dispatched (fail-closed).
 * Transient - inherits `isRetryable=true` from the 503 status, and the
 * SDK auto-retries it like any other 503 before surfacing this.
 */
export class WalletUnavailableError extends OrbotoMailError {
  constructor(opts: { statusCode: number; body?: ApiErrorBody; fallbackMessage?: string }) {
    super(opts);
    this.name = 'WalletUnavailableError';
  }
}

/**
 * Build the right `OrbotoMailError` (sub)class for an API error body.
 * Branches on `reason` so consumers get `instanceof`-able errors for
 * the wallet flow while every error stays an `OrbotoMailError`.
 */
export function createOrbotoMailError(opts: {
  statusCode: number;
  body?: ApiErrorBody;
  fallbackMessage?: string;
}): OrbotoMailError {
  const reason = opts.body?.reason;
  if (opts.statusCode === 402 && reason === 'payment_required') {
    return new PaymentRequiredError(opts);
  }
  if (opts.statusCode === 503 && reason === 'wallet_unavailable') {
    return new WalletUnavailableError(opts);
  }
  return new OrbotoMailError(opts);
}
