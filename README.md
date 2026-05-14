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

- **EU-hosted by default.** Sends through AWS SES in `eu-central-1`
  (Frankfurt) with `eu-west-1` (Ireland) automatic failover. No US data
  transit. DSGVO-aligned out of the box.
- **Per-tenant DKIM domains.** Every Orboto-Workspace gets a
  pre-provisioned `<tenant>.orbo.to` subdomain with DKIM auto-rotated by
  SES. Custom domains follow a Resend-style copy-paste setup.
- **Quota-aware by design.** Every send returns the updated quota state.
  No second API call to figure out where you stand.
- **Drop-in compat with Resend.** See [Migration from Resend](#migration-from-resend) below.

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

Keys are obtained one of two ways:

1. **Customer-Portal** at `account.orboto.io/mail/keys` — manual issue
   for self-host or custom integrations.
2. **OAuth flow** — the Orboto-Workspace connects to OMS via the
   Connection-Protocol; OMS issues the key + injects it into your
   workspace's environment as `OMS_API_KEY`. No copy-paste.

If you're an Orboto-SaaS tenant, your Coolify stack already has
`OMS_API_KEY` + `OMS_BASE_URL` set — `new OrbotoMail()` Just Works with
no further configuration.

## Sending mail

### Raw send

```ts
const result = await mail.send({
  from: 'support@customer.de',
  to: 'user@example.com',
  subject: 'Welcome',
  html: '<h1>Welcome!</h1>',
  text: 'Welcome!',                          // fallback for plain-text clients
  tags: { workflow: 'invite', tenant: 'acme' }, // arbitrary string tags for analytics
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

## Migration from Resend

Wire-protocol compatibility is deliberate where the semantics match. A
typical Resend integration changes:

```diff
- import { Resend } from 'resend';
+ import { OrbotoMail } from '@orboto/mail';

- const resend = new Resend(process.env.RESEND_API_KEY);
+ const mail = new OrbotoMail(); // reads OMS_API_KEY from env

- await resend.emails.send({
+ await mail.send({
    from: 'noreply@acme.example.com',
    to: 'user@example.com',
    subject: 'Welcome',
    html: '<h1>Welcome!</h1>',
  });
```

Differences vs Resend:

- **Single recipient per send.** Batch send lands in OMS-15. For now,
  loop client-side. (We auto-merge duplicate recipients to the same
  message-id at the wire layer, so you don't have to dedupe yourself.)
- **`tags` is `Record<string, string>`, not an array of `{name, value}`
  objects.** Easier to construct, same expressiveness.
- **`react` not supported (yet).** Use server-side templates or render
  React to HTML before calling `mail.send()`. JSX-as-an-input is on the
  roadmap.
- **`replyTo` and `cc` / `bcc` land in OMS-15.** For OMS-1.x, only
  `to` is supported.

If you hit something that doesn't have an obvious analog,
[open an issue](https://github.com/orboto/orboto-mail-service/issues).

## TypeScript

All response types are exported. Auto-complete works out of the box:

```ts
import type { SendResult, QuotaState, SuppressionEntry } from '@orboto/mail';
```

## License

[Orboto Sustainable Use License](../../LICENSE.md) — free for internal
business use + non-commercial use; redistribution restricted.
