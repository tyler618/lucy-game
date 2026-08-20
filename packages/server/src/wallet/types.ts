/**
 * Wallet abstraction.
 *
 * ACE never holds funds and never decides what a balance is. It debits and
 * credits through this interface, which an operator implements against their
 * own ledger — seamless-wallet HTTP, an internal service, whatever they run.
 * Everything below is expressed in bigint minor units; no float ever crosses
 * this boundary.
 *
 * The contract that matters for certification:
 *
 *  - `debit` and `credit` are idempotent on `idempotencyKey`. The round engine
 *    retries on transport failure and MUST NOT double-charge. Implementations
 *    that cannot guarantee this are not safe to place the title against.
 *  - A debit either fully succeeds or fully fails. No partial stakes.
 *  - `credit` is called exactly once per settled winning hole, after the
 *    outcome is written to the audit log, never before.
 */
import type { MinorUnits } from '@ace/core';

export interface WalletAccount {
  playerId: string;
  currency: string;
  balance: MinorUnits;
}

export interface DebitRequest {
  playerId: string;
  currency: string;
  amount: MinorUnits;
  /** Stable per-bet key. Retries reuse it; the operator dedupes on it. */
  idempotencyKey: string;
  /** Round reference for the operator's own reporting. */
  roundId: string;
}

export interface CreditRequest extends DebitRequest {
  /** Settled carry, for the operator's game-level reporting. */
  carry: number;
}

export type WalletResult =
  | { ok: true; balance: MinorUnits }
  | { ok: false; reason: 'insufficient_funds' | 'account_locked' | 'currency_unsupported' | 'transport'; message: string };

export interface WalletProvider {
  readonly name: string;
  getAccount(playerId: string, currency: string): Promise<WalletAccount | null>;
  debit(req: DebitRequest): Promise<WalletResult>;
  credit(req: CreditRequest): Promise<WalletResult>;
  /** Table limits, per currency. Enforced server-side before any debit. */
  limits(currency: string): Promise<{ min: MinorUnits; max: MinorUnits }>;
}
