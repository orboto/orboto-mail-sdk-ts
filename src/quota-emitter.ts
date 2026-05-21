/**
 * Quota event dispatcher. Tracks the per-event "have we already fired
 * this threshold?" state so a customer who lingers at 81% doesn't get
 * a `quota-warning` for every send.
 *
 * Thresholds + emit-once-per-reset semantics per ADR §SDK design:
 *   - 80% base   → 'quota-warning'  (fires once until quota.resetAt rolls)
 *   - 95% base   → 'quota-low'      (same)
 *   - 100% base  → 'quota-exhausted' (same)
 */
import type { QuotaState } from './types.js';

type Threshold = 'warning' | 'low' | 'exhausted';

const THRESHOLDS: Array<{ name: Threshold; pct: number; event: string }> = [
  { name: 'warning', pct: 0.8, event: 'quota-warning' },
  { name: 'low', pct: 0.95, event: 'quota-low' },
  { name: 'exhausted', pct: 1.0, event: 'quota-exhausted' },
];

export class QuotaEmitter {
  private firedSinceReset = new Map<string, Set<Threshold>>();
  private lastResetAt: string | undefined;

  /**
   * Inspect a quota snapshot and return the list of threshold events
   * to emit. Caller wires them to the consumer's `mail.on(...)`
   * subscribers.
   */
  inspect(q: QuotaState): string[] {
    // Reset the fired-set when resetAt changes (new month rolled over).
    if (this.lastResetAt !== undefined && this.lastResetAt !== q.resetAt) {
      this.firedSinceReset.clear();
    }
    this.lastResetAt = q.resetAt;

    const bucket = this.firedSinceReset.get(q.resetAt) ?? new Set<Threshold>();
    const toEmit: string[] = [];
    for (const t of THRESHOLDS) {
      if (q.percentUsed >= t.pct && !bucket.has(t.name)) {
        bucket.add(t.name);
        toEmit.push(t.event);
      }
    }
    this.firedSinceReset.set(q.resetAt, bucket);
    return toEmit;
  }
}
