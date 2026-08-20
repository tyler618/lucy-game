/**
 * The one state machine. IDLE -> BETTING -> IN_FLIGHT -> SETTLED -> BETTING.
 *
 * Every transition in the client goes through here so there is exactly one
 * place to look when the UI is in a state the round is not. Illegal
 * transitions throw in development and are dropped with a warning in
 * production — a desynced client must never brick, it must resync.
 */
import type { HolePhase } from './protocol.js';

export type Phase = HolePhase;

const LEGAL: Record<Phase, readonly Phase[]> = {
  idle: ['betting', 'in_flight', 'settled'],
  betting: ['in_flight', 'idle'],
  in_flight: ['settled', 'idle'],
  settled: ['betting', 'idle'],
};

export function canTransition(from: Phase, to: Phase): boolean {
  return from === to || LEGAL[from].includes(to);
}

export interface MachineOptions {
  onEnter?: (phase: Phase, previous: Phase) => void;
  /** Reconnect hands us an arbitrary phase; allow it and resync rather than throw. */
  strict?: boolean;
}

export class HoleMachine {
  private current: Phase = 'idle';

  constructor(private readonly opts: MachineOptions = {}) {}

  get phase(): Phase {
    return this.current;
  }

  is(...phases: Phase[]): boolean {
    return phases.includes(this.current);
  }

  /** Returns true if the transition was applied. */
  to(next: Phase): boolean {
    if (next === this.current) return false;
    if (!canTransition(this.current, next)) {
      if (this.opts.strict) throw new Error(`Illegal hole transition ${this.current} -> ${next}`);
      // Resync rather than brick: the server is the authority on phase.
      console.warn(`[ace] out-of-order phase ${this.current} -> ${next}, resyncing`);
    }
    const previous = this.current;
    this.current = next;
    this.opts.onEnter?.(next, previous);
    return true;
  }
}
