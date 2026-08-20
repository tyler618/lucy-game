/**
 * Serverless engine singleton for the hosted demo.
 *
 * The same engine classes the stateful server runs — same derivation, same
 * wallet contract, same RG checks, same audit chain — held at module scope so
 * a warm Vercel instance keeps a player's table between requests. The only
 * thing that differs is how the outcome reaches the client: long-poll instead
 * of a socket push.
 *
 * DEMO CAVEAT, stated here because it belongs in the code and not only in a
 * README: state lives in instance memory. A cold start gives the player a
 * fresh session — new server seed, hash published before the next hole, demo
 * balance reset. That is a legitimate seed rotation rather than a hole in the
 * fairness guarantee, but it is not a production posture. A real deployment
 * runs `@ace/server` with the operator's wallet, RG and audit adapters behind
 * the same interfaces.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { installNativeCrypto } from '@ace/server/crypto-backend';
import { AuditLog, MemorySink } from '@ace/server/audit/audit-log';
import { DemoWallet } from '@ace/server/wallet/demo-wallet';
import { DemoRgProvider } from '@ace/server/compliance/demo-rg';
import { ConfigGeoProvider } from '@ace/server/compliance/geo';
import { SeedManager } from '@ace/server/engine/seed-manager';
import { LiveFeed, avatarFor, handleFor } from '@ace/server/engine/feed';
import { Table, type Settlement } from '@ace/server/engine/table';
import { Leaderboard } from '@ace/server/leaderboard';
import { format, parseAmount } from '@ace/core';

installNativeCrypto();

/**
 * Session signing key. Provided by config in a real deployment; generated per
 * instance otherwise, which simply means tokens do not survive a cold start
 * and the client transparently gets a new session.
 */
const SESSION_SECRET = process.env.ACE_SESSION_SECRET ?? randomBytes(32).toString('hex');

export const audit = new AuditLog(new MemorySink(5_000));
export const wallet = new DemoWallet();
export const rg = new DemoRgProvider();
/**
 * Geo for the hosted demo.
 *
 * The production default deny list blocks two very different things: markets
 * that are closed to unlicensed real-money remote gaming (US, FR, NL, AU, SG),
 * and the sanctions set. This build takes no deposits, holds no real balance
 * and pays out nothing, so the licensing half does not apply to it — and
 * leaving it in place would mean the demo refuses to open for most of the
 * people it exists to show the game to.
 *
 * The sanctions half is not about gaming licences and stays enforced.
 *
 * What is NOT weakened: the geo check still runs on every session and every
 * bet, through the same GeoProvider the production server uses. Only the list
 * differs, which is exactly what "blocklist from server config, not client
 * checks" is for. A real-money deployment sets ACE_BLOCKED_JURISDICTIONS (or
 * swaps the provider) and gets the full list back.
 */
const DEMO_SANCTIONS_ONLY = ['KP', 'IR', 'SY', 'CU', 'RU', 'BY', 'MM', 'AF'];
export const geo = new ConfigGeoProvider(
  process.env.ACE_BLOCKED_JURISDICTIONS
    ? process.env.ACE_BLOCKED_JURISDICTIONS.split(',').map((c) => c.trim()).filter(Boolean)
    : DEMO_SANCTIONS_ONLY,
);
export const seeds = new SeedManager();
export const feed = new LiveFeed(60);

const DAY = 24 * 60 * 60 * 1000;
export const races = [
  new Leaderboard({
    id: 'weekly-volume',
    name: 'The Open — weekly volume',
    scope: 'wagered',
    currency: 'USDT',
    prizePool: parseAmount('25000.00000000', 'USDT'),
    payoutSchedule: [0.3, 0.2, 0.13, 0.09, 0.07, 0.05, 0.05, 0.04, 0.04, 0.03],
    startsAt: Date.now() - DAY,
    endsAt: Date.now() + 6 * DAY,
    minStake: parseAmount('1.00000000', 'USDT'),
  }),
  new Leaderboard({
    id: 'longest-drive',
    name: 'Longest Drive — highest carry',
    scope: 'highest_carry',
    currency: 'USDT',
    prizePool: parseAmount('10000.00000000', 'USDT'),
    payoutSchedule: [0.4, 0.25, 0.15, 0.1, 0.1],
    startsAt: Date.now() - DAY,
    endsAt: Date.now() + 6 * DAY,
    minStake: parseAmount('1.00000000', 'USDT'),
  }),
];

/** betId -> settlement, plus anyone long-polling for it. */
const settlements = new Map<string, Settlement>();
const waiters = new Map<string, ((s: Settlement) => void)[]>();

export const table = new Table({
  wallet,
  rg,
  geo,
  seeds,
  audit,
  onSettled: (s) => {
    settlements.set(s.betId, s);
    // Bounded: a long-lived warm instance would otherwise accumulate every
    // hole it ever served.
    if (settlements.size > 500) {
      const oldest = settlements.keys().next().value;
      if (oldest) settlements.delete(oldest);
    }
    for (const race of races) race.record(s.playerId, s.stake, s.currency, s.carry, s.won);
    feed.update(s.betId, s.won ? s.carry : 0, s.won ? format(s.payout, s.currency, { withCode: true }) : '0');
    for (const fn of waiters.get(s.betId) ?? []) fn(s);
    waiters.delete(s.betId);
  },
});

feed.startSimulated(16);

/**
 * Wait for a hole to end.
 *
 * The server knows when the ball reaches the water; the client must not, so it
 * asks and we hold the answer until it is true. Resolves immediately if the
 * player already marked.
 */
export function awaitSettlement(betId: string, timeoutMs: number): Promise<Settlement | null> {
  const already = settlements.get(betId);
  if (already) return Promise.resolve(already);
  return new Promise((resolve) => {
    const list = waiters.get(betId) ?? [];
    const fn = (s: Settlement): void => {
      clearTimeout(timer);
      resolve(s);
    };
    list.push(fn);
    waiters.set(betId, list);
    const timer = setTimeout(() => {
      const remaining = (waiters.get(betId) ?? []).filter((f) => f !== fn);
      if (remaining.length) waiters.set(betId, remaining);
      else waiters.delete(betId);
      resolve(null);
    }, timeoutMs);
  });
}

export function settlementOf(betId: string): Settlement | undefined {
  return settlements.get(betId);
}

/* ---------------- session tokens ---------------- */

function sign(playerId: string): string {
  return createHmac('sha256', SESSION_SECRET).update(playerId).digest('base64url');
}

export function issueToken(playerId: string): string {
  return `${playerId}.${sign(playerId)}`;
}

/** Returns the player id only if the signature is ours. */
export function readToken(token: string | undefined | null): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const playerId = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = sign(playerId);
  if (mac.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return playerId;
}

export function newPlayerId(): string {
  return `p_${randomBytes(9).toString('hex')}`;
}

export { handleFor, avatarFor };
