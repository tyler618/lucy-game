/**
 * ACE game server.
 *
 * Boots the reference stack: demo wallet, demo RG, config geo, in-memory
 * audit. Each of those is an interface an operator swaps out; the engine, the
 * gateway and the derivation are the parts that stay.
 */
import { createServer } from 'node:http';
import { parseAmount, format } from '@ace/core';
import { installNativeCrypto } from './crypto-backend.js';
import { AuditLog, MemorySink } from './audit/audit-log.js';
import { DemoWallet } from './wallet/demo-wallet.js';
import { DemoRgProvider } from './compliance/demo-rg.js';
import { ConfigGeoProvider } from './compliance/geo.js';
import { SeedManager } from './engine/seed-manager.js';
import { LiveFeed, handleFor } from './engine/feed.js';
import { Table, type Settlement } from './engine/table.js';
import { Leaderboard } from './leaderboard.js';
import { Gateway } from './net/gateway.js';
import { handleRest } from './net/rest.js';

installNativeCrypto();

const VERSION = '1.0.0';
const PORT = Number(process.env.PORT ?? 8787);

const audit = new AuditLog(new MemorySink());
const wallet = new DemoWallet();
const rg = new DemoRgProvider();
const geo = new ConfigGeoProvider();
const seeds = new SeedManager();
const feed = new LiveFeed();

const DAY = 24 * 60 * 60 * 1000;
const races = [
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

let gateway: Gateway;

const table = new Table({
  wallet,
  rg,
  geo,
  seeds,
  audit,
  onSettled: (s: Settlement) => {
    for (const race of races) race.record(s.playerId, s.stake, s.currency, s.carry, s.won);

    feed.update(s.betId, s.won ? s.carry : 0, s.won ? format(s.payout, s.currency, { withCode: true }) : '0');

    gateway.broadcastSettlement(s.playerId, [
      s.won
        ? { t: 'bet.marked', betId: s.betId, carry: s.carry, payout: s.payout.toString(), balance: s.balance.toString() }
        : { t: 'bet.busted', betId: s.betId, carry: s.carry },
      {
        t: 'hole.settled',
        state: {
          holeId: s.betId,
          phase: 'settled',
          bettingClosesAt: 0,
          teedOffAt: null,
          settledCarry: s.result.carry,
          serverSeedHash: s.result.serverSeedHash,
          nonce: s.result.nonce,
        },
        result: s.result,
      },
      { t: 'balance', currency: s.currency, balance: s.balance.toString() },
    ]);
  },
});

gateway = new Gateway({ table, seeds, feed, wallet, rg, geo, audit, races });

const server = createServer((req, res) => {
  void handleRest(req, res, { table, seeds, wallet, audit, geo, rg, races, version: VERSION }).then((handled) => {
    if (handled) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
});

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws') {
    socket.destroy();
    return;
  }
  gateway.handleUpgrade(req, socket, head);
});

feed.startSimulated();

server.listen(PORT, () => {
  console.log(`ACE server v${VERSION} on :${PORT}`);
  console.log(`  ws       ws://localhost:${PORT}/ws`);
  console.log(`  rest     http://localhost:${PORT}/api/info`);
  console.log(`  wallet   ${wallet.name}`);
  console.log(`  rg       ${rg.name}`);
  console.log(`  geo      ${geo.name} (${geo.list().length} jurisdictions blocked)`);
  console.log(`  house    ${handleFor('house')}`);
});

function shutdown(): void {
  console.log('\nshutting down');
  feed.stop();
  gateway.shutdown();
  table.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
