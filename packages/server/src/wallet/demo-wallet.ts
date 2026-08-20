/**
 * In-memory demo wallet.
 *
 * Exists so the title is playable end to end without an operator behind it.
 * It is a reference implementation of the contract, not a ledger: balances
 * live in process memory and vanish on restart, which is stated plainly in the
 * demo build's UI. Every real deployment swaps this for the operator's adapter.
 *
 * It does implement idempotency properly, because that is the part integrators
 * most often get wrong and this is the file they will read first.
 */
import { parseAmount, type MinorUnits } from '@ace/core';
import type { CreditRequest, DebitRequest, WalletAccount, WalletProvider, WalletResult } from './types.js';

const STARTING_BALANCE: Record<string, string> = {
  BTC: '0.05000000',
  ETH: '1.50000000',
  LTC: '25.00000000',
  SOL: '40.00000000',
  USDT: '5000.00000000',
  USD: '5000.00',
  EUR: '5000.00',
};

const TABLE_LIMITS: Record<string, { min: string; max: string }> = {
  BTC: { min: '0.00000100', max: '0.01000000' },
  ETH: { min: '0.00010000', max: '0.50000000' },
  LTC: { min: '0.00100000', max: '10.00000000' },
  SOL: { min: '0.00100000', max: '20.00000000' },
  USDT: { min: '0.10000000', max: '1000.00000000' },
  USD: { min: '0.10', max: '1000.00' },
  EUR: { min: '0.10', max: '1000.00' },
};

export class DemoWallet implements WalletProvider {
  readonly name = 'demo-in-memory';
  private readonly accounts = new Map<string, MinorUnits>();
  private readonly applied = new Map<string, MinorUnits>();

  private key(playerId: string, currency: string): string {
    return `${playerId}:${currency}`;
  }

  private ensure(playerId: string, currency: string): MinorUnits {
    const k = this.key(playerId, currency);
    let bal = this.accounts.get(k);
    if (bal === undefined) {
      const seed = STARTING_BALANCE[currency];
      if (seed === undefined) return 0n;
      bal = parseAmount(seed, currency);
      this.accounts.set(k, bal);
    }
    return bal;
  }

  async getAccount(playerId: string, currency: string): Promise<WalletAccount | null> {
    if (!STARTING_BALANCE[currency]) return null;
    return { playerId, currency, balance: this.ensure(playerId, currency) };
  }

  async limits(currency: string): Promise<{ min: MinorUnits; max: MinorUnits }> {
    const spec = TABLE_LIMITS[currency];
    if (!spec) throw new Error(`No table limits configured for ${currency}`);
    return { min: parseAmount(spec.min, currency), max: parseAmount(spec.max, currency) };
  }

  async debit(req: DebitRequest): Promise<WalletResult> {
    const seen = this.applied.get(`debit:${req.idempotencyKey}`);
    if (seen !== undefined) return { ok: true, balance: seen };

    if (!STARTING_BALANCE[req.currency]) {
      return { ok: false, reason: 'currency_unsupported', message: `${req.currency} is not enabled on this table` };
    }
    const bal = this.ensure(req.playerId, req.currency);
    if (bal < req.amount) {
      return { ok: false, reason: 'insufficient_funds', message: 'Not enough in the bag for that stake' };
    }
    const next = bal - req.amount;
    this.accounts.set(this.key(req.playerId, req.currency), next);
    this.applied.set(`debit:${req.idempotencyKey}`, next);
    return { ok: true, balance: next };
  }

  async credit(req: CreditRequest): Promise<WalletResult> {
    const seen = this.applied.get(`credit:${req.idempotencyKey}`);
    if (seen !== undefined) return { ok: true, balance: seen };

    const next = this.ensure(req.playerId, req.currency) + req.amount;
    this.accounts.set(this.key(req.playerId, req.currency), next);
    this.applied.set(`credit:${req.idempotencyKey}`, next);
    return { ok: true, balance: next };
  }
}
