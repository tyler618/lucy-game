/**
 * Transport.
 *
 * Two implementations behind one interface, because the title has to run in
 * two very different places:
 *
 *   SocketTransport — a live WebSocket to the stateful game server. This is
 *   the production path: an operator runs @ace/server and gets push
 *   settlement, a shared live feed and instant reconnect recovery.
 *
 *   HttpTransport — request/response against serverless functions, for the
 *   hosted demo where there is no long-lived socket to hold. The hole is still
 *   resolved entirely server-side; the client just asks instead of listening.
 *
 * What does NOT change between them: the client never learns a crash point
 * before the hole is over, and never computes one. Both transports receive the
 * outcome only at settlement.
 */
import type { FeedItem, HoleSettled, SessionState } from './types.js';

export interface TransportEvents {
  session: (s: SessionState) => void;
  teeoff: (e: { betId: string; teedOffAt: number }) => void;
  settled: (e: HoleSettled) => void;
  rejected: (e: { reason: string; message: string }) => void;
  feed: (items: FeedItem[]) => void;
  balance: (e: { currency: string; balance: string }) => void;
  seeds: (e: { serverSeedHash: string; clientSeed: string; nonce: number; previous?: unknown }) => void;
  status: (e: { online: boolean; detail?: string }) => void;
}

export interface Transport {
  connect(): Promise<void>;
  place(stake: string, currency: string, layUpAt: number | null): void;
  mark(betId: string): void;
  rotateSeeds(clientSeed: string): void;
  /** Server time minus local time, in ms. Everything time-based uses this. */
  readonly clockSkew: number;
  on<K extends keyof TransportEvents>(event: K, fn: TransportEvents[K]): void;
  close(): void;
}

export abstract class BaseTransport implements Transport {
  protected listeners: { [K in keyof TransportEvents]?: TransportEvents[K][] } = {};
  clockSkew = 0;

  on<K extends keyof TransportEvents>(event: K, fn: TransportEvents[K]): void {
    (this.listeners[event] ??= [] as never).push(fn as never);
  }

  protected emit<K extends keyof TransportEvents>(event: K, ...args: Parameters<TransportEvents[K]>): void {
    for (const fn of this.listeners[event] ?? []) (fn as (...a: unknown[]) => void)(...args);
  }

  abstract connect(): Promise<void>;
  abstract place(stake: string, currency: string, layUpAt: number | null): void;
  abstract mark(betId: string): void;
  abstract rotateSeeds(clientSeed: string): void;
  abstract close(): void;
}

/* ------------------------------------------------------------------ */

export class SocketTransport extends BaseTransport {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private closed = false;

  constructor(private readonly url: string) {
    super();
  }

  async connect(): Promise<void> {
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.emit('status', { online: true });
    };

    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.dispatch(msg);
    };

    ws.onclose = () => {
      this.emit('status', { online: false, detail: 'reconnecting' });
      if (this.closed) return;
      // Exponential backoff with jitter. A thundering herd of reconnects after
      // a deploy is how a game server falls over twice.
      const delay = Math.min(15_000, 400 * 2 ** this.reconnectAttempt++) * (0.7 + Math.random() * 0.6);
      setTimeout(() => this.open(), delay);
    };

    ws.onerror = () => ws.close();
  }

  private dispatch(msg: Record<string, unknown>): void {
    switch (msg.t) {
      case 'hello': {
        const clock = msg.clock as { serverTime: number };
        this.clockSkew = clock.serverTime - Date.now();
        const you = msg.you as SessionState;
        this.emit('session', { ...you, history: (msg.history as SessionState['history']) ?? [] });
        break;
      }
      case 'hole.teeoff': {
        const state = msg.state as { holeId: string; teedOffAt: number };
        this.emit('teeoff', { betId: state.holeId, teedOffAt: state.teedOffAt });
        break;
      }
      case 'bet.rejected':
        this.emit('rejected', { reason: String(msg.reason), message: String(msg.message) });
        break;
      case 'bet.marked':
        this.emit('settled', {
          betId: String(msg.betId),
          won: true,
          carry: Number(msg.carry),
          payout: String(msg.payout),
          balance: String(msg.balance),
        });
        break;
      case 'bet.busted':
        this.emit('settled', {
          betId: String(msg.betId),
          won: false,
          carry: Number(msg.carry),
          payout: '0',
          balance: null,
        });
        break;
      case 'hole.settled': {
        const result = msg.result as HoleSettled['result'];
        if (!result) break;
        this.emit('settled', {
          betId: result.holeId,
          won: null,
          carry: result.carry,
          payout: null,
          balance: null,
          result,
        });
        break;
      }
      case 'balance':
        this.emit('balance', { currency: String(msg.currency), balance: String(msg.balance) });
        break;
      case 'feed':
        this.emit('feed', (msg.bets as FeedItem[]) ?? []);
        break;
      case 'seeds':
        this.emit('seeds', msg as never);
        break;
      case 'error':
        this.emit('rejected', { reason: 'error', message: String(msg.message) });
        break;
      default:
        break;
    }
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  place(stake: string, currency: string, layUpAt: number | null): void {
    this.send({ t: 'bet.place', holeId: 'next', stake, currency, layUpAt });
  }
  mark(betId: string): void {
    this.send({ t: 'bet.mark', betId });
  }
  rotateSeeds(clientSeed: string): void {
    this.send({ t: 'seeds.rotate', clientSeed });
  }
  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}

/* ------------------------------------------------------------------ */

export class HttpTransport extends BaseTransport {
  private token = '';
  private feedCursor = 0;
  private feedTimer: number | null = null;
  private awaiting: AbortController | null = null;

  constructor(private readonly base = '/api') {
    super();
  }

  private async call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(this.token ? { 'x-ace-session': this.token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  async connect(): Promise<void> {
    const stored = sessionStorage.getItem('ace.session');
    const s = await this.call<SessionState & { token: string; serverTime: number }>('/session', {
      token: stored ?? null,
    });
    this.token = s.token;
    // Session token only. There is deliberately no balance, seed or outcome in
    // client storage — the anti-goal list says balance never lives here, and a
    // seed that lived here would not be a secret.
    sessionStorage.setItem('ace.session', s.token);
    this.clockSkew = s.serverTime - Date.now();
    this.emit('session', s);
    this.emit('status', { online: true });
    this.pollFeed();
  }

  private pollFeed(): void {
    const tick = async () => {
      try {
        const r = await this.call<{ items: FeedItem[]; cursor: number }>(`/feed?since=${this.feedCursor}`);
        this.feedCursor = r.cursor;
        if (r.items.length) this.emit('feed', r.items);
      } catch {
        /* a dropped feed poll is cosmetic; never surface it as an error */
      }
      this.feedTimer = window.setTimeout(tick, 1600);
    };
    void tick();
  }

  place(stake: string, currency: string, layUpAt: number | null): void {
    void (async () => {
      try {
        const r = await this.call<
          { ok: true; betId: string; teedOffAt: number; balance: string } | { ok: false; reason: string; message: string }
        >('/bet', { stake, currency, layUpAt });
        if (!r.ok) {
          this.emit('rejected', { reason: r.reason, message: r.message });
          return;
        }
        this.emit('balance', { currency, balance: r.balance });
        this.emit('teeoff', { betId: r.betId, teedOffAt: r.teedOffAt });
        this.awaitSettlement(r.betId);
      } catch (err) {
        this.emit('rejected', { reason: 'transport', message: 'Could not reach the table. Try again.' });
      }
    })();
  }

  /**
   * Long-poll for the hole's own ending.
   *
   * The server knows when the ball hits the water; the client must not. So it
   * holds this request open until the hole resolves and answers with the
   * outcome. If the player marks first, `/mark` settles and this returns the
   * same settlement, so both paths produce exactly one result.
   */
  private awaitSettlement(betId: string): void {
    this.awaiting?.abort();
    const ctrl = new AbortController();
    this.awaiting = ctrl;
    void (async () => {
      try {
        const r = await this.call<HoleSettled>(`/await`, { betId }, ctrl.signal);
        if (!ctrl.signal.aborted) this.emit('settled', r);
      } catch {
        /* aborted by a mark, or the request timed out and will be retried */
        if (!ctrl.signal.aborted) setTimeout(() => this.awaitSettlement(betId), 250);
      }
    })();
  }

  mark(betId: string): void {
    void (async () => {
      try {
        const r = await this.call<HoleSettled>('/mark', { betId });
        this.awaiting?.abort();
        this.emit('settled', r);
      } catch {
        this.emit('rejected', { reason: 'transport', message: 'Mark did not reach the table.' });
      }
    })();
  }

  rotateSeeds(clientSeed: string): void {
    void (async () => {
      const r = await this.call<{ serverSeedHash: string; clientSeed: string; nonce: number; previous?: unknown }>(
        '/seeds',
        { clientSeed },
      );
      this.emit('seeds', r);
    })();
  }

  close(): void {
    if (this.feedTimer) clearTimeout(this.feedTimer);
    this.awaiting?.abort();
  }
}

/**
 * Pick a transport.
 *
 * A configured socket URL wins, because that is a real deployment against a
 * real game server. Otherwise fall back to HTTP, which is what the hosted
 * demo runs on.
 */
export function createTransport(): Transport {
  const wsUrl = import.meta.env.VITE_ACE_WS as string | undefined;
  if (wsUrl) return new SocketTransport(wsUrl);
  if (import.meta.env.DEV) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return new SocketTransport(`${proto}://${location.host}/ws`);
  }
  return new HttpTransport();
}
