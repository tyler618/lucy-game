/**
 * Autobet. Pure state transition, no timers, no I/O.
 *
 * Autobet drives the majority of volume on crash titles and it is the single
 * easiest place to lose a player's money to a rounding bug, so it lives here as
 * a pure function over bigint minor units with tests around it, not as
 * arithmetic sprinkled through a UI component.
 */
import { applyPercent, maxOf, type MinorUnits } from './money.js';

export interface AutobetConfig {
  /** 0 means run until stopped or a stop condition fires. */
  rounds: number;
  baseStake: MinorUnits;
  /** Auto cash-out target, in carry. Null means manual mark. */
  layUpAt: number | null;
  /** Stop when cumulative profit reaches this. Null disables. */
  stopOnProfit: MinorUnits | null;
  /** Stop when cumulative loss reaches this (positive magnitude). Null disables. */
  stopOnLoss: MinorUnits | null;
  /** Percentage, e.g. 50 for +50%. 0 leaves the stake alone. */
  increaseOnWinPct: number;
  increaseOnLossPct: number;
  /** Snap back to base stake after any win. Overrides increaseOnWinPct. */
  resetOnWin: boolean;
}

export interface AutobetState {
  running: boolean;
  nextStake: MinorUnits;
  roundsPlayed: number;
  netProfit: MinorUnits;
  stopReason: AutobetStopReason | null;
}

export type AutobetStopReason =
  | 'rounds_complete'
  | 'profit_target'
  | 'loss_limit'
  | 'insufficient_funds'
  | 'user_stopped'
  | 'rg_block';

export function startAutobet(config: AutobetConfig): AutobetState {
  return { running: true, nextStake: config.baseStake, roundsPlayed: 0, netProfit: 0n, stopReason: null };
}

export interface HoleOutcome {
  won: boolean;
  /** Signed: payout - stake. */
  profit: MinorUnits;
}

/**
 * Apply one settled hole. Order matters and is deliberate:
 * stop conditions are evaluated against the profit *after* this hole, and the
 * next stake is only computed if we are still running — so a session that hits
 * its profit target never leaves a stake staged behind it.
 */
export function advanceAutobet(
  state: AutobetState,
  config: AutobetConfig,
  outcome: HoleOutcome,
  balance: MinorUnits,
): AutobetState {
  if (!state.running) return state;

  const netProfit = state.netProfit + outcome.profit;
  const roundsPlayed = state.roundsPlayed + 1;

  let stopReason: AutobetStopReason | null = null;
  if (config.stopOnProfit !== null && netProfit >= config.stopOnProfit) stopReason = 'profit_target';
  else if (config.stopOnLoss !== null && -netProfit >= config.stopOnLoss) stopReason = 'loss_limit';
  else if (config.rounds > 0 && roundsPlayed >= config.rounds) stopReason = 'rounds_complete';

  let nextStake = state.nextStake;
  if (!stopReason) {
    if (outcome.won) {
      nextStake = config.resetOnWin ? config.baseStake : applyPercent(nextStake, config.increaseOnWinPct);
    } else {
      nextStake = applyPercent(nextStake, config.increaseOnLossPct);
    }
    // A martingale that has outrun the balance stops cleanly instead of firing
    // a rejected bet at the server every 6 seconds.
    nextStake = maxOf(nextStake, 1n);
    if (nextStake > balance) stopReason = 'insufficient_funds';
  }

  return {
    running: stopReason === null,
    nextStake,
    roundsPlayed,
    netProfit,
    stopReason,
  };
}

export function stopAutobet(state: AutobetState, reason: AutobetStopReason = 'user_stopped'): AutobetState {
  return state.running ? { ...state, running: false, stopReason: reason } : state;
}
