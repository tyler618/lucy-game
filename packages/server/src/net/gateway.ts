/**
 * WebSocket gateway.
 *
 * Assume the socket drops constantly. Every message is idempotent or
 * addressed by a server-issued id, the client is never the source of truth for
 * anything, and a reconnect replays enough state to resume a hole that is
 * still in the air — including its remaining flight time, so the ball picks up
 * where it should rather than restarting.
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  MAX_CARRY,
  format,
  type ClientMessage,
  type ServerMessage,
  type SessionSnapshot,
} from '@ace/core';
import type { Table } from '../engine/table.js';
import type { SeedManager } from '../engine/seed-manager.js';
import type { LiveFeed } from '../engine/feed.js';
import { avatarFor, handleFor } from '../engine/feed.js';
import type { WalletProvider } from '../wallet/types.js';
import type { GeoProvider, RgProvider } from '../compliance/types.js';
import type { AuditLog } from '../audit/audit-log.js';
import type { Leaderboard } from '../leaderboard.js';
import { sanitiseClientSeed } from '../engine/seed-manager.js';

export interface GatewayDeps {
  table: Table;
  seeds: SeedManager;
  feed: LiveFeed;
  wallet: WalletProvider;
  rg: RgProvider;
  geo: GeoProvider;
  audit: AuditLog;
  races: Leaderboard[];
}

interface Session {
  playerId: string;
  currency: string;
  jurisdiction: string;
  ws: WebSocket;
  seq: number;
  alive: boolean;
  unsubscribeFeed: () => void;
}

const DEFAULT_CURRENCY = 'USDT';

export class Gateway {
  private readonly sessions = new Map<WebSocket, Session>();
  private readonly wss: WebSocketServer;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly deps: GatewayDeps) {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws, req) => void this.onConnection(ws, req));

    // A half-open socket looks alive to the OS and dead to everyone else.
    // Ping every 20s and reap anything that misses a beat, so an in-flight
    // hole's owner is known accurately.
    this.heartbeat = setInterval(() => {
      for (const [ws, session] of this.sessions) {
        if (!session.alive) {
          ws.terminate();
          continue;
        }
        session.alive = false;
        try {
          ws.ping();
        } catch {
          ws.terminate();
        }
      }
    }, 20_000);
  }

  handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  private async snapshot(session: Session): Promise<SessionSnapshot> {
    const account = await this.deps.wallet.getAccount(session.playerId, session.currency);
    const seed = this.deps.seeds.get(session.playerId);
    const status = await this.deps.rg.getStatus(session.playerId);
    const counters = this.deps.table.countersFor(session.playerId);
    return {
      handle: handleFor(session.playerId),
      currency: session.currency,
      balance: (account?.balance ?? 0n).toString(),
      serverSeedHash: seed.serverSeedHash,
      clientSeed: seed.clientSeed,
      nonce: seed.nonce,
      sessionStartedAt: counters.startedAt,
      netPosition: counters.net.toString(),
      kycVerified: status.kycVerified,
      ageVerified: status.ageVerified,
      jurisdiction: status.jurisdiction,
    };
  }

  private async onConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const ip = (req.socket.remoteAddress ?? '').toString();
    const headers = req.headers as Record<string, string | undefined>;
    const jurisdiction = await this.deps.geo.resolve(ip, headers);

    // Demo identity. A real deployment validates the operator's session token
    // here and takes the player id from it — never from anything the client
    // asserts about itself.
    const playerId = `p_${randomBytes(9).toString('hex')}`;

    const session: Session = {
      playerId,
      currency: DEFAULT_CURRENCY,
      jurisdiction,
      ws,
      seq: 0,
      alive: true,
      unsubscribeFeed: () => {},
    };
    this.sessions.set(ws, session);

    ws.on('pong', () => {
      session.alive = true;
    });

    await this.deps.audit.record('session.open', playerId, { jurisdiction, ip: redactIp(ip) });

    if (await this.deps.geo.isBlocked(jurisdiction)) {
      await this.deps.audit.record('geo.block', playerId, { jurisdiction, stage: 'session' });
      this.send(ws, {
        t: 'error',
        message: `ACE is not available in ${jurisdiction}.`,
      });
      ws.close(4003, 'jurisdiction_blocked');
      return;
    }

    session.unsubscribeFeed = this.deps.feed.subscribe((entry) => {
      this.send(ws, {
        t: 'feed',
        bets: [
          {
            betId: entry.betId,
            handle: entry.handle,
            currency: entry.currency,
            stake: entry.stake,
            markedAt: entry.carry === null ? null : entry.at,
            cashedCarry: entry.carry,
            payout: entry.payout,
          },
        ],
      });
    });

    const seed = this.deps.seeds.get(playerId);
    this.send(ws, {
      t: 'hello',
      clock: { serverTime: Date.now(), seq: ++session.seq },
      state: {
        holeId: 'idle',
        phase: 'betting',
        bettingClosesAt: 0,
        teedOffAt: null,
        settledCarry: null,
        serverSeedHash: seed.serverSeedHash,
        nonce: seed.nonce,
      },
      history: this.deps.table.historyFor(playerId),
      you: await this.snapshot(session),
    });

    ws.on('message', (raw) => void this.onMessage(session, raw.toString()));
    ws.on('close', () => {
      session.unsubscribeFeed();
      this.sessions.delete(ws);
      this.deps.table.detach(playerId);
      void this.deps.audit.record('session.close', playerId, {});
    });
  }

  private async onMessage(session: Session, raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(session.ws, { t: 'error', message: 'Malformed message.' });
      return;
    }

    switch (msg.t) {
      case 'bet.place':
        return this.onPlace(session, msg);
      case 'bet.mark':
        return this.onMark(session, msg.betId);
      case 'seeds.rotate':
        return this.onRotate(session, msg.clientSeed);
      case 'leaderboard.subscribe':
        return this.onLeaderboard(session, msg.scope);
      case 'pong':
        session.alive = true;
        return;
      default:
        this.send(session.ws, { t: 'error', message: 'Unsupported message.' });
    }
  }

  private async onPlace(session: Session, msg: Extract<ClientMessage, { t: 'bet.place' }>): Promise<void> {
    let stake: bigint;
    try {
      // Minor units arrive as a decimal string. Anything that is not a plain
      // non-negative integer is rejected outright rather than coerced.
      if (!/^\d{1,30}$/.test(msg.stake)) throw new Error('bad stake');
      stake = BigInt(msg.stake);
    } catch {
      this.send(session.ws, { t: 'bet.rejected', reason: 'stake_below_min', message: 'Invalid stake.' });
      return;
    }
    if (stake <= 0n) {
      this.send(session.ws, { t: 'bet.rejected', reason: 'stake_below_min', message: 'Stake must be above zero.' });
      return;
    }

    session.currency = typeof msg.currency === 'string' ? msg.currency : session.currency;

    const placed = await this.deps.table.place(
      session.playerId,
      session.currency,
      stake,
      msg.layUpAt ?? null,
      session.jurisdiction,
    );

    if (!placed.ok) {
      this.send(session.ws, { t: 'bet.rejected', reason: placed.reason, message: placed.message });
      return;
    }

    const account = await this.deps.wallet.getAccount(session.playerId, session.currency);
    this.send(session.ws, {
      t: 'bet.accepted',
      betId: placed.bet.betId,
      holeId: placed.bet.betId,
      stake: stake.toString(),
      currency: session.currency,
      balance: (account?.balance ?? 0n).toString(),
    });
    this.send(session.ws, {
      t: 'hole.teeoff',
      state: {
        holeId: placed.bet.betId,
        phase: 'in_flight',
        bettingClosesAt: placed.bet.teedOffAt,
        teedOffAt: placed.bet.teedOffAt,
        settledCarry: null,
        serverSeedHash: placed.bet.serverSeedHash,
        nonce: placed.bet.nonce,
      },
    });

    this.deps.feed.push({
      betId: placed.bet.betId,
      handle: handleFor(session.playerId),
      avatar: avatarFor(session.playerId),
      currency: session.currency,
      stake: stake.toString(),
      stakeDisplay: format(stake, session.currency, { withCode: true }),
      carry: null,
      payout: null,
      simulated: false,
      at: Date.now(),
    });
  }

  private async onMark(session: Session, betId: string): Promise<void> {
    const result = await this.deps.table.mark(session.playerId, betId);
    if ('error' in result) {
      this.send(session.ws, { t: 'error', message: result.error });
    }
    // The settlement broadcast is driven by Table.onSettled so that a hole
    // settled by its own timer and one settled by a tap take exactly the same
    // path out to the client.
  }

  private async onRotate(session: Session, clientSeed: string): Promise<void> {
    if (this.deps.table.activeBetFor(session.playerId)) {
      this.send(session.ws, { t: 'error', message: 'Finish the hole before rotating seeds.' });
      return;
    }
    const { revealed, next } = this.deps.seeds.rotate(session.playerId, sanitiseClientSeed(clientSeed) ?? undefined);
    await this.deps.audit.record('seed.rotate', session.playerId, {
      revealedHash: revealed.serverSeedHash,
      revealedSeed: revealed.serverSeed,
      finalNonce: revealed.finalNonce,
      nextHash: next.serverSeedHash,
      nextClientSeed: next.clientSeed,
    });
    this.send(session.ws, {
      t: 'seeds',
      serverSeedHash: next.serverSeedHash,
      clientSeed: next.clientSeed,
      nonce: next.nonce,
      previous: revealed,
    });
  }

  private onLeaderboard(session: Session, scope: 'wagered' | 'highest_carry'): void {
    const race = this.deps.races.find((r) => r.config.scope === scope);
    if (!race) return;
    this.send(session.ws, {
      t: 'leaderboard',
      scope,
      entries: race.table(),
      endsAt: race.config.endsAt,
    });
  }

  /** Called by the table for every settlement, however it was triggered. */
  broadcastSettlement(playerId: string, payload: ServerMessage[]): void {
    for (const [ws, session] of this.sessions) {
      if (session.playerId !== playerId) continue;
      for (const msg of payload) this.send(ws, msg);
    }
  }

  get maxCarry(): number {
    return MAX_CARRY;
  }

  shutdown(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const ws of this.sessions.keys()) ws.close(1001, 'server_shutdown');
    this.wss.close();
  }
}

/** Audit needs to place a session, not identify a person. Keep the /24 only. */
function redactIp(ip: string): string {
  const v4 = ip.replace(/^::ffff:/, '');
  const parts = v4.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  return 'ipv6';
}
