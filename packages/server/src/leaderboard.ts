/**
 * Leaderboards and races.
 *
 * Two scopes, both configurable per race: total wagered, and highest single
 * carry. Wagered is the one operators run for volume; highest carry is the one
 * players screenshot. Prize pools are expressed in minor units and split by a
 * configurable schedule.
 *
 * Standings are held in memory here because a race is a bounded window and the
 * durable record of every contributing bet is already in the audit log. An
 * operator with a warehouse points this at it instead.
 */
import { format, type MinorUnits } from '@ace/core';
import type { LeaderboardEntry, LeaderboardScope } from '@ace/core';
import { handleFor } from './engine/feed.js';

export interface RaceConfig {
  id: string;
  name: string;
  scope: LeaderboardScope;
  currency: string;
  /** Total pool in minor units. */
  prizePool: MinorUnits;
  /** Fractions of the pool by rank, highest first. Must sum to <= 1. */
  payoutSchedule: number[];
  startsAt: number;
  endsAt: number;
  /** Bets below this do not count, so a race cannot be farmed with dust. */
  minStake: MinorUnits;
}

interface Standing {
  playerId: string;
  wagered: MinorUnits;
  highestCarry: number;
  holes: number;
}

export class Leaderboard {
  private readonly standings = new Map<string, Standing>();

  constructor(public readonly config: RaceConfig) {}

  get active(): boolean {
    const now = Date.now();
    return now >= this.config.startsAt && now < this.config.endsAt;
  }

  record(playerId: string, stake: MinorUnits, currency: string, carry: number, won: boolean): void {
    if (!this.active) return;
    if (currency !== this.config.currency) return;
    if (stake < this.config.minStake) return;

    let s = this.standings.get(playerId);
    if (!s) {
      s = { playerId, wagered: 0n, highestCarry: 0, holes: 0 };
      this.standings.set(playerId, s);
    }
    s.wagered += stake;
    s.holes += 1;
    // Only a banked carry counts for the highest-carry race. A hole that went
    // in the drink at 900x was not a 900x win and must not top a leaderboard.
    if (won && carry > s.highestCarry) s.highestCarry = carry;
  }

  private prizeFor(rank: number): MinorUnits | null {
    const fraction = this.config.payoutSchedule[rank];
    if (fraction === undefined) return null;
    // Basis points keep the split exact in integer arithmetic.
    return (this.config.prizePool * BigInt(Math.round(fraction * 10_000))) / 10_000n;
  }

  table(limit = 25): LeaderboardEntry[] {
    const sorted = [...this.standings.values()].sort((a, b) => {
      if (this.config.scope === 'wagered') {
        return a.wagered === b.wagered ? b.holes - a.holes : a.wagered < b.wagered ? 1 : -1;
      }
      return b.highestCarry - a.highestCarry;
    });

    return sorted.slice(0, limit).map((s, i) => {
      const prize = this.prizeFor(i);
      return {
        rank: i + 1,
        handle: handleFor(s.playerId),
        value:
          this.config.scope === 'wagered'
            ? format(s.wagered, this.config.currency, { withCode: true })
            : `${s.highestCarry.toFixed(2)}x`,
        currency: this.config.currency,
        prize: prize === null ? null : format(prize, this.config.currency, { withCode: true }),
      };
    });
  }
}
