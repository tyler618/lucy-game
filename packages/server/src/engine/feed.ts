/**
 * Live bet feed.
 *
 * Social proof is the retention engine on a crash title: an empty table reads
 * as a dead game. The feed broadcasts real players' holes as they happen, with
 * handles anonymised at the boundary — a handle here is derived from the
 * player id and is never reversible to an account.
 *
 * The demo build additionally runs simulated tables so a single visitor sees a
 * populated feed. Those entries are flagged `simulated: true` on the wire and
 * labelled in the UI. Dressing bots up as real players is the kind of thing
 * that ends a licence, so the flag is not optional and not removable from
 * config.
 */
import { createHash } from 'node:crypto';
import { deriveHole, format, parseAmount, timeToReach, type MinorUnits } from '@ace/core';
import { randomBytes } from 'node:crypto';

export interface FeedEntry {
  betId: string;
  handle: string;
  avatar: number;
  currency: string;
  stake: string;
  stakeDisplay: string;
  carry: number | null;
  payout: string | null;
  simulated: boolean;
  at: number;
}

/** Stable, non-reversible display handle. Same player, same handle, no PII. */
export function handleFor(playerId: string): string {
  const h = createHash('sha256').update(`ace-handle|${playerId}`).digest('hex');
  return `${h.slice(0, 2).toUpperCase()}${'*'.repeat(4)}${h.slice(-2).toUpperCase()}`;
}

export function avatarFor(playerId: string): number {
  const h = createHash('sha256').update(`ace-avatar|${playerId}`).digest();
  return h[0]! % 6;
}

type Listener = (entry: FeedEntry) => void;

export class LiveFeed {
  private readonly recent: FeedEntry[] = [];
  private readonly listeners = new Set<Listener>();
  private botTimer: NodeJS.Timeout | null = null;

  constructor(private readonly cap = 40) {}

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): FeedEntry[] {
    return [...this.recent];
  }

  push(entry: FeedEntry): void {
    this.recent.unshift(entry);
    if (this.recent.length > this.cap) this.recent.length = this.cap;
    for (const fn of this.listeners) fn(entry);
  }

  update(betId: string, carry: number, payout: string): void {
    const found = this.recent.find((e) => e.betId === betId);
    if (!found) return;
    found.carry = carry;
    found.payout = payout;
    for (const fn of this.listeners) fn(found);
  }

  /**
   * Simulated tables for the demo build.
   *
   * Each bot runs a genuine provably fair hole off its own seed triplet — the
   * same derivation as a real player, not a random number dressed up as one.
   * That keeps the feed's distribution honest: the carries scrolling past are
   * drawn from the game's actual distribution, so the strip a player reads
   * patterns into is the real one.
   */
  startSimulated(count = 14): void {
    if (this.botTimer) return;
    const bots = Array.from({ length: count }, (_, i) => ({
      playerId: `sim-${i}-${randomBytes(3).toString('hex')}`,
      serverSeed: randomBytes(32).toString('hex'),
      clientSeed: randomBytes(6).toString('hex'),
      nonce: 0,
      currency: (['USDT', 'BTC', 'ETH', 'SOL', 'LTC'] as const)[i % 5]!,
    }));

    const tick = () => {
      const bot = bots[Math.floor(Math.random() * bots.length)]!;
      bot.nonce += 1;
      const hole = deriveHole({ serverSeed: bot.serverSeed, clientSeed: bot.clientSeed, nonce: bot.nonce });

      const stake = simStake(bot.currency);
      const betId = `sim_${bot.playerId}_${bot.nonce}`;
      this.push({
        betId,
        handle: handleFor(bot.playerId),
        avatar: avatarFor(bot.playerId),
        currency: bot.currency,
        stake: stake.toString(),
        stakeDisplay: format(stake, bot.currency, { withCode: true }),
        carry: null,
        payout: null,
        simulated: true,
        at: Date.now(),
      });

      // Bots pick a lay-up from a plausible spread and either bank it or find
      // the water, on the real timeline of their own hole.
      const target = simTarget();
      if (target <= hole.carry) {
        setTimeout(() => {
          const payout = (stake * BigInt(Math.round(target * 100))) / 100n;
          this.update(betId, target, format(payout, bot.currency, { withCode: true }));
        }, Math.min(timeToReach(target), 20_000));
      } else {
        setTimeout(() => this.update(betId, 0, '0'), Math.min(timeToReach(hole.carry), 20_000));
      }

      this.botTimer = setTimeout(tick, 400 + Math.random() * 1600);
    };
    this.botTimer = setTimeout(tick, 300);
  }

  stop(): void {
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = null;
  }
}

const SIM_STAKES: Record<string, string[]> = {
  USDT: ['1.00', '5.00', '10.00', '25.00', '50.00', '100.00', '250.00'],
  BTC: ['0.00001000', '0.00005000', '0.00010000', '0.00025000'],
  ETH: ['0.00100000', '0.00500000', '0.01000000', '0.05000000'],
  SOL: ['0.10000000', '0.50000000', '1.00000000', '2.50000000'],
  LTC: ['0.05000000', '0.10000000', '0.50000000', '1.00000000'],
};

function simStake(currency: string): MinorUnits {
  const options = SIM_STAKES[currency] ?? SIM_STAKES.USDT!;
  return parseAmount(options[Math.floor(Math.random() * options.length)]!, currency);
}

/** Weighted toward the low targets, which is where real crash volume sits. */
function simTarget(): number {
  const r = Math.random();
  if (r < 0.45) return 1.2 + Math.random() * 0.6;
  if (r < 0.8) return 1.8 + Math.random() * 1.4;
  if (r < 0.95) return 3 + Math.random() * 7;
  return 10 + Math.random() * 90;
}
