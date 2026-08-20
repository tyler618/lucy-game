/**
 * The flight curve. Shared verbatim by server and client.
 *
 * The server owns the outcome; the client owns nothing but the tween. Both
 * evaluate the same closed-form function of elapsed time so the number on
 * screen and the number the server would settle at are the same number. A
 * client-side approximation here is how cash-out disputes get created.
 */
import { CARRY_GROWTH_PER_MS, MAX_CARRY, YARDS_PER_MULTIPLIER } from './constants.js';

/** Carry multiplier at t milliseconds after tee off. */
export function carryAt(elapsedMs: number): number {
  if (elapsedMs <= 0) return 1;
  const raw = Math.exp(CARRY_GROWTH_PER_MS * elapsedMs);
  return Math.min(raw, MAX_CARRY);
}

/**
 * Carry, floored to the 2 decimals the player actually sees.
 *
 * The epsilon is load-bearing, not cosmetic. `exp(log(2.4))` is
 * 2.3999999999999995, so a naive floor shows 2.39 at the exact instant the
 * server considers the ball to be at 2.40 — which would make a 2.40x lay-up
 * look like it paid 2.39x. The nudge is far smaller than one hundredth, so it
 * can never round a carry up past a boundary the ball has not actually
 * reached.
 */
const DISPLAY_EPSILON = 1e-9;

export function displayCarryAt(elapsedMs: number): number {
  return Math.floor(carryAt(elapsedMs) * 100 + DISPLAY_EPSILON) / 100;
}

/** Inverse: when does the ball reach this carry? Used to schedule the splash. */
export function timeToReach(carry: number): number {
  if (carry <= 1) return 0;
  return Math.log(Math.min(carry, MAX_CARRY)) / CARRY_GROWTH_PER_MS;
}

/** The other costume for the same number. 2.41x -> 241y. Never break this. */
export function yardsFor(carry: number): number {
  return Math.round(carry * YARDS_PER_MULTIPLIER);
}

/** Total flight duration for a settled hole, in ms. */
export function flightDurationMs(crashCarry: number): number {
  return timeToReach(crashCarry);
}

/**
 * Normalised ball position along its arc, 0..1, for a given carry.
 * Log-scaled so the early holes (where almost every round lands) use most of
 * the fairway, and a 500x moonshot still fits on a phone screen.
 */
export function arcProgress(carry: number, horizonCarry: number): number {
  const c = Math.max(1, carry);
  const h = Math.max(1.01, horizonCarry);
  return Math.min(1, Math.log(c) / Math.log(h));
}
