/**
 * @orboto/mail — Official TypeScript SDK for the Orboto Mail Service.
 *
 * Usage:
 *
 *   import { OrbotoMail } from '@orboto/mail';
 *
 *   // Auto-loads OMS_API_KEY from process.env (uses dotenv if available).
 *   const mail = new OrbotoMail();
 *
 *   // Explicit construction:
 *   const mail = new OrbotoMail({
 *     apiKey: 'oms_live_xxx',
 *     baseUrl: 'https://mail.orboto.io', // default
 *     timeout: 10_000,
 *   });
 *
 *   const result = await mail.send({
 *     from: 'noreply@acme.orbo.to',
 *     to: 'user@example.com',
 *     subject: 'Welcome',
 *     html: '<h1>Welcome!</h1>',
 *   });
 *
 *   // result.messageId      — SES message-id
 *   // result.status         — 'queued' at success-time
 *   // result.remainingQuota — quota state AFTER this send
 *
 *   // Subscribe to lifecycle events:
 *   mail.on('quota-warning',   (q) => console.warn('80%', q));
 *   mail.on('quota-low',       (q) => console.warn('95%', q));
 *   mail.on('quota-exhausted', (q) => console.error('done', q));
 *   mail.on('connection-revoked', (e) => console.error(e.message));
 *
 * Full architecture: `evaluation/adr-orboto-mail-service.md` in
 * `orboto-internal-docs`.
 */
import { EventEmitter } from 'node:events';

import { OrbotoMailError } from './errors.js';
import { HttpClient } from './http.js';
import { QuotaEmitter } from './quota-emitter.js';
import type {
  ConnectionRevokedEvent,
  QuotaState,
  SendInput,
  SendResult,
  SendTemplateInput,
  SuppressionCheckResult,
  SuppressionEntry,
  Template,
} from './types.js';

export type {
  ConnectionRevokedEvent,
  MessageTags,
  QuotaState,
  SdkEventMap,
  SdkEventName,
  SendInput,
  SendResult,
  SendTemplateInput,
  SuppressionCheckResult,
  SuppressionEntry,
  Template,
} from './types.js';
export { OrbotoMailError };

export interface OrbotoMailOptions {
  apiKey?: string;
  /** Override the API base URL. Default `https://mail.orboto.io`. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default 10_000. */
  timeout?: number;
  /** Max retries for transient errors (HTTP 502/503/504, network timeouts). Default 3. */
  maxRetries?: number;
  /** Injection point for tests — replace global fetch with a fake. */
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://mail.orboto.io';

/**
 * Lazily load dotenv if it's installed in the consumer's project. We
 * never throw if dotenv isn't present — callers who use Vite / Next /
 * any other env-loader work just as well.
 */
function tryLoadDotenv(): void {
  // dotenv is a peer-pattern dependency. The SDK has it as a direct
  // dep so `new OrbotoMail()` Just Works in a Node script with a .env
  // file, but we still guard the load so an exotic environment
  // (Cloudflare Workers, Deno) doesn't crash on require.
  try {
    // Synchronous require via dynamic import isn't great in ESM; use
    // the side-effect import which dotenv exports.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dotenv = require('dotenv') as { config: () => unknown };
    dotenv.config();
  } catch {
    // No-op. dotenv unavailable → caller is presumed to have set env vars themselves.
  }
}

export class OrbotoMail extends EventEmitter {
  private readonly http: HttpClient;
  private readonly quotaEmitter: QuotaEmitter;

  /** Sub-resource: suppression-list operations. */
  readonly suppression: SuppressionResource;
  /** Sub-resource: template operations. */
  readonly templates: TemplatesResource;

  constructor(opts: OrbotoMailOptions = {}) {
    super();
    // Resolve API key: explicit option > OMS_API_KEY env var > dotenv-loaded env var.
    let apiKey = opts.apiKey;
    if (apiKey === undefined && typeof process !== 'undefined' && process.env) {
      if (process.env.OMS_API_KEY === undefined) {
        tryLoadDotenv();
      }
      apiKey = process.env.OMS_API_KEY;
    }
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(
        '@orboto/mail: no API key provided. Pass `apiKey` to the constructor or set OMS_API_KEY in your environment.',
      );
    }

    const envBaseUrl =
      typeof process !== 'undefined' && process.env?.OMS_BASE_URL
        ? process.env.OMS_BASE_URL
        : undefined;
    const baseUrl = opts.baseUrl ?? envBaseUrl ?? DEFAULT_BASE_URL;

    this.quotaEmitter = new QuotaEmitter();
    this.http = new HttpClient({
      apiKey,
      baseUrl,
      timeoutMs: opts.timeout ?? 10_000,
      maxRetries: opts.maxRetries ?? 3,
      fetch: opts.fetch,
      onQuota: (q) => {
        const events = this.quotaEmitter.inspect(q);
        for (const ev of events) {
          this.emit(ev, q);
        }
      },
      onConnectionRevoked: (message: string) => {
        const ev: ConnectionRevokedEvent = { reason: 'connection_revoked', message };
        this.emit('connection-revoked', ev);
      },
    });

    this.suppression = new SuppressionResource(this.http);
    this.templates = new TemplatesResource(this.http);
  }

  /**
   * Send a transactional email.
   *
   * Throws `OrbotoMailError` on any non-2xx response. The error
   * carries `.reason` (e.g. `quota_exhausted_no_overage_opted_in`,
   * `from_domain_not_authorized`, `recipient_suppressed`) so the
   * caller can render an actionable message.
   *
   * Retries: transient errors (HTTP 503 + network timeouts) auto-retry
   * up to `maxRetries` times with exponential backoff.
   */
  async send(input: SendInput): Promise<SendResult> {
    if (input.html === undefined && input.text === undefined) {
      throw new Error('@orboto/mail: send requires at least one of `html` or `text`.');
    }
    return this.http.request<SendResult>('POST', '/v1/send', input);
  }

  /**
   * Render a template + send. Equivalent to `send({...})` with the
   * template-id resolved server-side. Server validates `variables`
   * against the template's variables-schema; missing/wrong-typed vars
   * return 400 `template_variable_validation`.
   */
  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    return this.http.request<SendResult>('POST', '/v1/send/template', input);
  }

  /** Standalone quota-check. Useful for "should I send a batch?" planning. */
  async getQuota(): Promise<QuotaState> {
    const res = await this.http.request<{ quota: QuotaState }>('GET', '/v1/quota');
    return res.quota;
  }
}

class SuppressionResource {
  constructor(private readonly http: HttpClient) {}

  /** Check whether an address is on the customer's suppression list. */
  async check(email: string): Promise<SuppressionCheckResult> {
    return this.http.request<SuppressionCheckResult>(
      'GET',
      `/v1/suppression/${encodeURIComponent(email)}`,
    );
  }

  /** Manually add an address to the suppression list. */
  async add(email: string, reason: SuppressionEntry['reason'] = 'manual'): Promise<SuppressionEntry> {
    return this.http.request<SuppressionEntry>('POST', '/v1/suppression', { email, reason });
  }

  /** Remove an address (false-positive recovery). */
  async remove(email: string): Promise<{ ok: true }> {
    return this.http.request<{ ok: true }>(
      'DELETE',
      `/v1/suppression/${encodeURIComponent(email)}`,
    );
  }
}

class TemplatesResource {
  constructor(private readonly http: HttpClient) {}

  async list(): Promise<Template[]> {
    const res = await this.http.request<{ templates: Template[] }>('GET', '/v1/templates');
    return res.templates;
  }

  async get(id: string): Promise<Template> {
    return this.http.request<Template>('GET', `/v1/templates/${encodeURIComponent(id)}`);
  }
}
