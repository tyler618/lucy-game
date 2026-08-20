/**
 * Wire protocol. Server -> client over WebSocket, client -> server for intents.
 *
 * Two rules hold this together:
 *   1. Nothing in a server->client message before `hole.settled` contains the
 *      crash point. The client cannot leak what it was never told.
 *   2. Every client->server message is an *intent*, never an assertion. The
 *      client asks to mark it; the server decides whether it did.
 */
import type { MinorUnits } from './money.js';

export type HolePhase = 'idle' | 'betting' | 'in_flight' | 'settled';

/** Server-authoritative clock sync. The client corrects its own drift to this. */
export interface ServerClock {
  serverTime: number;
  /** Monotonic sequence so a client can discard reordered frames. */
  seq: number;
}

export interface PublicHoleState {
  holeId: string;
  phase: HolePhase;
  /** Epoch ms when the betting window closes / closed. */
  bettingClosesAt: number;
  /** Epoch ms of tee off. Null while betting. */
  teedOffAt: number | null;
  /** Only ever populated once the hole is settled. */
  settledCarry: number | null;
  /** SHA-256 of the server seed governing this hole. Published before the tee. */
  serverSeedHash: string;
  nonce: number;
}

export interface PublicBet {
  betId: string;
  /** Anonymised handle. Never a real username, never an account id. */
  handle: string;
  currency: string;
  /** Exact minor-unit string. bigint does not survive JSON. */
  stake: string;
  /** Set once the player marks it. */
  markedAt: number | null;
  cashedCarry: number | null;
  payout: string | null;
}

export interface HoleResult {
  holeId: string;
  carry: number;
  yards: number;
  nonce: number;
  serverSeedHash: string;
  /** Revealed only after the seed is rotated out. */
  serverSeed: string | null;
  clientSeed: string;
  settledAt: number;
}

export type ServerMessage =
  | { t: 'hello'; clock: ServerClock; state: PublicHoleState; history: HoleResult[]; you: SessionSnapshot }
  | { t: 'clock'; clock: ServerClock }
  | { t: 'hole.betting'; state: PublicHoleState }
  | { t: 'hole.teeoff'; state: PublicHoleState }
  | { t: 'hole.settled'; state: PublicHoleState; result: HoleResult }
  | { t: 'bet.accepted'; betId: string; holeId: string; stake: string; currency: string; balance: string }
  | { t: 'bet.rejected'; reason: BetRejection; message: string }
  | { t: 'bet.marked'; betId: string; carry: number; payout: string; balance: string }
  | { t: 'bet.busted'; betId: string; carry: number }
  | { t: 'feed'; bets: PublicBet[] }
  | { t: 'feed.marked'; betId: string; carry: number; payout: string }
  | { t: 'balance'; currency: string; balance: string }
  | { t: 'rg.notice'; kind: RgNoticeKind; message: string; until?: number }
  | { t: 'seeds'; serverSeedHash: string; clientSeed: string; nonce: number; previous?: RevealedSeed }
  | { t: 'leaderboard'; scope: LeaderboardScope; entries: LeaderboardEntry[]; endsAt: number }
  | { t: 'error'; message: string };

export type ClientMessage =
  | { t: 'auth'; token: string }
  | { t: 'bet.place'; holeId: string; stake: string; currency: string; layUpAt: number | null; nonceHint?: number }
  | { t: 'bet.cancel'; betId: string }
  | { t: 'bet.mark'; betId: string }
  | { t: 'seeds.rotate'; clientSeed: string }
  | { t: 'leaderboard.subscribe'; scope: LeaderboardScope }
  | { t: 'pong'; seq: number };

export type BetRejection =
  | 'insufficient_funds'
  | 'betting_closed'
  | 'stake_below_min'
  | 'stake_above_max'
  | 'self_excluded'
  | 'cool_off'
  | 'loss_limit'
  | 'deposit_limit'
  | 'session_limit'
  | 'kyc_required'
  | 'age_unverified'
  | 'jurisdiction_blocked'
  | 'already_bet'
  | 'wallet_error';

export type RgNoticeKind = 'reality_check' | 'session_limit' | 'loss_limit' | 'cool_off' | 'self_excluded';

export interface RevealedSeed {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  /** Highest nonce played under this seed. */
  finalNonce: number;
}

export interface SessionSnapshot {
  handle: string;
  currency: string;
  balance: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  /** Wall-clock ms this session has been open, for the always-reachable clock. */
  sessionStartedAt: number;
  netPosition: string;
  kycVerified: boolean;
  ageVerified: boolean;
  jurisdiction: string;
}

export type LeaderboardScope = 'wagered' | 'highest_carry';

export interface LeaderboardEntry {
  rank: number;
  handle: string;
  /** Minor-unit string for 'wagered', carry as a decimal string for 'highest_carry'. */
  value: string;
  currency: string;
  prize: string | null;
}

/** Helper: minor units cross the wire as decimal strings, never as numbers. */
export const wire = {
  units: (u: MinorUnits): string => u.toString(),
  parse: (s: string): MinorUnits => BigInt(s),
};
