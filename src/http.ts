/**
 * Internal HTTP client used by the SDK. Handles:
 *
 * - Authorization header (Bearer-token from constructor)
 * - JSON marshalling
 * - Retry-with-exponential-backoff on transient errors (HTTP 502/503/504
 *   + network timeouts)
 * - Connection-revoked detection (401 reason='connection_revoked'
 *   surfaces as an SDK event)
 * - Quota-event detection (every 2xx response with a `remainingQuota`
 *   field triggers the quota-* event emitter if thresholds crossed)
 *
 * Not exported — this is an implementation detail. Consumers use the
 * `OrbotoMail` class.
 */
import { OrbotoMailError } from './errors.js';
import type { ApiErrorBody, QuotaState } from './types.js';

export interface HttpClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  /** Called for every successful response that carries a quota snapshot. */
  onQuota?: (q: QuotaState) => void;
  /** Called when a 401 with reason='connection_revoked' comes back. */
  onConnectionRevoked?: (message: string) => void;
  /** Injection point for tests — replace global fetch with a fake. */
  fetch?: typeof fetch;
}

export class HttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly onQuota?: (q: QuotaState) => void;
  private readonly onConnectionRevoked?: (message: string) => void;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs;
    this.maxRetries = opts.maxRetries;
    this.onQuota = opts.onQuota;
    this.onConnectionRevoked = opts.onConnectionRevoked;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async request<TResponse>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<TResponse> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': '@orboto/mail/0.1.0',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ac.signal,
        });
        clearTimeout(timer);

        // Read body once — we may need it for both success+failure paths.
        const text = await res.text();
        let parsed: unknown = undefined;
        if (text.length > 0) {
          try {
            parsed = JSON.parse(text);
          } catch {
            // Non-JSON body. Treat as opaque text for the error message.
            if (!res.ok) {
              throw new OrbotoMailError({
                statusCode: res.status,
                fallbackMessage: text.slice(0, 200),
              });
            }
            // 2xx non-JSON is unexpected from OMS; surface generically.
            return undefined as TResponse;
          }
        }

        if (!res.ok) {
          const errBody = parsed as ApiErrorBody | undefined;
          const sdkErr = new OrbotoMailError({ statusCode: res.status, body: errBody });

          // Detect a revoked-connection 401 and fire the SDK event so
          // consumers can disable the relevant integration without
          // waiting for a follow-up call.
          if (
            res.status === 401 &&
            errBody?.reason === 'connection_revoked' &&
            this.onConnectionRevoked
          ) {
            this.onConnectionRevoked(errBody.message);
          }

          if (sdkErr.isRetryable && attempt < this.maxRetries) {
            lastErr = sdkErr;
            await sleepWithBackoff(attempt, sdkErr.retryAfterMs);
            continue;
          }

          throw sdkErr;
        }

        // 2xx path — fire quota event if the response carried a quota
        // snapshot.
        const obj = parsed as Record<string, unknown> | undefined;
        if (obj && typeof obj === 'object' && 'remainingQuota' in obj && this.onQuota) {
          this.onQuota(obj.remainingQuota as QuotaState);
        }

        return parsed as TResponse;
      } catch (err) {
        clearTimeout(timer);
        // AbortError = timeout. Treat as retryable.
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || err.message.includes('aborted'));
        if (isAbort || isNetworkErr(err)) {
          if (attempt < this.maxRetries) {
            lastErr = err;
            await sleepWithBackoff(attempt, undefined);
            continue;
          }
        }
        throw err;
      }
    }
    // Exhausted retries.
    if (lastErr instanceof Error) throw lastErr;
    throw new Error('OMS request failed after retries');
  }
}

function isNetworkErr(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Node's fetch wraps networking errors as `TypeError: fetch failed`
  // with a `cause` chain. Walk the chain for ECONNREFUSED / etc.
  const causes: unknown[] = [err];
  let c: unknown = (err as Error & { cause?: unknown }).cause;
  while (c !== undefined && causes.length < 10) {
    causes.push(c);
    c = (c as Error & { cause?: unknown }).cause;
  }
  for (const cause of causes) {
    const msg = typeof cause === 'object' && cause !== null && 'message' in cause
      ? String((cause as { message: unknown }).message)
      : '';
    if (
      msg.includes('ECONNREFUSED') ||
      msg.includes('ECONNRESET') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('EAI_AGAIN') ||
      msg.includes('fetch failed')
    ) {
      return true;
    }
  }
  return false;
}

async function sleepWithBackoff(attempt: number, retryAfterMs: number | undefined): Promise<void> {
  // Honor server-provided retry-after when present; otherwise
  // exponential backoff with jitter: 100ms, 200ms, 400ms, 800ms…
  const base = retryAfterMs ?? Math.min(8_000, 100 * Math.pow(2, attempt));
  const jitter = Math.random() * 0.25 * base;
  await new Promise((resolve) => setTimeout(resolve, base + jitter));
}
