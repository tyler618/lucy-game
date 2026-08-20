/**
 * Responsible gambling, geo-fencing and player status — as interfaces.
 *
 * This is the portability layer. An operator already runs an RG system: limits
 * live in their account platform, exclusions come from a national register,
 * geo comes from their edge. ACE must defer to all of it rather than keep its
 * own shadow copy, so every check the game makes goes through these three
 * interfaces and nothing else. Implementing them is the whole integration.
 *
 * The rule that matters, and the one that gets audited: an exclusion is
 * enforced by REFUSING THE BET, not by hiding a button. A client can be
 * modified; the server cannot. Every check below runs server-side on the bet
 * path, every time, with no client-supplied input trusted.
 */
import type { MinorUnits } from '@ace/core';
import type { BetRejection } from '@ace/core';

export interface PlayerStatus {
  playerId: string;
  ageVerified: boolean;
  kycVerified: boolean;
  /** ISO 3166-1 alpha-2, resolved server-side. Never sent by the client. */
  jurisdiction: string;
  selfExcludedUntil: number | null;
  coolOffUntil: number | null;
}

export interface RgLimits {
  /** Rolling 24h deposit ceiling. ACE does not take deposits; it reports against it. */
  dailyDeposit: MinorUnits | null;
  /** Rolling 24h net loss ceiling. Enforced on the bet path. */
  dailyLoss: MinorUnits | null;
  /** Session wall-clock ceiling, ms. */
  sessionMs: number | null;
  /** Reality check interval, ms. Null disables. */
  realityCheckMs: number | null;
}

export interface SessionCounters {
  startedAt: number;
  wagered: MinorUnits;
  /** Signed. Negative means the player is down. */
  net: MinorUnits;
  holesPlayed: number;
  lastRealityCheckAt: number;
}

export type RgDecision = { allowed: true } | { allowed: false; reason: BetRejection; message: string; until?: number };

export interface RgProvider {
  readonly name: string;
  getStatus(playerId: string): Promise<PlayerStatus>;
  getLimits(playerId: string, currency: string): Promise<RgLimits>;
  setLimits(playerId: string, currency: string, limits: Partial<RgLimits>): Promise<RgLimits>;
  /** Called before every single bet. Must be cheap and must never fail open. */
  checkBet(playerId: string, currency: string, stake: MinorUnits, counters: SessionCounters): Promise<RgDecision>;
  /** Player-initiated. Takes effect immediately and cannot be reversed by the game. */
  selfExclude(playerId: string, untilMs: number): Promise<void>;
  coolOff(playerId: string, untilMs: number): Promise<void>;
  /** Settlement notification so the operator's own counters stay authoritative. */
  recordSettlement(playerId: string, currency: string, stake: MinorUnits, payout: MinorUnits): Promise<void>;
}

export interface GeoProvider {
  readonly name: string;
  /**
   * Resolve jurisdiction from connection metadata. Server-side only — a
   * client-declared country is not evidence of anything.
   */
  resolve(ip: string, headers: Record<string, string | undefined>): Promise<string>;
  /** Config-driven blocklist. Not compiled into the client. */
  isBlocked(jurisdiction: string): Promise<boolean>;
}
