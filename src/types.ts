/**
 * Wire-protocol types for the Orboto Mail Service REST API.
 *
 * These types are the SDK's contract with the API. They're derived from
 * `evaluation/adr-orboto-mail-service.md` §SDK design + §Send-time
 * enforcement logic. The API itself (OMS-5+) is built to match this
 * contract — if a discrepancy ever surfaces, the SDK gets a bug-fix
 * and the API tracks the SDK, not the other way around (consumer-side
 * contracts win).
 *
 * Migration-from-Resend note: where the shape is similar, we deliberately
 * align so a customer porting code can rename `resend.emails.send(...)`
 * to `mail.send(...)` and not have to restructure the payload. See
 * README.md §Migration from Resend for the side-by-side.
 */

/** Standard tag-bag for analytics / per-message routing. */
export type MessageTags = Record<string, string>;

export interface SendInput {
  /**
   * From address. Must be on the customer's verified-domains
   * allowlist; otherwise the API returns 400 `from_domain_not_authorized`.
   */
  from: string;
  /** Recipient address. Single recipient per send (batch send lands in OMS-15). */
  to: string;
  subject: string;
  /** At least one of `html` or `text` must be present. */
  html?: string;
  text?: string;
  /**
   * Tag-bag stored on `oms_sends.tags` for analytics + customer
   * webhook filtering. Keys + values: ASCII, ≤256 chars each.
   */
  tags?: MessageTags;
}

/**
 * One message inside a batch (OMS-24). Same shape as SendInput but
 * with `templateId` + `variables` allowed alongside the inline-content
 * fields — server resolves per-item.
 */
export interface SendBatchMessage {
  from: string;
  to: string;
  subject?: string;
  html?: string;
  text?: string;
  tags?: MessageTags;
  templateId?: string;
  variables?: Record<string, unknown>;
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
  /** Fraction in [0, ∞) — can exceed 1 within overage allowance. */
  percentUsed: number;
  /** Threshold at which a `quota-warning` event is fired. */
  softWarnAt: number;
  /** True once the customer has crossed `softWarnAt` this period. */
  softWarnTriggered: boolean;
  /**
   * When `current >= total`, populated with the specific cap-reason:
   *   - `base_quota`         — base monthly quota exhausted, overage
   *                            not opted in
   *   - `no_payment_method`  — overage opted in but no verified
   *                            payment method on file
   *   - `overage_cap`        — both opted-in + paid, but the
   *                            per-tier overage cap has been reached
   *   - `daily_cap`          — per-day cap reached (Free tier;
   *                            resets at UTC midnight)
   * Undefined when the quota is healthy.
   */
  capReason?: 'base_quota' | 'no_payment_method' | 'overage_cap' | 'daily_cap';
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
}

export interface SendResult {
  /** SES-issued message-id. Stored on `oms_sends.message_id`. */
  messageId: string;
  /** `queued` at success-time; later moves through SES events. */
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
  | 'delivery';

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
 * by `webhooks.create()` and `webhooks.rotateSecret()` — callers must
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
  sesRegion: string | null;
  sizeBytes: number | null;
  overage: boolean;
  tags: Record<string, unknown> | null;
  templateId: string | null;
  rejectedReason: string | null;
  createdAt: string;
  deliveredAt: string | null;
  bouncedAt: string | null;
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
  /** Specific reason within the error class — drives retry decisions. */
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
