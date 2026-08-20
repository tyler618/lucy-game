/**
 * Append-only, hash-chained audit log.
 *
 * The requirement is that any round can be reconstructed on demand, and that
 * nobody — including us — can quietly rewrite history after the fact. Each
 * entry carries the SHA-256 of the previous entry, so removing or editing any
 * record breaks every hash after it. `verifyChain()` is what an auditor runs.
 *
 * The sink is an interface because operators keep their audit trail where their
 * regulator expects it: S3 with object lock, an append-only Postgres table, a
 * WORM bucket. `MemorySink` is the reference implementation and the one the
 * demo build uses; a deployment that leaves it in place has no durable audit
 * trail, which is a certification failure and is called out at boot.
 */
import { createHash } from 'node:crypto';

export type AuditEventType =
  | 'session.open'
  | 'session.close'
  | 'seed.rotate'
  | 'bet.placed'
  | 'bet.rejected'
  | 'bet.marked'
  | 'bet.busted'
  | 'wallet.debit'
  | 'wallet.credit'
  | 'wallet.error'
  | 'rg.block'
  | 'rg.limit_set'
  | 'rg.reality_check'
  | 'geo.block'
  | 'config.change';

export interface AuditEntry {
  seq: number;
  at: number;
  type: AuditEventType;
  playerId: string | null;
  /** Everything needed to reconstruct the event without joining another table. */
  data: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export interface AuditSink {
  readonly name: string;
  readonly durable: boolean;
  append(entry: AuditEntry): Promise<void> | void;
  /** Newest first. */
  tail(limit: number): Promise<AuditEntry[]> | AuditEntry[];
  all(): Promise<AuditEntry[]> | AuditEntry[];
}

export class MemorySink implements AuditSink {
  readonly name = 'memory';
  readonly durable = false;
  private readonly entries: AuditEntry[] = [];
  constructor(private readonly cap = 50_000) {}

  append(entry: AuditEntry): void {
    this.entries.push(entry);
    // Bounded so a long-running demo cannot exhaust memory. A durable sink
    // never does this.
    if (this.entries.length > this.cap) this.entries.splice(0, this.entries.length - this.cap);
  }
  tail(limit: number): AuditEntry[] {
    return this.entries.slice(-limit).reverse();
  }
  all(): AuditEntry[] {
    return [...this.entries];
  }
}

const GENESIS = '0'.repeat(64);

export class AuditLog {
  private seq = 0;
  private lastHash = GENESIS;

  constructor(private readonly sink: AuditSink) {
    if (!sink.durable) {
      console.warn(
        `[ace] audit sink "${sink.name}" is NOT durable. This is fine for the demo build and is a ` +
          `certification failure in production — wire a durable AuditSink before going live.`,
      );
    }
  }

  private static hashOf(e: Omit<AuditEntry, 'hash'>): string {
    // Deterministic serialisation: key order is fixed by construction, and
    // `data` is stringified with sorted keys so the same event always hashes
    // the same regardless of how the object was built.
    const stable = JSON.stringify({
      seq: e.seq,
      at: e.at,
      type: e.type,
      playerId: e.playerId,
      data: sortKeys(e.data),
      previousHash: e.previousHash,
    });
    return createHash('sha256').update(stable, 'utf8').digest('hex');
  }

  async record(
    type: AuditEventType,
    playerId: string | null,
    data: Record<string, unknown>,
    at: number = Date.now(),
  ): Promise<AuditEntry> {
    const base = { seq: ++this.seq, at, type, playerId, data, previousHash: this.lastHash };
    const hash = AuditLog.hashOf(base);
    const entry: AuditEntry = { ...base, hash };
    this.lastHash = hash;
    await this.sink.append(entry);
    return entry;
  }

  async tail(limit = 100): Promise<AuditEntry[]> {
    return this.sink.tail(limit);
  }

  /** Walk the chain. Returns the first broken link, or null if intact. */
  async verifyChain(): Promise<{ ok: true; entries: number } | { ok: false; brokenAt: number; reason: string }> {
    const entries = await this.sink.all();
    let previousHash = GENESIS;
    for (const e of entries) {
      if (e.previousHash !== previousHash) {
        return { ok: false, brokenAt: e.seq, reason: 'previousHash does not match the prior entry' };
      }
      const { hash, ...rest } = e;
      if (AuditLog.hashOf(rest) !== hash) {
        return { ok: false, brokenAt: e.seq, reason: 'entry hash does not match its contents' };
      }
      previousHash = hash;
    }
    return { ok: true, entries: entries.length };
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return typeof value === 'bigint' ? value.toString() : value;
}
