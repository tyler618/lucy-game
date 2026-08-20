/**
 * The ACE table — one per player, server-authoritative end to end.
 *
 * ACE is a per-player title, not a shared-countdown one. Each hole is derived
 * from that player's own seed triplet, which means:
 *   - the Stake-standard triplet in the brief is literally what governs play,
 *     rather than a table-level salt bolted onto a shared chain;
 *   - there is no lobby wait, so cadence is set by the flight rather than by
 *     the slowest player, which is what keeps a hole inside 6–12s;
 *   - it scales horizontally with no shared round clock to synchronise.
 * The live feed carries other players' holes for social proof, exactly as
 * Stake's own originals do.
 *
 * The outcome is derived at TEE OFF and never leaves this process until the
 * hole is settled. The client is handed a start time and nothing else.
 */
import {
  MAX_CARRY,
  SETTLE_BEAT_MS,
  deriveHole,
  displayCarryAt,
  flightDurationMs,
  payoutFor,
  timeToReach,
  yardsFor,
  type HoleResult,
  type MinorUnits,
} from '@ace/core';
import type { AuditLog } from '../audit/audit-log.js';
import type { WalletProvider } from '../wallet/types.js';
import type { RgProvider, GeoProvider, SessionCounters } from '../compliance/types.js';
import type { SeedManager } from './seed-manager.js';
import type { BetRejection } from '@ace/core';

/**
 * Uplink latency compensation.
 *
 * A player who taps Mark it at 2.00x has their intent arrive some tens of
 * milliseconds later, and settling on raw arrival time silently charges them
 * for the network. We subtract a fixed grace before evaluating the carry. It is
 * fixed rather than client-reported because a client-supplied latency figure is
 * a free multiplier for anyone willing to lie about it.
 *
 * This never lets a player win a hole they lost: the carry after subtraction is
 * still compared against the crash point, so a mark that lands genuinely past
 * the water is still in the drink.
 */
const MARK_LATENCY_GRACE_MS = 200;

export interface PlacedBet {
  betId: string;
  playerId: string;
  currency: string;
  stake: MinorUnits;
  layUpAt: number | null;
  nonce: number;
  serverSeedHash: string;
  clientSeed: string;
  /** Server-only until settlement. Never serialised to a client before then. */
  crashCarry: number;
  teedOffAt: number;
  flightMs: number;
  settled: boolean;
  timer: NodeJS.Timeout | null;
}

export interface Settlement {
  betId: string;
  playerId: string;
  currency: string;
  stake: MinorUnits;
  won: boolean;
  /** Carry the player actually banked, or the crash point on a bust. */
  carry: number;
  payout: MinorUnits;
  balance: MinorUnits;
  result: HoleResult;
  /** How the hole ended, for the audit trail and the UI copy. */
  via: 'mark' | 'lay_up' | 'cap' | 'drink';
}

export type PlaceResult =
  | { ok: true; bet: PlacedBet; balance: MinorUnits }
  | { ok: false; reason: BetRejection; message: string; until?: number };

export interface TableDeps {
  wallet: WalletProvider;
  rg: RgProvider;
  geo: GeoProvider;
  seeds: SeedManager;
  audit: AuditLog;
  onSettled: (s: Settlement) => void;
}

let betCounter = 0;

export class Table {
  private readonly bets = new Map<string, PlacedBet>();
  private readonly counters = new Map<string, SessionCounters>();
  private readonly history = new Map<string, HoleResult[]>();

  constructor(private readonly deps: TableDeps) {}

  countersFor(playerId: string): SessionCounters {
    let c = this.counters.get(playerId);
    if (!c) {
      c = { startedAt: Date.now(), wagered: 0n, net: 0n, holesPlayed: 0, lastRealityCheckAt: Date.now() };
      this.counters.set(playerId, c);
    }
    return c;
  }

  historyFor(playerId: string, limit = 30): HoleResult[] {
    return (this.history.get(playerId) ?? []).slice(0, limit);
  }

  activeBetFor(playerId: string): PlacedBet | null {
    for (const bet of this.bets.values()) {
      if (bet.playerId === playerId && !bet.settled) return bet;
    }
    return null;
  }

  /**
   * Tee it up.
   *
   * Order is load-bearing and is the order an auditor will check:
   *   geo -> RG -> table limits -> wallet debit -> derive -> schedule.
   * The outcome is derived only after the money has actually moved, so a
   * rejected or failed debit can never consume a nonce and can never create a
   * hole that exists in the seed chain but not in the ledger.
   */
  async place(
    playerId: string,
    currency: string,
    stake: MinorUnits,
    layUpAt: number | null,
    jurisdiction: string,
  ): Promise<PlaceResult> {
    if (this.activeBetFor(playerId)) {
      return { ok: false, reason: 'already_bet', message: 'You already have a ball in the air.' };
    }

    if (await this.deps.geo.isBlocked(jurisdiction)) {
      await this.deps.audit.record('geo.block', playerId, { jurisdiction });
      return { ok: false, reason: 'jurisdiction_blocked', message: 'ACE is not available in your jurisdiction.' };
    }

    const counters = this.countersFor(playerId);
    const decision = await this.deps.rg.checkBet(playerId, currency, stake, counters);
    if (!decision.allowed) {
      await this.deps.audit.record('rg.block', playerId, { reason: decision.reason, stake: stake.toString(), currency });
      return { ok: false, reason: decision.reason, message: decision.message, until: decision.until };
    }

    const limits = await this.deps.wallet.limits(currency);
    if (stake < limits.min) {
      return { ok: false, reason: 'stake_below_min', message: `Minimum stake is ${limits.min} minor units.` };
    }
    if (stake > limits.max) {
      return { ok: false, reason: 'stake_above_max', message: `Maximum stake is ${limits.max} minor units.` };
    }

    const betId = `b_${Date.now().toString(36)}_${(++betCounter).toString(36)}`;
    const debit = await this.deps.wallet.debit({
      playerId,
      currency,
      amount: stake,
      idempotencyKey: `stake:${betId}`,
      roundId: betId,
    });
    if (!debit.ok) {
      await this.deps.audit.record('wallet.error', playerId, { op: 'debit', betId, reason: debit.reason });
      const reason: BetRejection = debit.reason === 'insufficient_funds' ? 'insufficient_funds' : 'wallet_error';
      return { ok: false, reason, message: debit.message };
    }
    await this.deps.audit.record('wallet.debit', playerId, {
      betId,
      currency,
      amount: stake.toString(),
      balance: debit.balance.toString(),
    });

    const seed = this.deps.seeds.get(playerId);
    const nonce = this.deps.seeds.nextNonce(playerId);
    const hole = deriveHole({ serverSeed: seed.serverSeed, clientSeed: seed.clientSeed, nonce });

    const teedOffAt = Date.now();
    const bet: PlacedBet = {
      betId,
      playerId,
      currency,
      stake,
      layUpAt: normaliseLayUp(layUpAt),
      nonce,
      serverSeedHash: seed.serverSeedHash,
      clientSeed: seed.clientSeed,
      crashCarry: hole.carry,
      teedOffAt,
      flightMs: flightDurationMs(hole.carry),
      settled: false,
      timer: null,
    };
    this.bets.set(betId, bet);

    counters.wagered += stake;
    counters.holesPlayed += 1;

    await this.deps.audit.record('bet.placed', playerId, {
      betId,
      currency,
      stake: stake.toString(),
      layUpAt: bet.layUpAt,
      nonce,
      serverSeedHash: seed.serverSeedHash,
      clientSeed: seed.clientSeed,
      // The crash point is written to the audit log at tee off, before the
      // player can act on it. That is the record which proves the outcome was
      // committed up front rather than chosen at settlement.
      crashCarry: hole.carry,
      hmac: hole.hash,
    });

    this.scheduleAutoSettle(bet);
    return { ok: true, bet, balance: debit.balance };
  }

  /**
   * Auto-settlement.
   *
   * Two cases, and the player is protected in both even if their connection
   * dies the instant after tee off:
   *   - a lay-up that the hole reaches is banked by the server on time;
   *   - a hole that reaches the cap is banked at the cap, because the max win
   *     is a payable outcome, not a ceiling the player has to hand-time.
   * Otherwise the ball finds the water at the crash point.
   */
  private scheduleAutoSettle(bet: PlacedBet): void {
    const layUpReached = bet.layUpAt !== null && bet.layUpAt <= bet.crashCarry;
    const capped = bet.crashCarry >= MAX_CARRY;

    const at = layUpReached ? timeToReach(bet.layUpAt as number) : bet.flightMs;
    const via: Settlement['via'] = layUpReached ? 'lay_up' : capped ? 'cap' : 'drink';
    const carry = layUpReached ? (bet.layUpAt as number) : capped ? MAX_CARRY : bet.crashCarry;
    const won = layUpReached || capped;

    bet.timer = setTimeout(() => {
      void this.settle(bet, carry, won, via);
    }, Math.max(0, at));
  }

  /**
   * Mark it. The player's intent; the server's arithmetic.
   *
   * Elapsed time comes from the server's own clock against its own recorded
   * tee-off, never from anything the client sends. The client's carry is not
   * consulted at all — it cannot be, or the game would be client-decided.
   */
  async mark(playerId: string, betId: string): Promise<Settlement | { error: string }> {
    const bet = this.bets.get(betId);
    if (!bet || bet.playerId !== playerId) return { error: 'No such bet.' };
    if (bet.settled) return { error: 'That hole is already settled.' };

    const elapsed = Date.now() - bet.teedOffAt - MARK_LATENCY_GRACE_MS;
    const carry = Math.max(1, displayCarryAt(elapsed));

    if (carry > bet.crashCarry) {
      // The mark arrived after the water, grace included. It is a bust, and the
      // scheduled timer would have said the same thing a moment later.
      return this.settle(bet, bet.crashCarry, false, 'drink');
    }
    return this.settle(bet, Math.min(carry, MAX_CARRY), true, 'mark');
  }

  private async settle(
    bet: PlacedBet,
    carry: number,
    won: boolean,
    via: Settlement['via'],
  ): Promise<Settlement> {
    // Idempotent by construction: whichever of the timer and the player's mark
    // arrives first wins, and the other is a no-op. Without this a mark landing
    // in the same tick as the bust timer would pay twice.
    if (bet.settled) {
      throw new Error(`bet ${bet.betId} settled twice`);
    }
    bet.settled = true;
    if (bet.timer) {
      clearTimeout(bet.timer);
      bet.timer = null;
    }

    const payout = won ? payoutFor(bet.stake, carry) : 0n;
    let balance: MinorUnits = 0n;

    if (won && payout > 0n) {
      const credit = await this.deps.wallet.credit({
        playerId: bet.playerId,
        currency: bet.currency,
        amount: payout,
        idempotencyKey: `payout:${bet.betId}`,
        roundId: bet.betId,
        carry,
      });
      if (credit.ok) {
        balance = credit.balance;
        await this.deps.audit.record('wallet.credit', bet.playerId, {
          betId: bet.betId,
          currency: bet.currency,
          amount: payout.toString(),
          carry,
          balance: balance.toString(),
        });
      } else {
        // A failed credit is a ledger incident, not a lost hole. The outcome
        // stands, it is on the audit trail, and reconciliation replays the
        // idempotency key.
        await this.deps.audit.record('wallet.error', bet.playerId, {
          op: 'credit',
          betId: bet.betId,
          reason: credit.reason,
          amount: payout.toString(),
        });
        const account = await this.deps.wallet.getAccount(bet.playerId, bet.currency);
        balance = account?.balance ?? 0n;
      }
    } else {
      const account = await this.deps.wallet.getAccount(bet.playerId, bet.currency);
      balance = account?.balance ?? 0n;
    }

    const counters = this.countersFor(bet.playerId);
    counters.net += payout - bet.stake;
    await this.deps.rg.recordSettlement(bet.playerId, bet.currency, bet.stake, payout);

    const result: HoleResult = {
      holeId: bet.betId,
      carry: bet.crashCarry,
      yards: yardsFor(bet.crashCarry),
      nonce: bet.nonce,
      serverSeedHash: bet.serverSeedHash,
      // Still null: this seed is live. It is revealed on rotation, not here.
      serverSeed: null,
      clientSeed: bet.clientSeed,
      settledAt: Date.now(),
    };

    const list = this.history.get(bet.playerId) ?? [];
    list.unshift(result);
    this.history.set(bet.playerId, list.slice(0, 60));

    await this.deps.audit.record(won ? 'bet.marked' : 'bet.busted', bet.playerId, {
      betId: bet.betId,
      via,
      carry,
      crashCarry: bet.crashCarry,
      stake: bet.stake.toString(),
      payout: payout.toString(),
      nonce: bet.nonce,
    });

    const settlement: Settlement = {
      betId: bet.betId,
      playerId: bet.playerId,
      currency: bet.currency,
      stake: bet.stake,
      won,
      carry,
      payout,
      balance,
      result,
      via,
    };

    // Hold the bet briefly so a late mark resolves to "already settled" with
    // the real outcome rather than "no such bet".
    setTimeout(() => this.bets.delete(bet.betId), SETTLE_BEAT_MS * 10);

    this.deps.onSettled(settlement);
    return settlement;
  }

  /** Player disconnected. Any in-flight hole keeps running server-side. */
  detach(playerId: string): void {
    // Deliberately does nothing to live bets. A dropped socket must not cost a
    // player their stake, and a lay-up must still be honoured — the scheduled
    // timer settles it whether anyone is listening or not.
    void playerId;
  }

  shutdown(): void {
    for (const bet of this.bets.values()) {
      if (bet.timer) clearTimeout(bet.timer);
    }
  }
}

/** Lay-up targets are 2dp and must be above the tee and inside the cap. */
function normaliseLayUp(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const rounded = Math.floor(value * 100) / 100;
  if (rounded <= 1) return null;
  return Math.min(rounded, MAX_CARRY);
}
