# @orboto/mail

Official TypeScript SDK for the [Orboto Mail Service](https://mail.orboto.io).
EU-hosted transactional email with built-in quota-tracking, automatic
retry-with-backoff, and an EventEmitter for quota-warning lifecycle
events.

```bash
npm install @orboto/mail
# or
pnpm add @orboto/mail
```

```ts
import { OrbotoMail } from '@orboto/mail';

const mail = new OrbotoMail(); // reads OMS_API_KEY from process.env

const result = await mail.send({
  from: 'noreply@acme.orbo.to',
  to: 'user@example.com',
  subject: 'Welcome',
  html: '<h1>Welcome!</h1>',
});

console.log(result.messageId);       // 'msg_abc123'
console.log(result.status);          // 'queued'
console.log(result.remainingQuota);  // QuotaState { current, total, ... }
```

## Why @orboto/mail?

- **EU-hosted by default.** Sends through EU AWS infrastructure with
  region-failover. No US data transit. GDPR/DSGVO-aligned out of the box.
- **Custom-domain self-service.** Add your sending domain, copy the
  generated DKIM CNAMEs + SPF/DMARC records to your DNS provider, click
  Verify — your account starts sending from `support@yourdomain.com`.
- **Quota-aware by design.** Every send returns the updated quota state.
  No second API call to figure out where you stand.
- **Agent-first.** A companion MCP server [`@orboto/mail-mcp`](https://www.npmjs.com/package/@orboto/mail-mcp) exposes the
  same surface as MCP tools so Claude, Cursor, and other agents can drive
  email flows natively.

## Auth

The SDK reads `OMS_API_KEY` from `process.env` at construction time. You
can also pass it explicitly:

```ts
const mail = new OrbotoMail({
  apiKey: process.env.OMS_API_KEY,
  baseUrl: 'https://mail.orboto.io/api', // default
  timeout: 10_000,
  maxRetries: 3,
});
```

Get an API key at [account.orboto.io/mail/keys](https://account.orboto.io/mail/keys). The dashboard supports manual key issuance for any integration as well as the OAuth Connection-Protocol when you want OMS to mint a key for a specific application without copy-paste.

## Sending mail

### Raw send

```ts
const result = await mail.send({
  from: 'support@customer.de',
  to: 'user@example.com',
  subject: 'Welcome',
  html: '<h1>Welcome!</h1>',
  text: 'Welcome!',                          // fallback for plain-text clients
  tags: { workflow: 'invite', segment: 'beta' }, // arbitrary string tags for analytics
});
```

### Template send

Templates live server-side at `account.orboto.io/mail/templates`. The
SDK renders by reference, so you can edit copy without redeploying.

```ts
const result = await mail.sendTemplate({
  templateId: 't_welcome',
  to: 'user@example.com',
  variables: {
    firstName: 'Alice',
    activationUrl: 'https://workspace.acme.example.com/activate?token=…',
  },
});
```

Variables get validated against the template's stored Zod schema —
missing or wrong-typed variables come back as
`400 template_variable_validation`.

## Quota events

```ts
mail.on('quota-warning',  (q) => console.warn('80%',  q));
mail.on('quota-low',      (q) => console.warn('95%',  q));
mail.on('quota-exhausted',(q) => console.error('100%', q));
mail.on('connection-revoked', (e) => console.error(e.message));
```

Events fire at-most-once per reset window. The SDK tracks the threshold
state internally so you can wire UI banners without writing your own
debouncer.

## Suppression list

```ts
const r = await mail.suppression.check('user@example.com');
// → { email, suppressed: true|false, entry?: { reason, addedAt, addedBy } }

await mail.suppression.add('opt-out@example.com', 'manual');
await mail.suppression.remove('false-positive@example.com');
```

## Error handling

Every non-2xx response throws an `OrbotoMailError`:

```ts
import { OrbotoMailError } from '@orboto/mail';

try {
  await mail.send({ /* … */ });
} catch (err) {
  if (err instanceof OrbotoMailError) {
    console.log(err.statusCode);     // 402
    console.log(err.reason);         // 'overage_cap_exceeded'
    console.log(err.remainingQuota); // QuotaState | undefined
    console.log(err.isRetryable);    // true for 502/503/504
  }
  throw err;
}
```

### Specific reasons you'll see

| Status | Reason                                | What to do |
|--------|---------------------------------------|------------|
| 400 | `from_domain_not_authorized` | Add the domain at `account.orboto.io/mail/domains` |
| 400 | `recipient_suppressed` | Recipient is on the suppression list — check via `mail.suppression.check()` |
| 400 | `template_variable_validation` | Variables don't match the template's schema |
| 401 | `token_revoked` | Re-issue an API key |
| 401 | `connection_revoked` | OAuth-issued connection was revoked customer-side |
| 402 | `quota_exhausted_no_overage_opted_in` | Enable overage at `account.orboto.io/mail/usage` |
| 402 | `quota_exhausted_no_valid_payment_method` | Add a payment method |
| 402 | `overage_cap_exceeded` | Upgrade tier or wait for monthly reset |
| 503 | `ses_transient_error` | Auto-retried; if persistent, both SES regions are down |

The SDK auto-retries 502/503/504 + network timeouts up to `maxRetries`
(default 3) with exponential backoff + jitter.

## Wire-format notes

- **Single recipient per `send()`.** Use `mail.sendBatch({ messages })` for fan-out — up to 100 messages per HTTP call with per-item outcomes.
- **`tags` is `Record<string, string>`.** Keys + values are ASCII, ≤256 chars each. Used for analytics + webhook filtering on `oms_sends.tags`.
- **No JSX/React input.** Use server-side templates via `mail.templates.create(...)` + `mail.sendTemplate({ templateId, variables })`, or render React to HTML before calling `mail.send()`.
- **`replyTo` / `cc` / `bcc` are not supported yet.** Single-recipient transactional flows only.

If you hit a shape that's unexpected, drop us a line at [support@orboto.io](mailto:support@orboto.io).

## TypeScript

All response types are exported. Auto-complete works out of the box:

```ts
import type { SendResult, QuotaState, SuppressionEntry } from '@orboto/mail';
```

## License

[MIT](./LICENSE.md) — use it however you want.
