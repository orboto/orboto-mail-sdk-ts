/**
 * Wire-protocol types for the Orboto Mail Service REST API.
 *
 * These types are the SDK's contract with the API. If a discrepancy
 * ever surfaces, the SDK gets a bug-fix and the API tracks the SDK,
 * not the other way around (consumer-side contracts win).
 */

/** Standard tag-bag for analytics / per-message routing. */
export type MessageTags = Record<string, string>;

/**
 * OMS-91 - file attachment for outbound mail. `content` is the file
 * bytes encoded as base64 (the API caller decides the encoding; OMS
 * decodes server-side and builds the MIME message). Total decoded
 * size across all attachments must stay under 30 MB; per-attachment
 * the base64 string is capped at 40 MB on the wire.
 */
export interface SendAttachment {
  /** Display filename for the recipient's mail client. */
  filename: string;
  /** base64-encoded file bytes. */
  content: string;
  /** MIME type, e.g. `application/pdf`. */
  contentType: string;
  /**
   * Optional Content-ID for inline references from HTML
   * (`<img src="cid:<id>">`). Without it, the attachment renders as
   * a regular attachment in the recipient's client.
   */
  contentId?: string;
}

export interface SendInput {
  /**
   * From address. Must be on the customer's verified-domains
   * allowlist; otherwise the API returns 400 `from_domain_not_authorized`.
   */
  from: string;
  /** Recipient address. Single recipient per send. Use `mail.sendBatch({ messages })` for fan-out to many recipients. */
  to: string;
  /**
   * OMS-94 - additional CC recipients (visible to all other
   * recipients). Max 50.
   */
  cc?: string[];
  /**
   * OMS-94 - silent BCC recipients (hidden from To + Cc + each
   * other). Max 50. Delivered via envelope only; the MIME message
   * never carries a Bcc header.
   */
  bcc?: string[];
  /**
   * OMS-110 - optional Reply-To mailbox (RFC-5322, display-name form
   * allowed, any domain). Replies go there instead of `from`.
   */
  replyTo?: string;
  subject: string;
  /** At least one of `html` or `text` must be present. */
  html?: string;
  text?: string;
  /**
   * Tag-bag stored on `oms_sends.tags` for analytics + customer
   * webhook filtering. Keys + values: ASCII, ≤256 chars each.
   */
  tags?: MessageTags;
  /**
   * OMS-91 - optional file attachments. Max 20 entries; total decoded
   * size across all entries must stay under 30 MB. When present, OMS
   * switches to SES Raw-Content (multipart/mixed MIME) under the hood.
   */
  attachments?: SendAttachment[];
}

/**
 * One message inside a batch. Same shape as SendInput but with
 * `templateId` + `variables` allowed alongside the inline-content
 * fields - server resolves per-item.
 */
export interface SendBatchMessage {
  from: string;
  to: string;
  /** OMS-94 - additional CC recipients per message. */
  cc?: string[];
  /** OMS-94 - silent BCC recipients per message. */
  bcc?: string[];
  /** OMS-110 - optional Reply-To mailbox per message. */
  replyTo?: string;
  subject?: string;
  html?: string;
  text?: string;
  tags?: MessageTags;
  templateId?: string;
  variables?: Record<string, unknown>;
  attachments?: SendAttachment[];
}

export interface SendBatchInput {
  messages: SendBatchMessage[];
}

export interface SendBatchItemResult {
  index: number;
  ok: boolean;
  // success-only
  messageId?: string;
  status?: 'queued';
  overage?: boolean;
  // error-only
  error?: string;
  reason?: string;
  message?: string;
  /** Set when an earlier item exhausted quota and this one was not attempted. */
  quotaSkipped?: boolean;
}

export interface SendBatchResult {
  results: SendBatchItemResult[];
  /** Quota snapshot from the LAST processed item (or empty if none processed). */
  remainingQuota: QuotaState;
  summary: {
    queued: number;
    rejected: number;
    suppressed: number;
    skipped: number;
  };
}

/** API-key shape returned by /v1/api-keys list + get (no plaintext). */
export interface ApiKey {
  id: string;
  name: string | null;
  /** Display-prefix like `oms_live_a1b2c3d4`. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Returned by create + rotate - plaintext key included exactly once. */
export interface ApiKeyWithSecret extends ApiKey {
  /** Plaintext secret. Capture immediately + never reachable again. */
  key: string;
}

export interface CreateApiKeyInput {
  name?: string;
  /** Default 'live'. Use 'test' for sandbox keys (oms_test_* prefix). */
  mode?: 'live' | 'test';
}

export interface InboundMail {
  id: string;
  messageId: string;
  from: string;
  to: string;
  subject: string | null;
  sizeBytes: number | null;
  parsedStatus: string;
  receivedAt: string;
}

export interface InboundDetail extends InboundMail {
  /** 15-min presigned-URL for the raw MIME body in S3. */
  downloadUrl: string;
  downloadExpiresAt: string;
}

export interface InboundListResult {
  inbound: InboundMail[];
  nextCursor: string | null;
}

/** Sender-domain DNS detection result for the Cloudflare auto-setup flow. */
export interface CloudflareDetectResult {
  onCloudflare: boolean;
  nameservers: string[];
  resolvedFor: string;
}

export interface CloudflareAutoSetupInput {
  /** Cloudflare API token with Zone:DNS:Edit on the relevant zone. */
  apiToken: string;
  /**
   * Default false (single-use, token immediately discarded after
   * creating records). Set to true to AES-256-GCM-encrypt + store
   * the token for future DKIM-key rotations.
   */
  storeForRotation?: boolean;
}

export interface CloudflareAutoSetupResult {
  ok: true;
  zoneId: string;
  recordsCreated: number;
  tokenStored: boolean;
}

/**
 * Mutable per-domain settings. Pass only the fields you want to change;
 * omitted fields are left untouched. Empty input is a graceful no-op
 * (the server returns the unchanged row).
 */
export interface UpdateSenderDomainInput {
  /** OMS-72 / OMS-84 - per-domain open-tracking opt-in. */
  openTrackingEnabled?: boolean;
}

/** Shape returned by sender-domain CRUD calls. */
export interface SenderDomain {
  id: string;
  domain: string;
  domainType: string;
  dkimMode: string;
  dkimSelector: string | null;
  verificationStatus: string;
  verifiedAt: string | null;
  createdAt: string;
  dkimRecords: Array<{
    name: string;
    type: 'CNAME' | 'TXT';
    value: string;
    /**
     * OMS-88 - present only when type='TXT' and value.length > 255.
     * Strict DNS providers (Route 53, AWS) reject the single-string
     * value; they want each chunk in its own quoted string,
     * space-separated, inside one record. Lenient providers
     * (Cloudflare, Google Cloud DNS) auto-split internally.
     */
    valueChunks?: string[];
  }>;
  spfRequired: string | null;
  dmarcRecommended: string | null;
  mailFromRecords: Array<{
    name: string;
    type: 'MX' | 'TXT';
    value: string;
    priority?: number;
  }>;
  openTrackingEnabled: boolean;
  /**
   * Custom MAIL FROM (Return-Path) verification state per SES region,
   * as observed by the last verify run. `pending` | `success` |
   * `failed` | `temporary-failure`, `not-configured` when the identity
   * has no custom MAIL FROM, or null when no verify has run yet. A
   * verify call (re-)provisions the MAIL FROM when a region is
   * `not-configured` or `failed`, so publishing the `mailFromRecords`
   * and calling verify is the whole recovery path.
   */
  mailFromStatus: {
    primary: string | null;
    failover: string | null;
  };
  notes: string | null;
}

export interface SendTemplateInput {
  templateId: string;
  to: string;
  variables: Record<string, unknown>;
  /** Optional from-address override. If absent, server uses the
   * template's default-from (configured at template-create time). */
  from?: string;
  tags?: MessageTags;
}

/** Quota envelope returned on every send + queryable via `getQuota()`. */
export interface QuotaState {
  /** Current consumed count within the active period (base + overage). */
  current: number;
  /** Effective monthly ceiling (base + overage cap). */
  total: number;
  /** ISO-8601 timestamp when the quota resets. */
  resetAt: string;
  /** Fraction in [0, ∞) - can exceed 1 within overage allowance. */
  percentUsed: number;
  /** Threshold at which a `quota-warning` event is fired. */
  softWarnAt: number;
  /** True once the customer has crossed `softWarnAt` this period. */
  softWarnTriggered: boolean;
  /**
   * When `current >= total`, populated with the specific cap-reason:
   *   - `base_quota`         - base monthly quota exhausted, overage
   *                            not opted in
   *   - `no_payment_method`  - overage opted in but no verified
   *                            payment method on file
   *   - `overage_cap`        - both opted-in + paid, but the
   *                            per-tier overage cap has been reached
   *   - `daily_cap`          - per-day cap reached (Free tier;
   *                            resets at UTC midnight)
   * Undefined when the quota is healthy.
   */
  capReason?:
    | 'base_quota'
    | 'no_payment_method'
    | 'overage_cap'
    | 'daily_cap'
    | 'no_credits'
    | 'monthly_cap_reached'
    | 'hard_gate';
  /**
   * Daily-cap hard limit. `null` for paid tiers (no per-day cap),
   * a number for Free tier. When non-null and `dailyRemaining=0` the
   * next send returns 402 `quota_exhausted_daily`.
   */
  dailyCap: number | null;
  /** Sends consumed today (UTC). `null` when no daily cap is set. */
  dailyCurrent: number | null;
  /** `dailyCap - dailyCurrent`, never negative. `null` when no cap. */
  dailyRemaining: number | null;
  /** ISO-8601 timestamp of the next UTC midnight. `null` when no cap. */
  dayResetAt: string | null;
  /**
   * Overage handling when subscription quota is exhausted:
   * - `hard_gate`: reject sends over subscription quota → 402 `quota_exhausted_hard_gate`
   * - `use_credits`: consume `creditBalance` + accrue against `monthlyOverageCapEurCents`
   * - `null`: legacy `allowOverage` path (will be retired once every customer is migrated)
   */
  overageMode: 'hard_gate' | 'use_credits' | null;
  /** Topup credits remaining (sends). */
  creditBalance: number;
  /** Monthly overage spend cap in EUR cents. `null` = unlimited (Enterprise). */
  monthlyOverageCapEurCents: number | null;
  /** Running overage spend for the current month in microcents (1¢ = 10 000). */
  overageUsedThisMonthMicrocents: number;
}

export interface SendResult {
  /** Server-issued message id. */
  messageId: string;
  /** `queued` at success-time; later moves through delivery-event transitions. */
  status: 'queued' | 'delivered' | 'bounced' | 'complained' | 'rejected';
  /** Quota snapshot AFTER this send was accounted for. */
  remainingQuota: QuotaState;
  /** True when this send consumed an over-base-quota slot. */
  overage: boolean;
}

export interface SuppressionEntry {
  email: string;
  reason: 'hard-bounce' | 'complaint' | 'manual';
  addedAt: string;
  addedBy: string;
}

export interface SuppressionCheckResult {
  email: string;
  suppressed: boolean;
  entry?: SuppressionEntry;
}

export interface Template {
  id: string;
  name: string;
  subject: string;
  /** Zod-compatible JSON schema describing the `variables` shape. */
  variablesSchema?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type WebhookEvent =
  | 'quota.soft-warn-80'
  | 'quota.soft-warn-95'
  | 'quota.exhausted-base'
  | 'quota.exhausted-cap'
  | 'bounce.permanent'
  | 'bounce.transient'
  | 'complaint'
  | 'delivery'
  | 'email.opened'
  | 'inbound.received'
  | 'senderDomain.dkim.migrated'
  | 'senderDomain.dkim.rotation_pending'
  | 'senderDomain.dkim.rotation_complete'
  /** OMS-50 - daily DMARC anomaly check fired for an opted-in domain. */
  | 'dmarc.anomaly';

export interface Webhook {
  id: string;
  url: string;
  label: string | null;
  eventFilters: WebhookEvent[];
  enabled: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  createdAt: string;
}

/**
 * A `Webhook` augmented with the plaintext signing secret. Only returned
 * by `webhooks.create()` and `webhooks.rotateSecret()` - callers must
 * persist this value immediately; subsequent GETs strip it.
 */
export interface WebhookWithSecret extends Webhook {
  secret: string;
}

export interface SendListItem {
  id: string;
  fromAddress: string;
  toAddress: string;
  subject: string | null;
  messageId: string | null;
  status: 'queued' | 'delivered' | 'bounced' | 'complained' | 'rejected';
  bounceType: string | null;
  complaintType: string | null;
  region: string | null;
  sizeBytes: number | null;
  overage: boolean;
  tags: Record<string, unknown> | null;
  templateId: string | null;
  rejectedReason: string | null;
  createdAt: string;
  deliveredAt: string | null;
  bouncedAt: string | null;
  /**
   * OMS-72 - open-tracking. Populated when the customer enabled
   * `open_tracking_enabled` on the sender-domain AND a recipient
   * email client loaded the injected 1x1 pixel. Null when tracking
   * is off or the recipient never opened.
   */
  openedAt: string | null;
  lastOpenedAt: string | null;
  openCount: number;
}

export interface SendListResult {
  sends: SendListItem[];
  nextCursor: string | null;
}

export interface SuppressionListResult {
  suppressions: SuppressionEntry[];
  nextCursor: string | null;
}

/**
 * Standard error envelope from the OMS API. Every non-2xx response
 * carries this shape; the SDK throws an `OrbotoMailError` wrapping it
 * (see errors.ts).
 */
export interface ApiErrorBody {
  error: string;
  /** Specific reason within the error class - drives retry decisions. */
  reason?: string;
  message: string;
  /** Present on 402 responses so callers can render an actionable banner. */
  remainingQuota?: QuotaState;
  /** Present on 503 responses indicating the retry-after window. */
  retryAfterMs?: number;
}

/** Connection-revoked event payload. */
export interface ConnectionRevokedEvent {
  reason: 'connection_revoked';
  message: string;
}

/**
 * Map of EventEmitter event names → payloads. The SDK's `on()` method
 * is typed against this map so consumers get autocomplete + payload
 * type-checking.
 */
export interface SdkEventMap {
  'quota-warning': [quota: QuotaState];
  'quota-low': [quota: QuotaState];
  'quota-exhausted': [quota: QuotaState];
  'connection-revoked': [event: ConnectionRevokedEvent];
}

export type SdkEventName = keyof SdkEventMap;

// ── DMARC aggregate-report queries (OMS-48) ──────────────────────────

/** Reporting window for DMARC aggregations. Capped at 90 days (retention). */
export type DmarcPeriod = '7d' | '30d' | '90d';

export interface DmarcDispositions {
  none: number;
  quarantine: number;
  reject: number;
}

export interface DmarcSummary {
  domain: string;
  period: DmarcPeriod;
  /** Number of aggregate reports in the period. 0 = nothing received yet. */
  totalReports: number;
  /** Null while no report exists for the period (empty state, not an error). */
  summary: {
    totalMessages: number;
    /** Messages that passed DMARC (DKIM aligned OR SPF aligned). */
    passedMessages: number;
    /** passed / total, 0..1 rounded to 4 decimals; null when total is 0. */
    authPassRate: number | null;
    dispositions: DmarcDispositions;
    topReportingOrgs: Array<{ orgName: string; messages: number; reports: number }>;
    topSourceIps: Array<{
      sourceIp: string;
      messages: number;
      passedMessages: number;
      dkimAlignedMessages: number;
      spfAlignedMessages: number;
    }>;
  } | null;
}

export interface DmarcReportEnvelope {
  id: string;
  domain: string;
  orgName: string;
  reporterEmail: string;
  reportId: string;
  dateRangeBegin: string;
  dateRangeEnd: string;
  /** The `policy_published` block of the report as parsed JSON. */
  policyPublished: unknown;
  receivedAt: string;
  recordCount: number;
}

export interface DmarcReportRecord {
  id: string;
  sourceIp: string;
  count: number;
  disposition: string;
  dkimAligned: boolean;
  spfAligned: boolean;
  dkimResult: string | null;
  spfResult: string | null;
  headerFrom: string | null;
}

export interface DmarcReportDetail extends DmarcReportEnvelope {
  records: DmarcReportRecord[];
}

export interface DmarcReportsPage {
  reports: DmarcReportEnvelope[];
  nextCursor: string | null;
}

export interface DmarcSourceIp {
  sourceIp: string;
  messages: number;
  reports: number;
  passedMessages: number;
  dkimAlignedMessages: number;
  spfAlignedMessages: number;
  dispositions: DmarcDispositions;
  /** header-from domains seen from this IP - a mismatch with your domain is the spoofing signal. */
  headerFroms: Array<{ headerFrom: string | null; messages: number }>;
}

export interface DmarcSourceIpsPage {
  domain: string;
  period: DmarcPeriod;
  sourceIps: DmarcSourceIp[];
  nextCursor: string | null;
}

/** OMS-50 - per-domain DMARC anomaly alert opt-in. Off until you POST it on. */
export interface DmarcAlertSubscription {
  domain: string;
  enabled: boolean;
  /** Mailbox for alert mails; null = the `dmarc.anomaly` webhook event only. */
  notifyEmail: string | null;
  lastAlertAt: string | null;
  updatedAt: string | null;
}
