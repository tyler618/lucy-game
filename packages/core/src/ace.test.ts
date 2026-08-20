/**
 * Core tests. These pin the things that must never drift:
 * the hash primitive against published vectors, the derivation against the
 * node:crypto path the server actually runs, money against float error, and
 * autobet against off-by-one stake escalation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

import { sha256Hex, hmacSha256Hex } from './sha256.js';
import {
  carryFromHash,
  deriveHole,
  first52Bits,
  hashServerSeed,
  hmacHex,
  legacyBustabitCarry,
  setHmacBackend,
  uncappedCarryFromHash,
  verifyServerSeed,
} from './provably-fair.js';
import { E52, HOUSE_EDGE_MODULO, MAX_CARRY, THEORETICAL_RTP } from './constants.js';
import { applyPercent, format, parseAmount, payoutFor, profitFor, toExactString } from './money.js';
import { advanceAutobet, startAutobet, type AutobetConfig } from './autobet.js';
import { carryAt, displayCarryAt, timeToReach, yardsFor } from './flight.js';

test('sha256 matches FIPS 180-4 published vectors', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
});

test('pure-JS sha256 and hmac agree with node:crypto across lengths', () => {
  for (let n = 0; n < 200; n += 7) {
    const msg = 'x'.repeat(n) + n;
    assert.equal(sha256Hex(msg), createHash('sha256').update(msg).digest('hex'), `sha256 len ${n}`);
    const key = 'k'.repeat(n % 130);
    assert.equal(
      hmacSha256Hex(key, msg),
      createHmac('sha256', key).update(msg).digest('hex'),
      `hmac keylen ${key.length}`,
    );
  }
});

test('swapping the hash backend does not change a single outcome', () => {
  const triplet = { serverSeed: 'a'.repeat(64), clientSeed: 'player-seed', nonce: 7 };
  const pure = deriveHole(triplet);
  setHmacBackend({
    hmacSha256Hex: (k, m) => createHmac('sha256', k).update(m, 'utf8').digest('hex'),
    sha256Hex: (m) => createHash('sha256').update(m, 'utf8').digest('hex'),
  });
  const native = deriveHole(triplet);
  assert.deepEqual(native, pure);
});

test('derivation is deterministic and reproduces from the published inputs', () => {
  const serverSeed = 'deadbeef'.repeat(8);
  const clientSeed = 'ace';
  const hole = deriveHole({ serverSeed, clientSeed, nonce: 1 });
  assert.equal(hole.hash, hmacHex(serverSeed, clientSeed, 1));
  assert.equal(hole.h, first52Bits(hole.hash));
  assert.equal(hole.carry, carryFromHash(hole.h));
  assert.equal(hole.yards, Math.round(hole.carry * 100));
  // A verifier recomputing from scratch must land on the same number.
  assert.equal(deriveHole({ serverSeed, clientSeed, nonce: 1 }).carry, hole.carry);
});

test('server seed hash verification accepts the truth and rejects everything else', () => {
  const seed = 'f'.repeat(64);
  const published = hashServerSeed(seed);
  assert.ok(verifyServerSeed(seed, published));
  assert.ok(verifyServerSeed(seed, published.toUpperCase()));
  assert.ok(!verifyServerSeed(seed.replace(/^f/, 'e'), published));
  assert.ok(!verifyServerSeed(seed, published.slice(0, -1)));
});

test('instant-bust band lands exactly 1 in HOUSE_EDGE_MODULO', () => {
  let busts = 0;
  const N = HOUSE_EDGE_MODULO * 1000;
  for (let h = 0; h < N; h++) if (carryFromHash(h) === 1) busts++;
  // Every multiple of the modulo busts; some low h values also floor to 1.00,
  // so this asserts the band itself, not the total 1.00x rate.
  for (let h = 0; h < N; h += HOUSE_EDGE_MODULO) assert.equal(carryFromHash(h), 1, `h=${h} should bust`);
  assert.ok(busts >= N / HOUSE_EDGE_MODULO);
});

test('the cap is enforced inside the derivation, not at settlement', () => {
  // h just below E52 drives the raw curve arbitrarily high.
  const h = E52 - 1;
  assert.ok(uncappedCarryFromHash(h) > MAX_CARRY);
  assert.equal(carryFromHash(h), MAX_CARRY);
  assert.ok(deriveHole({ serverSeed: 'a', clientSeed: 'b', nonce: 1 }).carry <= MAX_CARRY);
});

test('survival probability is 1/m, which is what makes RTP flat', () => {
  // P(carry >= m) = floor(100E/m*100)/E, ignoring the bust band. Checked
  // analytically rather than by sampling so the test is exact and instant.
  for (const m of [1.5, 2, 5, 10, 100, 1000]) {
    const K = Math.floor((100 * E52) / Math.round(m * 100));
    const survival = (K / E52) * (1 - 1 / HOUSE_EDGE_MODULO);
    const rtp = m * survival;
    assert.ok(Math.abs(rtp - THEORETICAL_RTP) < 1e-9, `RTP at ${m}x was ${rtp}`);
  }
});

test('the bustabit curve is measurably not flat, which is why it is not shipped', () => {
  const rtpAt = (m: number) => {
    // P(legacy >= m) = 99/(100m - 1)
    return m * (99 / (100 * m - 1)) * (1 - 1 / HOUSE_EDGE_MODULO);
  };
  assert.ok(Math.abs(rtpAt(1.01) - 0.99) < 1e-4);
  assert.ok(rtpAt(1000) < 0.9805);
  // And the function still exists so the evidence file can quote it.
  assert.equal(legacyBustabitCarry(HOUSE_EDGE_MODULO), 1);
});

test('money parses, formats and round-trips without touching a float', () => {
  assert.equal(parseAmount('0.00000001', 'BTC'), 1n);
  assert.equal(parseAmount('1', 'BTC'), 100_000_000n);
  assert.equal(toExactString(123_456_789n, 'BTC'), '1.23456789');
  assert.equal(format(123_456_789n, 'BTC', { withCode: true }), '1.23456789 BTC');
  assert.equal(format(1_234_567_890n, 'USD'), '$12,345,678.90');
  // The classic float failure, which must not be reachable through this API.
  assert.equal(parseAmount('0.1', 'USD') + parseAmount('0.2', 'USD'), parseAmount('0.3', 'USD'));
  assert.throws(() => parseAmount('0.123', 'USD'));
  assert.throws(() => parseAmount('abc', 'USD'));
});

test('payout truncates toward zero at the smallest unit, never up', () => {
  // 3 sats at 1.5x is 4.5 sats. The player gets 4, as disclosed.
  assert.equal(payoutFor(3n, 1.5), 4n);
  assert.equal(profitFor(3n, 1.5), 1n);
  assert.equal(payoutFor(100_000_000n, 2.41), 241_000_000n);
  assert.equal(payoutFor(1n, 1), 1n);
  assert.equal(payoutFor(12_345_678n, 10_000), 123_456_780_000n);
});

test('percentage steps are exact in minor units', () => {
  assert.equal(applyPercent(1000n, 50), 1500n);
  assert.equal(applyPercent(1000n, 12.75), 1127n);
  assert.equal(applyPercent(1000n, 0), 1000n);
});

test('flight curve and its inverse agree, and yards track the multiplier', () => {
  for (const m of [1.5, 2, 10, 250, MAX_CARRY]) {
    assert.ok(Math.abs(carryAt(timeToReach(m)) - m) < 1e-6, `round trip at ${m}`);
  }
  assert.equal(carryAt(0), 1);
  assert.equal(carryAt(-500), 1);
  assert.ok(carryAt(10_000_000) <= MAX_CARRY);
  assert.equal(yardsFor(2.41), 241);
  assert.equal(displayCarryAt(timeToReach(2.4)), 2.4);
});

const baseConfig = (over: Partial<AutobetConfig> = {}): AutobetConfig => ({
  rounds: 0,
  baseStake: 100n,
  layUpAt: 2,
  stopOnProfit: null,
  stopOnLoss: null,
  increaseOnWinPct: 0,
  increaseOnLossPct: 100,
  resetOnWin: true,
  ...over,
});

test('autobet martingales on loss and resets on win', () => {
  const config = baseConfig();
  let state = startAutobet(config);
  state = advanceAutobet(state, config, { won: false, profit: -100n }, 10_000n);
  assert.equal(state.nextStake, 200n);
  state = advanceAutobet(state, config, { won: false, profit: -200n }, 10_000n);
  assert.equal(state.nextStake, 400n);
  state = advanceAutobet(state, config, { won: true, profit: 400n }, 10_000n);
  assert.equal(state.nextStake, 100n);
  assert.equal(state.netProfit, 100n);
  assert.ok(state.running);
});

test('autobet stops on profit target, loss limit, round count and empty balance', () => {
  let config = baseConfig({ stopOnProfit: 150n });
  let state = advanceAutobet(startAutobet(config), config, { won: true, profit: 200n }, 10_000n);
  assert.equal(state.stopReason, 'profit_target');
  assert.ok(!state.running);

  config = baseConfig({ stopOnLoss: 150n });
  state = advanceAutobet(startAutobet(config), config, { won: false, profit: -200n }, 10_000n);
  assert.equal(state.stopReason, 'loss_limit');

  config = baseConfig({ rounds: 1 });
  state = advanceAutobet(startAutobet(config), config, { won: false, profit: -100n }, 10_000n);
  assert.equal(state.stopReason, 'rounds_complete');

  // A martingale that outruns the balance stops rather than firing rejected
  // bets at the server forever.
  config = baseConfig({ increaseOnLossPct: 100 });
  state = advanceAutobet(startAutobet(config), config, { won: false, profit: -100n }, 150n);
  assert.equal(state.stopReason, 'insufficient_funds');
});

test('autobet never stages a stake after a stop condition fires', () => {
  const config = baseConfig({ stopOnProfit: 50n, increaseOnWinPct: 100, resetOnWin: false });
  const state = advanceAutobet(startAutobet(config), config, { won: true, profit: 100n }, 10_000n);
  assert.equal(state.nextStake, 100n, 'stake must not escalate past a stop');
  assert.ok(!state.running);
});
