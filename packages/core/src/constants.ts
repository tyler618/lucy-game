/**
 * ACE — locked game constants.
 *
 * These values are certification surface. Changing any of them invalidates
 * `docs/math-evidence.md` and requires a re-run of the simulation harness
 * (`npm run sim`) plus a fresh evidence commit.
 */

/**
 * The instant-bust band. `h % HOUSE_EDGE_MODULO === 0` forces a 1.00x hole,
 * which is the entire source of the house edge. Theoretical RTP is
 * (MODULO - 1) / MODULO for every cash-out target, i.e. 100/101 = 99.0099%.
 *
 * LOCKED after 100,000,000-round simulation. See docs/math-evidence.md.
 */
export const HOUSE_EDGE_MODULO = 101;

/** Theoretical return to player for any single-target strategy. */
export const THEORETICAL_RTP = (HOUSE_EDGE_MODULO - 1) / HOUSE_EDGE_MODULO;

/** Hard ceiling on carry. Enforced server-side inside the derivation itself. */
export const MAX_CARRY = 10_000;

/** Floor. A hole can never settle below the tee. */
export const MIN_CARRY = 1;

/** 52 bits of entropy — the largest integer range JS floats represent exactly. */
export const E52 = 2 ** 52;

/**
 * Flight curve growth constant, per millisecond.
 * carry(t) = e^(k*t). k = 0.00015 => 2.00x at ~4.62s, 10.00x at ~15.35s,
 * MAX_CARRY at ~61.4s. Median hole is ~2x, so the median flight is under 5s
 * and the round cadence lands inside the 6-12s target.
 */
export const CARRY_GROWTH_PER_MS = 0.00015;

/** Yards shown on the plate for a given carry multiplier. 2.41x -> 241y. */
export const YARDS_PER_MULTIPLIER = 100;

/** Round cadence, milliseconds. */
export const BETTING_WINDOW_MS = 5_000;
export const SETTLE_BEAT_MS = 800;
export const TEE_UP_BEAT_MS = 600;

/** How many holes the carry history strip retains. */
export const HISTORY_LENGTH = 30;
