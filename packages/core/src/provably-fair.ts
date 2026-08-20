/**
 * Provably fair derivation — the single source of truth for every ACE outcome.
 *
 * Isomorphic by construction: the server derives outcomes with it, the public
 * verifier page derives outcomes with it, and the simulation harness derives
 * outcomes with it. One implementation, so there is nothing for the three to
 * disagree about.
 *
 * Seed triplet (Stake-standard):
 *   serverSeed  32 random bytes hex, per player. SHA-256 hash published up
 *               front, plaintext revealed on rotation.
 *   clientSeed  player-editable UTF-8 string.
 *   nonce       increments once per hole.
 */
import { hmacSha256Hex, sha256Hex } from './sha256.js';
import { HOUSE_EDGE_MODULO, MAX_CARRY, MIN_CARRY, E52 } from './constants.js';

/**
 * Hash backend. Defaults to the bundled pure-JS implementation so the verifier
 * runs anywhere. Node hosts (server, simulation) call `setHmacBackend` with
 * node:crypto for roughly an order of magnitude more throughput — same
 * algorithm, same bytes, pinned by test against the pure path.
 */
export interface HashBackend {
  hmacSha256Hex(key: string, msg: string): string;
  sha256Hex(msg: string): string;
}

let backend: HashBackend = { hmacSha256Hex, sha256Hex };

export function setHmacBackend(next: HashBackend): void {
  backend = next;
}

/** SHA-256 hex of a server seed — this is what the player sees before play. */
export function hashServerSeed(serverSeed: string): string {
  return backend.sha256Hex(serverSeed);
}

/** The message half of the HMAC. Documented publicly so anyone can reproduce it. */
export function messageFor(clientSeed: string, nonce: number): string {
  return `${clientSeed}:${nonce}`;
}

/** Full HMAC-SHA256 hex digest for a seed triplet. */
export function hmacHex(serverSeed: string, clientSeed: string, nonce: number): string {
  return backend.hmacSha256Hex(serverSeed, messageFor(clientSeed, nonce));
}

/**
 * First 52 bits of a hex digest as an exact integer.
 * 13 hex chars = 52 bits, which sits below Number.MAX_SAFE_INTEGER, so this is
 * exact in every JS runtime — no BigInt, no precision caveat to explain to a
 * player checking our work.
 */
export function first52Bits(hex: string): number {
  return parseInt(hex.slice(0, 13), 16);
}

/**
 * Carry point from 52 bits of entropy.
 *
 * ACE uses the inverse-CDF form, `100E / (E - h)`, which yields
 * P(carry >= m) = 1/m exactly for every target m. Multiplying by the
 * instant-bust band gives P(carry >= m) = (1 - 1/M)/m, so
 * RTP(m) = m * P(carry >= m) = 1 - 1/M — the same 99.0099% whether the player
 * lays up at 1.01x or holds for 10,000x.
 *
 * NOTE FOR CERTIFICATION. The widely copied bustabit form,
 * `(100E - h) / (E - h)`, is NOT flat: its RTP slides from 99.00% at a 1.01x
 * lay-up to 98.02% asymptotically (see `legacyBustabitCarry` and the
 * comparison table in docs/math-evidence.md). No choice of houseEdgeModulo
 * corrects that, because the tilt is in the curve, not the band. A
 * target-dependent RTP is both an advantage-play surface at the low end and an
 * undisclosed extra edge at the high end — it is not certifiable against a
 * single published RTP figure. ACE does not ship it.
 *
 * The MAX_CARRY clamp lives inside the derivation, not at settlement, so the
 * cap is part of the provably fair result. A verifier running this function
 * reproduces the exact number the player saw.
 */
export function carryFromHash(h: number, houseEdgeModulo: number = HOUSE_EDGE_MODULO): number {
  return Math.min(uncappedCarryFromHash(h, houseEdgeModulo), MAX_CARRY);
}

/** The uncapped derivation. Evidence reporting only — never settles a hole. */
export function uncappedCarryFromHash(h: number, houseEdgeModulo: number = HOUSE_EDGE_MODULO): number {
  if (h % houseEdgeModulo === 0) return MIN_CARRY;
  return Math.floor((100 * E52) / (E52 - h)) / 100;
}

/**
 * The bustabit-style curve, retained solely so the simulation harness can
 * publish the side-by-side that justifies not shipping it. Never called in
 * settlement, and there is a test asserting as much.
 */
export function legacyBustabitCarry(h: number, houseEdgeModulo: number = HOUSE_EDGE_MODULO): number {
  if (h % houseEdgeModulo === 0) return MIN_CARRY;
  return Math.floor((100 * E52 - h) / (E52 - h)) / 100;
}

export interface SeedTriplet {
  serverSeed: string;
  clientSeed: string;
  nonce: number;
}

export interface DerivedHole {
  hash: string;
  h: number;
  carry: number;
  yards: number;
  cappedAtMax: boolean;
}

/** End-to-end derivation: seed triplet in, settled hole out. */
export function deriveHole(
  { serverSeed, clientSeed, nonce }: SeedTriplet,
  houseEdgeModulo: number = HOUSE_EDGE_MODULO,
): DerivedHole {
  const hash = hmacHex(serverSeed, clientSeed, nonce);
  const h = first52Bits(hash);
  const uncapped = uncappedCarryFromHash(h, houseEdgeModulo);
  return {
    hash,
    h,
    carry: Math.min(uncapped, MAX_CARRY),
    yards: Math.round(Math.min(uncapped, MAX_CARRY) * 100),
    cappedAtMax: uncapped > MAX_CARRY,
  };
}

/** Confirms a revealed server seed matches the hash the player was shown. */
export function verifyServerSeed(serverSeed: string, publishedHash: string): boolean {
  const actual = hashServerSeed(serverSeed);
  const expected = publishedHash.trim().toLowerCase();
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
