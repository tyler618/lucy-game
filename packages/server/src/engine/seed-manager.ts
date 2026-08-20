/**
 * Seed lifecycle.
 *
 * Stake-standard triplet. The invariant the whole trust story rests on:
 * a server seed's plaintext is revealed ONLY after it can no longer be used.
 * Rotation is therefore atomic — the outgoing seed is revealed and the
 * incoming seed's hash is published in the same step, and no hole is ever
 * derived from a seed whose plaintext the player already holds.
 */
import { randomBytes } from 'node:crypto';
import { hashServerSeed, type RevealedSeed } from '@ace/core';

export interface SeedState {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  createdAt: number;
}

function newServerSeed(): string {
  return randomBytes(32).toString('hex');
}

function defaultClientSeed(): string {
  return randomBytes(8).toString('hex');
}

export class SeedManager {
  private readonly current = new Map<string, SeedState>();
  private readonly revealed = new Map<string, RevealedSeed[]>();

  get(playerId: string): SeedState {
    let s = this.current.get(playerId);
    if (!s) {
      const serverSeed = newServerSeed();
      s = {
        serverSeed,
        serverSeedHash: hashServerSeed(serverSeed),
        clientSeed: defaultClientSeed(),
        nonce: 0,
        createdAt: Date.now(),
      };
      this.current.set(playerId, s);
    }
    return s;
  }

  /** Consumes the next nonce. Called exactly once per accepted bet. */
  nextNonce(playerId: string): number {
    const s = this.get(playerId);
    s.nonce += 1;
    return s.nonce;
  }

  /**
   * Rotate. Reveals the outgoing plaintext, installs a fresh seed, resets the
   * nonce, and optionally adopts a player-chosen client seed.
   */
  rotate(playerId: string, nextClientSeed?: string): { revealed: RevealedSeed; next: SeedState } {
    const previous = this.get(playerId);
    const revealed: RevealedSeed = {
      serverSeed: previous.serverSeed,
      serverSeedHash: previous.serverSeedHash,
      clientSeed: previous.clientSeed,
      finalNonce: previous.nonce,
    };

    const serverSeed = newServerSeed();
    const next: SeedState = {
      serverSeed,
      serverSeedHash: hashServerSeed(serverSeed),
      clientSeed: sanitiseClientSeed(nextClientSeed) ?? defaultClientSeed(),
      nonce: 0,
      createdAt: Date.now(),
    };
    this.current.set(playerId, next);

    const history = this.revealed.get(playerId) ?? [];
    history.unshift(revealed);
    // Keep the last 20 rotations addressable for verification; older ones live
    // in the audit log, which is the durable record.
    this.revealed.set(playerId, history.slice(0, 20));

    return { revealed, next };
  }

  revealedFor(playerId: string): RevealedSeed[] {
    return this.revealed.get(playerId) ?? [];
  }

  forget(playerId: string): void {
    this.current.delete(playerId);
    this.revealed.delete(playerId);
  }
}

/**
 * A client seed is player-controlled text that ends up inside an HMAC message
 * and in JSON sent to other clients. Bound the length and strip control
 * characters; everything else is the player's business.
 */
export function sanitiseClientSeed(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, 64);
}
