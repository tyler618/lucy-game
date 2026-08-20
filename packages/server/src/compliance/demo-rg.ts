/**
 * Reference RG provider.
 *
 * Enforces the full rule set in-process so the compliance layer is exercised
 * end to end in the demo build rather than stubbed out. Limits, exclusions and
 * cool-offs are held in memory; an operator replaces this class and changes
 * nothing else in the game.
 */
import type { MinorUnits } from '@ace/core';
import type { PlayerStatus, RgDecision, RgLimits, RgProvider, SessionCounters } from './types.js';

const DEFAULT_LIMITS: RgLimits = {
  dailyDeposit: null,
  dailyLoss: null,
  sessionMs: null,
  realityCheckMs: 30 * 60 * 1000,
};

interface Ledger {
  loss: MinorUnits;
  windowStart: number;
}

export class DemoRgProvider implements RgProvider {
  readonly name = 'demo-in-memory';
  private readonly status = new Map<string, PlayerStatus>();
  private readonly limits = new Map<string, RgLimits>();
  private readonly ledger = new Map<string, Ledger>();

  constructor(private readonly defaultJurisdiction = 'GB') {}

  async getStatus(playerId: string): Promise<PlayerStatus> {
    let s = this.status.get(playerId);
    if (!s) {
      s = {
        playerId,
        // The demo build is play-money, so the gate is satisfied at session
        // open. A real deployment reads both from the operator's KYC service
        // and neither is ever assumed true.
        ageVerified: true,
        kycVerified: true,
        jurisdiction: this.defaultJurisdiction,
        selfExcludedUntil: null,
        coolOffUntil: null,
      };
      this.status.set(playerId, s);
    }
    return s;
  }

  async setJurisdiction(playerId: string, jurisdiction: string): Promise<void> {
    const s = await this.getStatus(playerId);
    s.jurisdiction = jurisdiction;
  }

  private key(playerId: string, currency: string): string {
    return `${playerId}:${currency}`;
  }

  async getLimits(playerId: string, currency: string): Promise<RgLimits> {
    return this.limits.get(this.key(playerId, currency)) ?? { ...DEFAULT_LIMITS };
  }

  async setLimits(playerId: string, currency: string, next: Partial<RgLimits>): Promise<RgLimits> {
    const current = await this.getLimits(playerId, currency);
    // Tightening applies immediately; loosening would need the operator's
    // cooling-off workflow, which is theirs to own, not the game's.
    const merged: RgLimits = { ...current, ...next };
    this.limits.set(this.key(playerId, currency), merged);
    return merged;
  }

  private lossFor(playerId: string, currency: string): Ledger {
    const k = this.key(playerId, currency);
    const now = Date.now();
    let l = this.ledger.get(k);
    if (!l || now - l.windowStart > 24 * 60 * 60 * 1000) {
      l = { loss: 0n, windowStart: now };
      this.ledger.set(k, l);
    }
    return l;
  }

  async checkBet(
    playerId: string,
    currency: string,
    stake: MinorUnits,
    counters: SessionCounters,
  ): Promise<RgDecision> {
    const now = Date.now();
    const status = await this.getStatus(playerId);

    // Order is deliberate: hard blocks first, then soft limits. A self-excluded
    // player must never see a "loss limit" message — the exclusion is the
    // answer and the only answer.
    if (status.selfExcludedUntil !== null && status.selfExcludedUntil > now) {
      return {
        allowed: false,
        reason: 'self_excluded',
        message: 'This account is self-excluded. No bet can be accepted.',
        until: status.selfExcludedUntil,
      };
    }
    if (status.coolOffUntil !== null && status.coolOffUntil > now) {
      return {
        allowed: false,
        reason: 'cool_off',
        message: 'Cool-off in effect. Play resumes when it expires.',
        until: status.coolOffUntil,
      };
    }
    if (!status.ageVerified) {
      return { allowed: false, reason: 'age_unverified', message: 'Age verification is required before play.' };
    }
    if (!status.kycVerified) {
      return { allowed: false, reason: 'kyc_required', message: 'KYC must be completed before a real-money round.' };
    }

    const limits = await this.getLimits(playerId, currency);
    if (limits.sessionMs !== null && now - counters.startedAt >= limits.sessionMs) {
      return {
        allowed: false,
        reason: 'session_limit',
        message: 'Session time limit reached.',
        until: counters.startedAt + limits.sessionMs,
      };
    }
    if (limits.dailyLoss !== null) {
      const l = this.lossFor(playerId, currency);
      // The stake counts against the limit up front: a bet that could take the
      // player past their own ceiling is not accepted, rather than accepted and
      // regretted.
      if (l.loss + stake > limits.dailyLoss) {
        return {
          allowed: false,
          reason: 'loss_limit',
          message: 'This bet would exceed the loss limit you set.',
          until: l.windowStart + 24 * 60 * 60 * 1000,
        };
      }
    }
    return { allowed: true };
  }

  async selfExclude(playerId: string, untilMs: number): Promise<void> {
    const s = await this.getStatus(playerId);
    s.selfExcludedUntil = Math.max(s.selfExcludedUntil ?? 0, untilMs);
  }

  async coolOff(playerId: string, untilMs: number): Promise<void> {
    const s = await this.getStatus(playerId);
    s.coolOffUntil = Math.max(s.coolOffUntil ?? 0, untilMs);
  }

  async recordSettlement(playerId: string, currency: string, stake: MinorUnits, payout: MinorUnits): Promise<void> {
    const l = this.lossFor(playerId, currency);
    const delta = stake - payout;
    // Only net losses accumulate; a winning hole reduces the running loss but
    // never below zero, so a session cannot bank credit against the limit.
    l.loss = l.loss + delta < 0n ? 0n : l.loss + delta;
  }
}
