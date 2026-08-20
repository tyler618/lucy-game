/**
 * Single serverless entrypoint for the hosted demo.
 *
 * One function rather than a dozen: shared engine state only works if the
 * routes share an instance, and one function is one warm instance instead of
 * twelve cold ones. `vercel.json` rewrites every /api/* path here.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CURRENCIES,
  HOUSE_EDGE_MODULO,
  MAX_CARRY,
  THEORETICAL_RTP,
  format,
  parseAmount,
} from '@ace/core';
import {
  audit,
  awaitSettlement,
  feed,
  geo,
  issueToken,
  newPlayerId,
  races,
  readToken,
  rg,
  seeds,
  settlementOf,
  table,
  wallet,
  handleFor,
} from './_engine.js';

interface Req extends IncomingMessage {
  body?: unknown;
  query?: Record<string, string | string[]>;
}

const DEMO_CURRENCY = 'USDT';
/** Comfortably inside Vercel's function ceiling, and longer than any hole. */
const AWAIT_TIMEOUT_MS = 25_000;

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(payload);
}

async function readBody(req: Req): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === 'object') return req.body as Record<string, unknown>;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sessionOf(req: Req): { playerId: string; issued: boolean } {
  const header = req.headers['x-ace-session'];
  const existing = readToken(Array.isArray(header) ? header[0] : header);
  if (existing) return { playerId: existing, issued: false };
  return { playerId: newPlayerId(), issued: true };
}

export default async function handler(req: Req, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const route = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const method = (req.method ?? 'GET').toUpperCase();

  try {
    switch (`${method} ${route}`) {
      case 'GET health':
        return send(res, 200, { ok: true, at: Date.now(), mode: 'serverless-demo' });

      case 'GET info':
        return send(res, 200, {
          title: 'ACE',
          rtp: THEORETICAL_RTP,
          rtpDisplay: `${(THEORETICAL_RTP * 100).toFixed(2)}%`,
          maxWin: MAX_CARRY,
          maxWinDisplay: `${MAX_CARRY.toLocaleString()}x`,
          derivation:
            'floor(100 * 2^52 / (2^52 - h)) / 100, h = first 52 bits of HMAC-SHA256(serverSeed, `clientSeed:nonce`)',
          instantBust: `h % ${HOUSE_EDGE_MODULO} === 0 forces 1.00x`,
          rounding: 'Payouts truncate toward zero at the smallest unit of the currency.',
          latencyGraceMs: 200,
          currencies: Object.values(CURRENCIES),
          blockedJurisdictions: geo.list(),
          evidence: 'https://github.com/tyler618/lucy-game/blob/main/docs/math-evidence.md',
          verifier: '/verify',
          demo: true,
        });

      case 'POST session': {
        const { playerId } = sessionOf(req);
        const jurisdiction = await geo.resolve(
          req.socket.remoteAddress ?? '',
          req.headers as Record<string, string | undefined>,
        );
        if (await geo.isBlocked(jurisdiction)) {
          await audit.record('geo.block', playerId, { jurisdiction, stage: 'session' });
          return send(res, 451, { error: 'jurisdiction_blocked', jurisdiction });
        }
        const account = await wallet.getAccount(playerId, DEMO_CURRENCY);
        const seed = seeds.get(playerId);
        const status = await rg.getStatus(playerId);
        const counters = table.countersFor(playerId);
        await audit.record('session.open', playerId, { jurisdiction });
        return send(res, 200, {
          token: issueToken(playerId),
          serverTime: Date.now(),
          handle: handleFor(playerId),
          currency: DEMO_CURRENCY,
          balance: (account?.balance ?? 0n).toString(),
          serverSeedHash: seed.serverSeedHash,
          clientSeed: seed.clientSeed,
          nonce: seed.nonce,
          sessionStartedAt: counters.startedAt,
          netPosition: counters.net.toString(),
          kycVerified: status.kycVerified,
          ageVerified: status.ageVerified,
          jurisdiction,
          history: table.historyFor(playerId),
          currencies: Object.values(CURRENCIES),
        });
      }

      case 'POST bet': {
        const { playerId } = sessionOf(req);
        const body = await readBody(req);
        const stakeRaw = String(body.stake ?? '');
        if (!/^\d{1,30}$/.test(stakeRaw)) {
          return send(res, 400, { ok: false, reason: 'stake_below_min', message: 'Invalid stake.' });
        }
        const currency = typeof body.currency === 'string' ? body.currency : DEMO_CURRENCY;
        const layUpAt = typeof body.layUpAt === 'number' ? body.layUpAt : null;
        const jurisdiction = await geo.resolve(
          req.socket.remoteAddress ?? '',
          req.headers as Record<string, string | undefined>,
        );

        const placed = await table.place(playerId, currency, BigInt(stakeRaw), layUpAt, jurisdiction);
        if (!placed.ok) return send(res, 200, { ok: false, reason: placed.reason, message: placed.message });

        feed.push({
          betId: placed.bet.betId,
          handle: handleFor(playerId),
          avatar: 0,
          currency,
          stake: stakeRaw,
          stakeDisplay: format(BigInt(stakeRaw), currency, { withCode: true }),
          carry: null,
          payout: null,
          simulated: false,
          at: Date.now(),
        });

        // Note what is NOT in this response: the crash point, the flight
        // duration, or anything the client could derive either from.
        return send(res, 200, {
          ok: true,
          betId: placed.bet.betId,
          teedOffAt: placed.bet.teedOffAt,
          balance: placed.balance.toString(),
          serverTime: Date.now(),
        });
      }

      case 'POST mark': {
        const { playerId } = sessionOf(req);
        const body = await readBody(req);
        const betId = String(body.betId ?? '');
        const result = await table.mark(playerId, betId);
        if ('error' in result) {
          // A mark that lost the race to the bust timer still has a real
          // outcome — return it rather than an error the UI cannot act on.
          const settled = settlementOf(betId);
          if (settled) return send(res, 200, toWire(settled));
          return send(res, 409, { error: result.error });
        }
        return send(res, 200, toWire(result));
      }

      case 'POST await': {
        const body = await readBody(req);
        const betId = String(body.betId ?? '');
        const settled = await awaitSettlement(betId, AWAIT_TIMEOUT_MS);
        if (!settled) return send(res, 504, { error: 'timeout' });
        return send(res, 200, toWire(settled));
      }

      case 'GET feed': {
        const since = Number(url.searchParams.get('since') ?? 0);
        const items = feed.snapshot().filter((e) => e.at > since);
        return send(res, 200, {
          cursor: Date.now(),
          items: items.slice(0, 30).map((e) => ({
            betId: e.betId,
            handle: e.handle,
            currency: e.currency,
            stake: e.stake,
            stakeDisplay: e.stakeDisplay,
            cashedCarry: e.carry,
            payout: e.payout,
            simulated: e.simulated,
          })),
        });
      }

      case 'POST seeds': {
        const { playerId } = sessionOf(req);
        if (table.activeBetFor(playerId)) {
          return send(res, 409, { error: 'Finish the hole before rotating seeds.' });
        }
        const body = await readBody(req);
        const { revealed, next } = seeds.rotate(
          playerId,
          typeof body.clientSeed === 'string' && body.clientSeed ? body.clientSeed : undefined,
        );
        await audit.record('seed.rotate', playerId, {
          revealedHash: revealed.serverSeedHash,
          revealedSeed: revealed.serverSeed,
          finalNonce: revealed.finalNonce,
          nextHash: next.serverSeedHash,
        });
        return send(res, 200, {
          serverSeedHash: next.serverSeedHash,
          clientSeed: next.clientSeed,
          nonce: next.nonce,
          previous: revealed,
        });
      }

      case 'POST limits': {
        const { playerId } = sessionOf(req);
        const body = await readBody(req);
        const kind = String(body.kind ?? '');
        const currency = typeof body.currency === 'string' ? body.currency : DEMO_CURRENCY;
        const raw = String(body.value ?? '').trim();
        if (kind === 'loss') {
          const value = raw ? parseAmount(raw, currency) : null;
          await rg.setLimits(playerId, currency, { dailyLoss: value });
        } else if (kind === 'session') {
          const mins = Number(raw);
          await rg.setLimits(playerId, currency, {
            sessionMs: Number.isFinite(mins) && mins > 0 ? mins * 60_000 : null,
          });
        }
        await audit.record('rg.limit_set', playerId, { kind, value: raw, currency });
        return send(res, 200, { ok: true });
      }

      case 'POST exclude': {
        const { playerId } = sessionOf(req);
        const body = await readBody(req);
        const days = Math.max(1, Math.min(3650, Number(body.days ?? 1)));
        const until = Date.now() + days * 24 * 60 * 60 * 1000;
        // One day reads as a cool-off; anything longer is an exclusion. Both
        // refuse bets at the server — neither hides a button.
        if (days <= 1) await rg.coolOff(playerId, until);
        else await rg.selfExclude(playerId, until);
        await audit.record('rg.block', playerId, { kind: days <= 1 ? 'cool_off' : 'self_exclude', until });
        return send(res, 200, { ok: true, until });
      }

      case 'GET leaderboard': {
        const scope = url.searchParams.get('scope') ?? 'wagered';
        const race = races.find((r) => r.config.scope === scope);
        if (!race) return send(res, 404, { error: 'No race with that scope.' });
        return send(res, 200, {
          scope,
          name: race.config.name,
          currency: race.config.currency,
          prizePool: format(race.config.prizePool, race.config.currency, { withCode: true }),
          startsAt: race.config.startsAt,
          endsAt: race.config.endsAt,
          entries: race.table(),
        });
      }

      case 'GET audit/verify':
        return send(res, 200, await audit.verifyChain());

      default:
        return send(res, 404, { error: `No route for ${method} /api/${route}` });
    }
  } catch (err) {
    return send(res, 500, { error: err instanceof Error ? err.message : 'Server error' });
  }
}

function toWire(s: {
  betId: string;
  won: boolean;
  carry: number;
  payout: bigint;
  balance: bigint;
  result: unknown;
}): Record<string, unknown> {
  return {
    betId: s.betId,
    won: s.won,
    carry: s.carry,
    payout: s.payout.toString(),
    balance: s.balance.toString(),
    result: s.result,
  };
}
