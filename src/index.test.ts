/**
 * @orboto/mail SDK tests. All in-memory — no DB, no network. Uses a
 * fetch-shaped mock injected via the constructor's `fetch` option.
 *
 * Coverage:
 *   - constructor auto-loads OMS_API_KEY from env
 *   - throws when no key available
 *   - send() returns the full response shape including remainingQuota
 *   - send() fires quota events at the right thresholds
 *   - send() fires quota events at-most-once-per-reset
 *   - sendTemplate() routes to /v1/send/template
 *   - getQuota() unwraps the {quota: ...} envelope
 *   - suppression.check/add/remove route correctly
 *   - templates.list/get route correctly
 *   - 503 with auto-retry — succeeds on 2nd attempt
 *   - 401 with reason=connection_revoked fires the SDK event
 *   - OrbotoMailError preserves reason + remainingQuota + retry info
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OrbotoMail,
  OrbotoMailError,
  PaymentRequiredError,
  WalletUnavailableError,
} from './index.js';
import type { QuotaState, SendResult } from './types.js';

function fakeFetch(handler: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return ((url: string | URL, init?: RequestInit): Promise<Response> =>
    handler(String(url), init ?? {})) as typeof fetch;
}

function healthyQuota(overrides: Partial<QuotaState> = {}): QuotaState {
  return {
    current: 100,
    total: 10_000,
    resetAt: '2026-06-01T00:00:00Z',
    percentUsed: 0.01,
    softWarnAt: 0.8,
    softWarnTriggered: false,
    ...overrides,
  };
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OrbotoMail constructor', () => {
  beforeEach(() => {
    delete process.env.OMS_API_KEY;
    delete process.env.OMS_BASE_URL;
  });

  it('reads OMS_API_KEY from env by default', () => {
    process.env.OMS_API_KEY = 'oms_live_aaa';
    const mail = new OrbotoMail();
    expect(mail).toBeInstanceOf(OrbotoMail);
  });

  it('accepts explicit apiKey + baseUrl', () => {
    const mail = new OrbotoMail({ apiKey: 'oms_test_zzz', baseUrl: 'https://example.test' });
    expect(mail).toBeInstanceOf(OrbotoMail);
  });

  it('throws if no key is available', () => {
    expect(() => new OrbotoMail()).toThrowError(/no API key/i);
  });
});

describe('OrbotoMail.send', () => {
  beforeEach(() => {
    process.env.OMS_API_KEY = 'oms_live_test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to /v1/send and returns the full response shape', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const mail = new OrbotoMail({
      apiKey: 'oms_live_aaa',
      baseUrl: 'https://example.test',
      fetch: fakeFetch(async (url, init) => {
        calls.push({ url, init });
        const body: SendResult = {
          messageId: 'msg_abc',
          status: 'queued',
          remainingQuota: healthyQuota({ current: 101, percentUsed: 0.0101 }),
          overage: false,
        };
        return okResponse(body);
      }),
    });

    const result = await mail.send({
      from: 'noreply@acme.orbo.to',
      to: 'user@example.com',
      subject: 'Welcome',
      html: '<h1>Welcome!</h1>',
    });

    expect(result.messageId).toBe('msg_abc');
    expect(result.status).toBe('queued');
    expect(result.remainingQuota.current).toBe(101);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.test/v1/send');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      'Bearer oms_live_aaa',
    );
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      from: 'noreply@acme.orbo.to',
      to: 'user@example.com',
    });
  });

  it('throws OrbotoMailError on 402 quota_exhausted preserving remainingQuota', async () => {
    const mail = new OrbotoMail({
      apiKey: 'oms_live_aaa',
      baseUrl: 'https://example.test',
      fetch: fakeFetch(async () =>
        errorResponse(402, {
          error: 'quota_exhausted',
          reason: 'overage_cap_exceeded',
          message: 'Customer reached the 75,000 monthly maximum.',
          remainingQuota: healthyQuota({ current: 75_000, total: 75_000, percentUsed: 1, capReason: 'overage_cap' }),
        }),
      ),
    });

    await expect(
      mail.send({ from: 'a@a.test', to: 'b@b.test', subject: 's', text: 't' }),
    ).rejects.toMatchObject({
      statusCode: 402,
      reason: 'overage_cap_exceeded',
    });

    try {
      await mail.send({ from: 'a@a.test', to: 'b@b.test', subject: 's', text: 't' });
    } catch (e) {
      expect(e).toBeInstanceOf(OrbotoMailError);
      const err = e as OrbotoMailError;
      expect(err.remainingQuota?.current).toBe(75_000);
      expect(err.remainingQuota?.capReason).toBe('overage_cap');
    }
  });

  it('throws PaymentRequiredError on 402 payment_required (OMS-98)', async () => {
    const mail = new OrbotoMail({
      apiKey: 'oms_live_aaa',
      baseUrl: 'https://example.test',
      fetch: fakeFetch(async () =>
        errorResponse(402, {
          error: 'payment_required',
          reason: 'payment_required',
          message: 'Wallet balance too low to cover overage.',
          remainingQuota: healthyQuota({ current: 100, total: 100, percentUsed: 1 }),
        }),
      ),
    });

    try {
      await mail.send({ from: 'a@a.test', to: 'b@b.test', subject: 's', text: 't' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(PaymentRequiredError);
      expect(e).toBeInstanceOf(OrbotoMailError); // still the base type
      const err = e as PaymentRequiredError;
      expect(err.statusCode).toBe(402);
      expect(err.reason).toBe('payment_required');
      expect(err.isRetryable).toBe(false);
      expect(err.remainingQuota?.current).toBe(100);
    }
  });

  it('throws WalletUnavailableError on 503 wallet_unavailable after retries (OMS-98)', async () => {
    let calls = 0;
    const mail = new OrbotoMail({
      apiKey: 'oms_live_aaa',
      baseUrl: 'https://example.test',
      maxRetries: 1,
      fetch: fakeFetch(async () => {
        calls += 1;
        return errorResponse(503, {
          error: 'wallet_unavailable',
          reason: 'wallet_unavailable',
          message: 'Overage billing temporarily unavailable.',
        });
      }),
    });

    try {
      await mail.send({ from: 'a@a.test', to: 'b@b.test', subject: 's', text: 't' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(WalletUnavailableError);
      expect(e).toBeInstanceOf(OrbotoMailError);
      const err = e as WalletUnavailableError;
      expect(err.statusCode).toBe(503);
      expect(err.isRetryable).toBe(true);
    }
    // 503 is retryable → the SDK retried before surfacing the error.
    expect(calls).toBe(2); // initial + 1 retry
  });

  it('requires html or text', async () => {
    const mail = new OrbotoMail({
      apiKey: 'oms_live_aaa',
      fetch: fakeFetch(async () => okResponse({})),
    });
    await expect(mail.send({ from: 'a@a.test', to: 'b@b.test', subject: 's' } as never)).rejects.toThrow(
      /html.*text/i,
    );
  });
});

describe('OrbotoMail quota events', () => {
  beforeEach(() => {
    process.env.OMS_API_KEY = 'oms_live_test';
  });

  it('fires quota-warning at >=80% base usage', async () => {
    const mail = new OrbotoMail({
      apiKey: 'oms_live_aaa',
      baseUrl: 'https://example.test',
      fetch: fakeFetch(async () =>
        okResponse({
          messageId: 'm1',
          status: 'queued',
          remainingQuota: healthyQuota({ current: 8_000, percentUsed: 0.8 }),
          overage: false,
        }),
      ),
    });
    const events: QuotaState[] = [];
    mail.on('quota-warning', (q) => events.push(q));
    await mail.send({ from: 'a@a.test', to: 'b@b.test', subject: 's', text: 't' });
    expect(events).toHaveLength(1);
    expect(events[0].percentUsed).toBe(0.8);
  });

  it('fires quota-warning only once per reset window', async () => {
    let percentUsed = 0.81;
    const mail = new OrbotoMail({
      apiKey: 'oms_live_aaa',
      baseUrl: 'https://example.test',
      fetch: fakeFetch(async () =>
        okResponse({
          messageId: 'm',
          status: 'queued',
          remainingQuota: healthyQuota({ percentUsed }),
          overage: false,
        }),
      ),
    });
    const events: QuotaState[] = [];
    mail.on('quota-warning', (q) => events.push(q));
    await mail.send({ from: 'a@a.test', to: 'b@b.test', subject: 's', text: 't' });
    percentUsed = 0.82;
    await mail.send({ from: 'a@a.test', to: 'b@b.test', subject: 's', text: 't' });
    percentUsed = 0.83;
    await mail.send({ from: 'a@a.test', to: 'b@b.test', subject: 's', text: 't' });
    expect(events).toHaveLength(1);
  });

  it('fires quota-low and quota-exhausted at the right thresholds', async () => {
    const states: QuotaState[] = [
      healthyQuota({ percentUsed: 0.5 }),
      healthyQuota({ percentUsed: 0.96 }),
      healthyQuota({ percentUsed: 1.0 }),
    ];
    let i = 0;
    const mail = new OrbotoMail({
      apiKey: 'oms_live_aaa',
      baseUrl: 'https://example.test',
      fetch: fakeFetch(async () =>
        okResponse({
          messageId: 'm',
          status: 'queued',
          remainingQuota: states[i++],
          overage: false,
        }),
      ),
    });
    const warnings: QuotaState[] = [];
    const lows: QuotaState[] = [];
    const exhausted: QuotaState[] = [];
    mail.on('quota-warning', (q) => warnings.push(q));
    mail.on('quota-low', (q) => lows.push(q));
    mail.on('quota-exhausted', (q) => exhausted.push(q));

    await mail.send({ from: 'a@a.test', to: 'b@b.test', subject: 's', text: 't' });
    await mail.send({ from: 'a@a.test', to: 'b@b.test', subject: 's', text: 't' });
    await mail.send({ from: 'a@a.test', to: 'b@b.test', subject: 's', text: 't' });

    // 50% → no events
    // 96% → warning + low fire (warning catches up because we passed 80% without seeing it)
    // 100% → exhausted fires
    expect(warnings).toHaveLength(1);
    expect(lows).toHaveLength(1);
    expect(exhausted).toHaveLength(1);
  });
});

describe('OrbotoMail retry-with-backoff', () => {
  beforeEach(() => {
    process.env.OMS_API_KEY = 'oms_live_test';
  });

  it('retries on HTTP 503 and succeeds on the next attempt', async () => {
    let calls = 0;
    const mail = new OrbotoMail({
      apiKey: 'oms_live_aaa',
      baseUrl: 'https://example.test',
      maxRetries: 3,
      fetch: fakeFetch(async () => {
        calls++;
        if (calls < 2) {
          return errorResponse(503, {
            error: 'service_unavailable',
            reason: 'transport_transient_error',
            message: 'Transport eu-central-1 transient error, retry.',
            retryAfterMs: 10,
          });
        }
        return okResponse({
          messageId: 'msg_retried_ok',
          status: 'queued',
          remainingQuota: healthyQuota(),
          overage: false,
        });
      }),
    });

    const result = await mail.send({
      from: 'a@a.test',
      to: 'b@b.test',
      subject: 'retry',
      text: 'retry',
    });
    expect(result.messageId).toBe('msg_retried_ok');
    expect(calls).toBe(2);
  });

  it('gives up after maxRetries exhausted', async () => {
    let calls = 0;
    const mail = new OrbotoMail({
      apiKey: 'oms_live_aaa',
      baseUrl: 'https://example.test',
      maxRetries: 2,
      fetch: fakeFetch(async () => {
        calls++;
        return errorResponse(503, {
          error: 'service_unavailable',
          message: 'still down',
          retryAfterMs: 5,
        });
      }),
    });
    await expect(
      mail.send({ from: 'a@a.test', to: 'b@b.test', subject: 's', text: 't' }),
    ).rejects.toBeInstanceOf(OrbotoMailError);
    // initial attempt + 2 retries = 3 calls
    expect(calls).toBe(3);
  });
});

describe('OrbotoMail connection-revoked event', () => {
  beforeEach(() => {
    process.env.OMS_API_KEY = 'oms_live_test';
  });

  it('fires connection-revoked on 401 with reason=connection_revoked', async () => {
    const mail = new OrbotoMail({
      apiKey: 'oms_live_aaa',
      baseUrl: 'https://example.test',
      fetch: fakeFetch(async () =>
        errorResponse(401, {
          error: 'unauthorized',
          reason: 'connection_revoked',
          message: 'Parent OAuth connection revoked by customer.',
        }),
      ),
    });
    const events: unknown[] = [];
    mail.on('connection-revoked', (e) => events.push(e));

    await expect(
      mail.send({ from: 'a@a.test', to: 'b@b.test', subject: 's', text: 't' }),
    ).rejects.toBeInstanceOf(OrbotoMailError);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: 'connection_revoked',
      message: expect.stringContaining('revoked'),
    });
  });
});

describe('OrbotoMail sub-resources', () => {
  beforeEach(() => {
    process.env.OMS_API_KEY = 'oms_live_test';
  });

  it('templates.list unwraps {templates: [...]}', async () => {
    const mail = new OrbotoMail({
      apiKey: 'oms_live_aaa',
      baseUrl: 'https://example.test',
      fetch: fakeFetch(async () =>
        okResponse({
          templates: [
            {
              id: 't_1',
              name: 'welcome',
              subject: 'Welcome!',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          ],
        }),
      ),
    });
    const templates = await mail.templates.list();
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe('welcome');
  });

  it('templates.get hits /v1/templates/:id with URL-encoded id', async () => {
    let capturedUrl = '';
    const mail = new OrbotoMail({
      apiKey: 'oms_live_aaa',
      baseUrl: 'https://example.test',
      fetch: fakeFetch(async (url) => {
        capturedUrl = url;
        return okResponse({
          id: 't slash',
          name: 'x',
          subject: 'x',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        });
      }),
    });
    await mail.templates.get('t slash');
    expect(capturedUrl).toBe('https://example.test/v1/templates/t%20slash');
  });

  it('suppression.check returns suppressed=true with entry', async () => {
    const mail = new OrbotoMail({
      apiKey: 'oms_live_aaa',
      baseUrl: 'https://example.test',
      fetch: fakeFetch(async () =>
        okResponse({
          email: 'bouncer@example.com',
          suppressed: true,
          entry: {
            email: 'bouncer@example.com',
            reason: 'hard-bounce',
            addedAt: '2026-04-01T00:00:00Z',
            addedBy: 'system',
          },
        }),
      ),
    });
    const r = await mail.suppression.check('bouncer@example.com');
    expect(r.suppressed).toBe(true);
    expect(r.entry?.reason).toBe('hard-bounce');
  });

  it('suppression.add POSTs to /v1/suppression', async () => {
    let capturedMethod = '';
    let capturedBody = '';
    const mail = new OrbotoMail({
      apiKey: 'oms_live_aaa',
      baseUrl: 'https://example.test',
      fetch: fakeFetch(async (_url, init) => {
        capturedMethod = init.method ?? '';
        capturedBody = String(init.body);
        return okResponse({
          email: 'opt-out@example.com',
          reason: 'manual',
          addedAt: '2026-05-14T00:00:00Z',
          addedBy: 'manual',
        });
      }),
    });
    const r = await mail.suppression.add('opt-out@example.com', 'manual');
    expect(capturedMethod).toBe('POST');
    expect(JSON.parse(capturedBody)).toEqual({ email: 'opt-out@example.com', reason: 'manual' });
    expect(r.reason).toBe('manual');
  });

  it('suppression.remove DELETEs', async () => {
    let capturedMethod = '';
    const mail = new OrbotoMail({
      apiKey: 'oms_live_aaa',
      baseUrl: 'https://example.test',
      fetch: fakeFetch(async (_url, init) => {
        capturedMethod = init.method ?? '';
        return okResponse({ ok: true });
      }),
    });
    await mail.suppression.remove('opt-out@example.com');
    expect(capturedMethod).toBe('DELETE');
  });

  it('getQuota unwraps the {quota: ...} envelope', async () => {
    const mail = new OrbotoMail({
      apiKey: 'oms_live_aaa',
      baseUrl: 'https://example.test',
      fetch: fakeFetch(async () => okResponse({ quota: healthyQuota({ current: 4321 }) })),
    });
    const q = await mail.getQuota();
    expect(q.current).toBe(4321);
  });
});

describe('OrbotoMail sendTemplate', () => {
  beforeEach(() => {
    process.env.OMS_API_KEY = 'oms_live_test';
  });

  it('routes to /v1/send/template with the full payload', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    const mail = new OrbotoMail({
      apiKey: 'oms_live_aaa',
      baseUrl: 'https://example.test',
      fetch: fakeFetch(async (url, init) => {
        capturedUrl = url;
        capturedBody = String(init.body);
        return okResponse({
          messageId: 'msg_tmpl',
          status: 'queued',
          remainingQuota: healthyQuota(),
          overage: false,
        });
      }),
    });
    const r = await mail.sendTemplate({
      templateId: 't_welcome',
      to: 'user@example.com',
      variables: { firstName: 'Alice' },
    });
    expect(r.messageId).toBe('msg_tmpl');
    expect(capturedUrl).toBe('https://example.test/v1/send/template');
    expect(JSON.parse(capturedBody)).toMatchObject({
      templateId: 't_welcome',
      to: 'user@example.com',
      variables: { firstName: 'Alice' },
    });
  });
});
