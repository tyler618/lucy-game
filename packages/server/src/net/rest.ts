/**
 * REST surface: wallet, history, game info, compliance disclosures.
 *
 * Round state goes over the socket; everything that is a fact rather than an
 * event goes over HTTP, where it is cacheable and inspectable. Every response
 * is JSON with minor units as strings.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CURRENCIES,
  HOUSE_EDGE_MODULO,
  MAX_CARRY,
  THEORETICAL_RTP,
  format,
} from '@ace/core';
import type { Table } from '../engine/table.js';
import type { SeedManager } from '../engine/seed-manager.js';
import type { WalletProvider } from '../wallet/types.js';
import type { AuditLog } from '../audit/audit-log.js';
import type { ConfigGeoProvider } from '../compliance/geo.js';
import type { RgProvider } from '../compliance/types.js';
import type { Leaderboard } from '../leaderboard.js';

export interface RestDeps {
  table: Table;
  seeds: SeedManager;
  wallet: WalletProvider;
  audit: AuditLog;
  geo: ConfigGeoProvider;
  rg: RgProvider;
  races: Leaderboard[];
  version: string;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': process.env.ACE_CORS_ORIGIN ?? '*',
  });
  res.end(payload);
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, deps: RestDeps): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': process.env.ACE_CORS_ORIGIN ?? '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    res.end();
    return true;
  }

  switch (url.pathname) {
    case '/api/health':
      json(res, 200, { ok: true, version: deps.version, at: Date.now() });
      return true;

    /**
     * The disclosures panel reads from here rather than from hardcoded copy in
     * the client, so RTP and max win on screen can never drift from the values
     * the engine actually runs.
     */
    case '/api/info':
      json(res, 200, {
        title: 'ACE',
        version: deps.version,
        rtp: THEORETICAL_RTP,
        rtpDisplay: `${(THEORETICAL_RTP * 100).toFixed(2)}%`,
        maxWin: MAX_CARRY,
        maxWinDisplay: `${MAX_CARRY.toLocaleString()}x`,
        houseEdgeModulo: HOUSE_EDGE_MODULO,
        derivation: 'floor(100 * 2^52 / (2^52 - h)) / 100, h = first 52 bits of HMAC-SHA256(serverSeed, `clientSeed:nonce`)',
        instantBust: `h % ${HOUSE_EDGE_MODULO} === 0`,
        rounding: 'Payouts truncate toward zero at the smallest unit of the currency.',
        latencyGraceMs: 200,
        currencies: Object.values(CURRENCIES),
        blockedJurisdictions: deps.geo.list(),
        evidence: '/docs/math-evidence.md',
        verifier: '/verify',
      });
      return true;

    case '/api/audit/verify': {
      // Anyone can ask whether the chain is intact. The entries themselves are
      // not public — the integrity proof is.
      const result = await deps.audit.verifyChain();
      json(res, result.ok ? 200 : 500, result);
      return true;
    }

    case '/api/leaderboard': {
      const scope = url.searchParams.get('scope') ?? 'wagered';
      const race = deps.races.find((r) => r.config.scope === scope);
      if (!race) {
        json(res, 404, { error: 'No race with that scope.' });
        return true;
      }
      json(res, 200, {
        scope,
        name: race.config.name,
        currency: race.config.currency,
        prizePool: format(race.config.prizePool, race.config.currency, { withCode: true }),
        startsAt: race.config.startsAt,
        endsAt: race.config.endsAt,
        entries: race.table(),
      });
      return true;
    }

    case '/api/history': {
      const playerId = url.searchParams.get('playerId');
      if (!playerId) {
        json(res, 400, { error: 'playerId required' });
        return true;
      }
      json(res, 200, { history: deps.table.historyFor(playerId, 60) });
      return true;
    }

    case '/api/seeds': {
      const playerId = url.searchParams.get('playerId');
      if (!playerId) {
        json(res, 400, { error: 'playerId required' });
        return true;
      }
      const seed = deps.seeds.get(playerId);
      json(res, 200, {
        // Never the live plaintext. Only the hash, and the already-rotated
        // seeds whose plaintext is safe to hand over.
        serverSeedHash: seed.serverSeedHash,
        clientSeed: seed.clientSeed,
        nonce: seed.nonce,
        revealed: deps.seeds.revealedFor(playerId),
      });
      return true;
    }

    default:
      json(res, 404, { error: 'Not found' });
      return true;
  }
}
