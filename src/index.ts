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
 *     baseUrl: 'https://mail.orboto.io/api', // default
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
 * Docs: https://mail.orboto.io
 */
import { EventEmitter } from 'node:events';

import { OrbotoMailError } from './errors.js';
import { HttpClient } from './http.js';
import { QuotaEmitter } from './quota-emitter.js';
import type {
  ConnectionRevokedEvent,
  InboundDetail,
  InboundListResult,
  QuotaState,
  SendBatchInput,
  SendBatchResult,
  SendInput,
  SendListItem,
  SendListResult,
  SendResult,
  SendTemplateInput,
  SuppressionCheckResult,
  SuppressionEntry,
  Template,
  Webhook,
  WebhookEvent,
  WebhookWithSecret,
} from './types.js';

export type {
  ConnectionRevokedEvent,
  InboundDetail,
  InboundListResult,
  InboundMail,
  MessageTags,
  QuotaState,
  SdkEventMap,
  SdkEventName,
  SendBatchInput,
  SendBatchItemResult,
  SendBatchResult,
  SendInput,
  SendListItem,
  SendListResult,
  SendResult,
  SendTemplateInput,
  SuppressionCheckResult,
  SuppressionEntry,
  SuppressionListResult,
  Template,
  Webhook,
  WebhookEvent,
  WebhookWithSecret,
} from './types.js';
export { OrbotoMailError };

export interface OrbotoMailOptions {
  apiKey?: string;
  /** Override the API base URL. Default `https://mail.orboto.io/api`. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default 10_000. */
  timeout?: number;
  /** Max retries for transient errors (HTTP 502/503/504, network timeouts). Default 3. */
  maxRetries?: number;
  /** Injection point for tests — replace global fetch with a fake. */
  fetch?: typeof fetch;
}

// Default API base URL. The nginx edge at `mail.orboto.io` reverse-
// proxies `/api/v1/*` to the internal Fastify on `:3000`. The
// trailing `/api` IS part of the default base — the SDK's HttpClient
// appends `/v1/send` etc. directly, producing
// `https://mail.orboto.io/api/v1/send` on the wire. See
// `deploy/docker-compose.yml` + `apps/web/nginx.conf` for the
// edge-routing.
const DEFAULT_BASE_URL = 'https://mail.orboto.io/api';

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
  /** Sub-resource: outbound webhook subscriptions. */
  readonly webhooks: WebhooksResource;
  /** Sub-resource: sends-history queries. */
  readonly sends: SendsResource;
  /** Sub-resource: inbound mail (received messages + presigned-URL access to the raw MIME body). */
  readonly inbound: InboundResource;

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
    this.webhooks = new WebhooksResource(this.http);
    this.sends = new SendsResource(this.http);
    this.inbound = new InboundResource(this.http);
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
   * Send multiple messages in one HTTP call. Up to 100 per
   * batch. Per-item processing — partial failures are surfaced in the
   * `results` array; the call as a whole always returns 200. Inspect
   * `summary` + `results[].ok` to decide whether to retry indices.
   *
   * Quota: each item decrements quota individually + in array order.
   * The first quota-exhaust stops further attempts; subsequent items
   * come back with `quotaSkipped=true`.
   */
  async sendBatch(input: SendBatchInput): Promise<SendBatchResult> {
    if (!Array.isArray(input.messages) || input.messages.length === 0) {
      throw new Error('@orboto/mail: sendBatch requires a non-empty `messages` array.');
    }
    if (input.messages.length > 100) {
      throw new Error('@orboto/mail: sendBatch is capped at 100 messages per call.');
    }
    return this.http.request<SendBatchResult>('POST', '/v1/send/batch', input);
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

  async create(input: {
    name: string;
    subject: string;
    bodyHtml?: string;
    bodyText?: string;
    variablesSchema?: Record<string, unknown>;
  }): Promise<Template> {
    return this.http.request<Template>('POST', '/v1/templates', input);
  }

  async update(
    id: string,
    patch: {
      name?: string;
      subject?: string;
      bodyHtml?: string | null;
      bodyText?: string | null;
      variablesSchema?: Record<string, unknown> | null;
    },
  ): Promise<Template> {
    return this.http.request<Template>(
      'PATCH',
      `/v1/templates/${encodeURIComponent(id)}`,
      patch,
    );
  }

  async remove(id: string): Promise<{ ok: true }> {
    return this.http.request<{ ok: true }>(
      'DELETE',
      `/v1/templates/${encodeURIComponent(id)}`,
    );
  }
}

class WebhooksResource {
  constructor(private readonly http: HttpClient) {}

  async list(): Promise<Webhook[]> {
    const res = await this.http.request<{ webhooks: Webhook[] }>('GET', '/v1/webhooks');
    return res.webhooks;
  }

  async get(id: string): Promise<Webhook> {
    return this.http.request<Webhook>('GET', `/v1/webhooks/${encodeURIComponent(id)}`);
  }

  /**
   * Create a new webhook subscription. The returned `secret` field is
   * the plaintext signing key — it is shown exactly once. Persist it
   * immediately; subsequent GETs strip the field.
   */
  async create(input: {
    url: string;
    label?: string;
    eventFilters?: WebhookEvent[];
  }): Promise<WebhookWithSecret> {
    return this.http.request<WebhookWithSecret>('POST', '/v1/webhooks', input);
  }

  async update(
    id: string,
    patch: {
      url?: string;
      label?: string | null;
      eventFilters?: WebhookEvent[];
      enabled?: boolean;
    },
  ): Promise<Webhook> {
    return this.http.request<Webhook>(
      'PATCH',
      `/v1/webhooks/${encodeURIComponent(id)}`,
      patch,
    );
  }

  async remove(id: string): Promise<{ ok: true }> {
    return this.http.request<{ ok: true }>(
      'DELETE',
      `/v1/webhooks/${encodeURIComponent(id)}`,
    );
  }

  /**
   * Re-roll the signing secret. The previous secret is invalidated
   * server-side; the returned `secret` is the new value, shown exactly
   * once.
   */
  async rotateSecret(id: string): Promise<WebhookWithSecret> {
    return this.http.request<WebhookWithSecret>(
      'POST',
      `/v1/webhooks/${encodeURIComponent(id)}/rotate-secret`,
      {},
    );
  }
}

class SendsResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * List sends (most-recent first), cursor-paginated. Pass the previous
   * response's `nextCursor` value to continue. Optional filters: status,
   * region, since (ISO timestamp).
   */
  async list(opts: {
    limit?: number;
    cursor?: string;
    status?: 'queued' | 'delivered' | 'bounced' | 'complained' | 'rejected';
    region?: 'eu-central-1' | 'eu-west-1';
    since?: string;
  } = {}): Promise<SendListResult> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.cursor) params.set('cursor', opts.cursor);
    if (opts.status) params.set('status', opts.status);
    if (opts.region) params.set('region', opts.region);
    if (opts.since) params.set('since', opts.since);
    const query = params.toString();
    return this.http.request<SendListResult>(
      'GET',
      query ? `/v1/sends?${query}` : '/v1/sends',
    );
  }

  async get(id: string): Promise<SendListItem> {
    return this.http.request<SendListItem>('GET', `/v1/sends/${encodeURIComponent(id)}`);
  }
}

class InboundResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * List inbound mails (most-recent first), cursor-paginated.
   * Body is NOT returned in the list response — call `get(id)` for the
   * presigned download-URL.
   */
  async list(opts: { limit?: number; cursor?: string } = {}): Promise<InboundListResult> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.cursor) params.set('cursor', opts.cursor);
    const query = params.toString();
    return this.http.request<InboundListResult>(
      'GET',
      query ? `/v1/inbound?${query}` : '/v1/inbound',
    );
  }

  /**
   * Get one inbound mail + a 15-min presigned-URL for the raw MIME
   * body. Fetch the body from `downloadUrl` directly with `fetch()` —
   * no Bearer needed, the URL is its own credential.
   */
  async get(id: string): Promise<InboundDetail> {
    return this.http.request<InboundDetail>('GET', `/v1/inbound/${encodeURIComponent(id)}`);
  }
}

