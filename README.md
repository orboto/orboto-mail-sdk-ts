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
  Verify - your account starts sending from `support@yourdomain.com`.
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

Get an API key at [account.orboto.io/mail/api-keys](https://account.orboto.io/mail/api-keys). The dashboard supports manual key issuance for any integration as well as the OAuth Connection-Protocol when you want OMS to mint a key for a specific application without copy-paste.

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

Variables get validated against the template's stored Zod schema -
missing or wrong-typed variables come back as
`400 template_variable_validation`.

### Send with CC + BCC

```ts
await mail.send({
  from: 'support@customer.de',
  to: 'primary@example.com',
  cc: ['cc1@example.com', 'cc2@example.com'],   // visible to all recipients (max 50)
  bcc: ['silent@example.com'],                   // envelope-only delivery (max 50)
  subject: 'Quarterly report',
  html: '<p>See attached.</p>',
});
```

Max 50 entries each. `cc` recipients show in the recipient's headers; `bcc` recipients receive the mail but never appear in any header (envelope-only per RFC 2822). Both flavours count as one quota decrement per call.

### Send with a Reply-To

```ts
await mail.send({
  from: 'noreply@customer.de',
  to: 'primary@example.com',
  replyTo: 'Customer Support <support@customer.de>', // replies land here, not at noreply@
  subject: 'Your order shipped',
  text: 'Reply to this mail if anything is off.',
});
```

`replyTo` is a single RFC-5322 mailbox; it does not have to be on one of your verified domains. Works on `sendBatch` messages and template sends too.

### Send with attachments

```ts
import { readFile } from 'node:fs/promises';

const pdfBytes = await readFile('/tmp/invoice.pdf');
await mail.send({
  from: 'noreply@acme.orbo.to',
  to: 'user@example.com',
  subject: 'Your invoice',
  html: '<p>Find your invoice attached.</p>',
  attachments: [
    {
      filename: 'invoice-2026-06.pdf',
      content: pdfBytes.toString('base64'),
      contentType: 'application/pdf',
    },
  ],
});
```

Up to 20 attachments per send; total decoded size capped at 30 MB. Set `contentId` to reference an attachment inline from your HTML (`<img src="cid:logo-1">`).

## DMARC reports

Once your domain's DMARC record points its `rua=` at orboto, receivers (Gmail, Outlook, Yahoo, ...) send daily aggregate reports that orboto parses for you.

```ts
const s = await mail.dmarc.summary('acme.example.com', { period: '30d' }); // '7d' | '30d' | '90d'
if (s.summary === null) {
  // nothing received yet - reports take 24-48h to start arriving
} else {
  console.log(s.summary.authPassRate, s.summary.dispositions, s.summary.topSourceIps);
}
const ips = await mail.dmarc.sourceIps('acme.example.com'); // who sends as you, and whether they align
const page = await mail.dmarc.reports('acme.example.com', { limit: 20 });
const one = await mail.dmarc.report(page.reports[0].id); // envelope + per-IP records
```

A domain you do not own answers 404 `domain_not_found`. An IP with `passedMessages: 0` and a foreign `headerFrom` is spoofing; one with your own `headerFrom` is a relay missing from SPF/DKIM.

Daily anomaly alerts are opt-in per domain (off by default):

```ts
await mail.dmarc.setAlerts('acme.example.com', { notifyEmail: 'ops@acme.example.com' });
// -> `dmarc.anomaly` webhook event + a plain-text mail when the pass rate drops >10 pp week over week,
//    a new IP sends >100 messages in a day, or rejects jump to >5x the 30-day median
await mail.dmarc.alerts('acme.example.com');        // { enabled, notifyEmail, lastAlertAt, ... }
await mail.dmarc.disableAlerts('acme.example.com');
```

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

Every non-2xx response throws an `OrbotoMailError`. The two wallet-billing
cases also have dedicated subclasses (both extend `OrbotoMailError`, so a
single `catch` still works):

```ts
import {
  OrbotoMailError,
  PaymentRequiredError,
  WalletUnavailableError,
} from '@orboto/mail';

try {
  await mail.send({ /* … */ });
} catch (err) {
  if (err instanceof PaymentRequiredError) {
    // Monthly quota used up + wallet balance too low. Show a top-up prompt.
  } else if (err instanceof WalletUnavailableError) {
    // Transient billing outage; the send was NOT dispatched. Retry later.
  } else if (err instanceof OrbotoMailError) {
    console.log(err.statusCode);     // e.g. 400
    console.log(err.reason);         // e.g. 'recipient_suppressed'
    console.log(err.remainingQuota); // QuotaState | undefined
    console.log(err.isRetryable);    // true for 502/503/504
  }
  throw err;
}
```

### Overage billing (wallet)

Once the monthly included quota is used up, above-quota sends draw on the
account **wallet** (cents-based balance, topped up at
`account.orboto.io/mail/billing`). A successful overage send returns
`overage: true`. If the wallet can't cover it you get a
`PaymentRequiredError` (402); if the billing service is briefly
unreachable you get a `WalletUnavailableError` (503) and the send is
**not** dispatched (fail-closed).

### Specific reasons you'll see

| Status | Reason                                | What to do |
|--------|---------------------------------------|------------|
| 400 | `from_domain_not_authorized` | Add the domain at `account.orboto.io/mail/domains` |
| 400 | `recipient_suppressed` | Recipient is on the suppression list - check via `mail.suppression.check()` |
| 400 | `template_variable_validation` | Variables don't match the template's schema |
| 401 | `token_revoked` | Re-issue an API key |
| 401 | `connection_revoked` | OAuth-issued connection was revoked customer-side |
| 402 | `payment_required` (`PaymentRequiredError`) | Monthly quota used up + wallet balance too low. Top up at `account.orboto.io/mail/billing` |
| 402 | `quota_exhausted_daily` | Free-tier daily cap reached; resets at UTC midnight |
| 503 | `wallet_unavailable` (`WalletUnavailableError`) | Transient billing outage; send not dispatched, retry shortly (auto-retried first) |
| 503 | `ses_transient_error` | Auto-retried; if persistent, both SES regions are down |

The SDK auto-retries 502/503/504 + network timeouts up to `maxRetries`
(default 3) with exponential backoff + jitter - including
`wallet_unavailable`, so a surfaced `WalletUnavailableError` means the
retries were already exhausted.

## Wire-format notes

- **Single `to` per `send()`.** Add up to 50 `cc` and 50 `bcc` recipients alongside it (see "Send with CC + BCC" below). For multi-`to` fan-out, use `mail.sendBatch({ messages })` - up to 100 messages per HTTP call with per-item outcomes.
- **`tags` is `Record<string, string>`.** Keys + values are ASCII, ≤256 chars each. Used for analytics + webhook filtering on `oms_sends.tags`.
- **No JSX/React input.** Use server-side templates via `mail.templates.create(...)` + `mail.sendTemplate({ templateId, variables })`, or render React to HTML before calling `mail.send()`.
- **`replyTo`** sets the Reply-To mailbox (any domain, display-name form allowed) - see "Send with a Reply-To" below. File-attachment, `cc`, and `bcc` are covered in their own sections.

If you hit a shape that's unexpected, drop us a line at [support@orboto.io](mailto:support@orboto.io).

## TypeScript

All response types are exported. Auto-complete works out of the box:

```ts
import type { SendResult, QuotaState, SuppressionEntry } from '@orboto/mail';
```

## License

[MIT](./LICENSE.md) - use it however you want.
