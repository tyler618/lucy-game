/**
 * ACE client bootstrap.
 *
 * Owns exactly one thing the rest of the app does not: the phase. Every visual
 * state hangs off `HoleMachine`, so when the UI disagrees with the round there
 * is one place to look. Everything else here is wiring — inputs to intents,
 * server events to renderer calls.
 */
import {
  HISTORY_LENGTH,
  HoleMachine,
  MAX_CARRY,
  advanceAutobet,
  displayCarryAt,
  format,
  parseAmount,
  startAutobet,
  stopAutobet,
  toExactString,
  yardsFor,
  type AutobetConfig,
  type AutobetState,
} from '@ace/core';
import { Course } from './game/course.js';
import { createTransport, type Transport } from './net/transport.js';
import type { FeedItem, HoleResultWire, SessionState } from './net/types.js';
import { Audio } from './audio.js';
import { haptic } from './haptics.js';
import { mountDrawers, type GameInfo } from './ui/drawers.js';

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------- state ---------------- */

let session: SessionState | null = null;
let info: GameInfo | null = null;
let history: HoleResultWire[] = [];
let activeBetId: string | null = null;
let teedOffAt: number | null = null;
let currency = 'USDT';
let balance = 0n;
let auto: AutobetState | null = null;
let autoConfig: AutobetConfig | null = null;
let lastStake = 0n;

const audio = new Audio();
const transport: Transport = createTransport();

const machine = new HoleMachine({
  onEnter: (phase) => {
    $('#stage').setAttribute('data-phase', phase);
    renderAction(phase);
  },
});

/* ---------------- renderer ---------------- */

const course = new Course({ canvas: $<HTMLCanvasElement>('#course'), reducedMotion });

const carryEl = $('#carry');
const yardsEl = $('#yards');
const statusEl = $('#status');

let lastCarryText = '';
course.onCarry = (carry) => {
  // Only touch the DOM when the rendered string actually changes. At 1.00x the
  // number is static for hundreds of milliseconds; writing it every frame is
  // pure layout cost for no pixels.
  const text = carry.toFixed(2);
  if (text === lastCarryText) return;
  lastCarryText = text;
  carryEl.firstChild!.nodeValue = text;
  yardsEl.textContent = `${yardsFor(carry).toLocaleString()} YARDS`;
};

/* ---------------- action button ---------------- */

const actionEl = $<HTMLButtonElement>('#action');
const actionLabel = actionEl.querySelector('.action__label') as HTMLElement;
const actionSub = $('#action-sub');

function renderAction(phase: string): void {
  actionEl.dataset.phase = phase;
  switch (phase) {
    case 'in_flight':
      actionLabel.textContent = 'Mark it';
      actionEl.disabled = false;
      break;
    case 'settled':
      actionLabel.textContent = 'Next hole';
      actionEl.disabled = true;
      break;
    default:
      actionLabel.textContent = auto?.running ? 'Stop autobet' : 'Tee it up';
      actionEl.disabled = false;
  }
}

actionEl.addEventListener('click', () => {
  if (machine.is('in_flight')) {
    if (!activeBetId) return;
    haptic('mark');
    audio.play('mark');
    transport.mark(activeBetId);
    actionEl.disabled = true;
    return;
  }
  if (auto?.running) {
    auto = stopAutobet(auto);
    $('#auto-status').textContent = 'Autobet stopped.';
    renderAction(machine.phase);
    return;
  }
  if (currentTab() === 'auto') startAutobetRun();
  else teeUp(readStake(), readLayUp());
});

/* ---------------- placing ---------------- */

function teeUp(stake: bigint, layUpAt: number | null): void {
  if (!machine.is('idle', 'betting', 'settled')) return;
  if (stake <= 0n) {
    toast('Enter a stake.');
    return;
  }
  lastStake = stake;
  statusEl.textContent = 'Teeing off…';
  transport.place(stake.toString(), currency, layUpAt);
}

function readStake(): bigint {
  const raw = $<HTMLInputElement>('#stake').value.trim();
  try {
    return parseAmount(raw || '0', currency);
  } catch {
    return 0n;
  }
}

function readLayUp(): number | null {
  const raw = $<HTMLInputElement>('#layup').value.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 1 ? Math.min(n, MAX_CARRY) : null;
}

/* ---------------- transport events ---------------- */

transport.on('session', (s) => {
  session = s;
  currency = s.currency;
  balance = BigInt(s.balance);
  history = s.history ?? [];
  renderBalance();
  renderHistory();
  renderCurrencies(s);
  machine.to('betting');
  statusEl.textContent = 'Tee it up';
});

transport.on('status', ({ online, detail }) => {
  if (!online) toast(detail === 'reconnecting' ? 'Reconnecting to the table…' : 'Offline', 'block');
});

transport.on('teeoff', ({ betId, teedOffAt: at }) => {
  activeBetId = betId;
  // Anchor to the SERVER's clock. Using the local one would drift the whole
  // flight and, worse, make the displayed carry disagree with the carry a mark
  // actually settles at.
  teedOffAt = at - transport.clockSkew;
  machine.to('in_flight');
  statusEl.textContent = 'In the air';
  $('#stage').removeAttribute('data-won');
  course.teeOff(teedOffAt);
  haptic('tee');
  audio.play('tee');
});

transport.on('rejected', ({ reason, message }) => {
  statusEl.textContent = 'Tee it up';
  machine.to('betting');
  toast(message, isBlock(reason) ? 'block' : undefined);
  if (auto?.running) {
    auto = stopAutobet(auto, 'rg_block');
    $('#auto-status').textContent = `Autobet stopped — ${message}`;
    renderAction(machine.phase);
  }
});

transport.on('settled', (e) => {
  if (e.result) {
    pushHistory(e.result);
    return;
  }
  if (e.won === null) return;

  const won = e.won;
  course.settle(e.carry, won);
  machine.to('settled');
  $('#stage').setAttribute('data-won', String(won));

  if (won) {
    const payout = e.payout ? BigInt(e.payout) : 0n;
    statusEl.textContent = `Marked at ${e.carry.toFixed(2)}x — ${format(payout, currency, { withCode: true })}`;
    if (e.balance) balance = BigInt(e.balance);
    haptic('mark');
    audio.play('mark');
  } else {
    statusEl.textContent = `In the drink at ${e.carry.toFixed(2)}x`;
    $('#splash').classList.add('is-on');
    haptic('drink');
    audio.play('drink');
  }
  renderBalance();

  // Exactly one beat, then out of the way so the next hole can start.
  window.setTimeout(() => {
    $('#splash').classList.remove('is-on');
    activeBetId = null;
    teedOffAt = null;
    course.reset();
    machine.to('betting');
    statusEl.textContent = 'Tee it up';
    advanceAuto(won, e.payout ? BigInt(e.payout) : 0n);
  }, 900);
});

transport.on('balance', ({ balance: b }) => {
  balance = BigInt(b);
  renderBalance();
});

transport.on('feed', (items) => renderFeed(items));

transport.on('seeds', (s) => {
  if (!session) return;
  session.serverSeedHash = s.serverSeedHash;
  session.clientSeed = s.clientSeed;
  session.nonce = s.nonce;
});

/* ---------------- autobet ---------------- */

function readAutoConfig(): AutobetConfig {
  const num = (sel: string, fallback = 0): number => {
    const v = Number($<HTMLInputElement>(sel).value.trim());
    return Number.isFinite(v) ? v : fallback;
  };
  const money = (sel: string): bigint | null => {
    const raw = $<HTMLInputElement>(sel).value.trim();
    if (!raw) return null;
    try {
      return parseAmount(raw, currency);
    } catch {
      return null;
    }
  };
  return {
    rounds: Math.max(0, Math.floor(num('#auto-rounds'))),
    baseStake: readStake(),
    layUpAt: num('#auto-layup', 2) > 1 ? num('#auto-layup', 2) : null,
    stopOnProfit: money('#auto-profit'),
    stopOnLoss: money('#auto-lossstop'),
    increaseOnWinPct: num('#auto-win'),
    increaseOnLossPct: num('#auto-loss'),
    resetOnWin: $<HTMLInputElement>('#auto-reset').checked,
  };
}

function startAutobetRun(): void {
  autoConfig = readAutoConfig();
  if (autoConfig.baseStake <= 0n) {
    toast('Enter a stake.');
    return;
  }
  auto = startAutobet(autoConfig);
  $('#auto-status').textContent = 'Autobet running…';
  renderAction(machine.phase);
  teeUp(auto.nextStake, autoConfig.layUpAt);
}

function advanceAuto(won: boolean, payout: bigint): void {
  if (!auto?.running || !autoConfig) return;
  auto = advanceAutobet(auto, autoConfig, { won, profit: payout - lastStake }, balance);
  const sign = auto.netProfit >= 0n ? '+' : '';
  $('#auto-status').textContent = auto.running
    ? `Hole ${auto.roundsPlayed} · ${sign}${format(auto.netProfit, currency)} · next ${format(auto.nextStake, currency)}`
    : `Autobet stopped — ${(auto.stopReason ?? '').replace(/_/g, ' ')}`;

  if (auto.running) {
    $<HTMLInputElement>('#stake').value = toExactString(auto.nextStake, currency);
    window.setTimeout(() => teeUp(auto!.nextStake, autoConfig!.layUpAt), 350);
  } else {
    renderAction(machine.phase);
  }
}

/* ---------------- rendering ---------------- */

function renderBalance(): void {
  $('#balance').textContent = format(balance, currency, { withCode: true });
}

function pushHistory(r: HoleResultWire): void {
  history.unshift(r);
  history = history.slice(0, 60);
  renderHistory();
}

function bandOf(carry: number): string {
  if (carry < 1.5) return 'low';
  if (carry < 5) return 'mid';
  if (carry < 50) return 'high';
  return 'huge';
}

function renderHistory(): void {
  const strip = $('#history-strip');
  strip.replaceChildren(
    ...history.slice(0, HISTORY_LENGTH).map((r) => {
      const chip = document.createElement('span');
      chip.className = 'strip__chip';
      chip.dataset.band = bandOf(r.carry);
      chip.setAttribute('role', 'listitem');
      chip.textContent = `${r.yards}y`;
      chip.title = `${r.carry.toFixed(2)}x · nonce ${r.nonce}`;
      return chip;
    }),
  );
}

function renderFeed(items: FeedItem[]): void {
  const feed = $('#feed');
  for (const item of items) {
    const existing = feed.querySelector<HTMLElement>(`[data-bet="${cssEscape(item.betId)}"]`);
    const node = existing ?? document.createElement('span');
    node.className = 'feed__item';
    node.dataset.bet = item.betId;
    node.dataset.state = item.cashedCarry === null ? 'live' : item.cashedCarry > 0 ? 'won' : 'lost';
    node.innerHTML = `${item.simulated ? '<span class="feed__sim">SIM</span>' : ''}<span>${escapeHtml(item.handle)}</span><span>${escapeHtml(item.stakeDisplay ?? item.stake)}</span>${
      item.cashedCarry ? `<span>${item.cashedCarry.toFixed(2)}x</span>` : ''
    }`;
    if (!existing) feed.prepend(node);
  }
  // Bounded. The feed is a glance, not a ledger, and an unbounded node list is
  // a slow leak on a page that stays open for hours.
  while (feed.children.length > 14) feed.lastElementChild?.remove();
}

function renderCurrencies(s: SessionState): void {
  const sel = $<HTMLSelectElement>('#currency');
  const codes = s.currencies?.map((c) => c.code) ?? ['USDT', 'BTC', 'ETH', 'LTC', 'SOL', 'USD', 'EUR'];
  sel.replaceChildren(
    ...codes.map((code) => {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = code;
      opt.selected = code === currency;
      return opt;
    }),
  );
  sel.onchange = () => {
    currency = sel.value;
    renderBalance();
  };
}

let toastTimer = 0;
function toast(message: string, kind?: 'block'): void {
  const t = $('#toast');
  t.textContent = message;
  if (kind) t.dataset.kind = kind;
  else delete t.dataset.kind;
  t.classList.add('is-on');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('is-on'), 3200);
}

function isBlock(reason: string): boolean {
  return ['self_excluded', 'cool_off', 'loss_limit', 'session_limit', 'jurisdiction_blocked', 'kyc_required'].includes(
    reason,
  );
}

/* ---------------- controls ---------------- */

function currentTab(): string {
  return document.querySelector('.tab.is-active')?.getAttribute('data-tab') ?? 'manual';
}

for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) {
      t.classList.toggle('is-active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    }
    for (const p of document.querySelectorAll<HTMLElement>('.panel')) {
      p.classList.toggle('is-hidden', p.dataset.panel !== tab.dataset.tab);
    }
    renderAction(machine.phase);
  });
}

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-stake]')) {
  btn.addEventListener('click', () => {
    const input = $<HTMLInputElement>('#stake');
    const current = readStake();
    const next =
      btn.dataset.stake === 'half'
        ? current / 2n
        : btn.dataset.stake === 'double'
          ? current * 2n
          : balance;
    input.value = toExactString(next > balance ? balance : next, currency);
  });
}

$<HTMLInputElement>('#layup').addEventListener('input', (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  $('#layup-yards').textContent = Number.isFinite(v) && v > 1 ? `${yardsFor(v)}y` : '—';
});

$<HTMLButtonElement>('#btn-sound').addEventListener('click', async () => {
  const on = await audio.toggle();
  $('#btn-sound').setAttribute('aria-pressed', String(on));
  $('#btn-sound').setAttribute('aria-label', on ? 'Sound on' : 'Sound off');
  toast(on ? 'Sound on' : 'Sound off');
});

/* Keyboard: space marks it. Desktop players expect this and it costs nothing. */
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || (e.target as HTMLElement).tagName === 'INPUT') return;
  e.preventDefault();
  actionEl.click();
});

/* ---------------- session clock ---------------- */

window.setInterval(() => {
  if (!session) return;
  const secs = Math.floor((Date.now() - session.sessionStartedAt) / 1000);
  $('#session-clock').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const net = BigInt(session.netPosition);
  const el = $('#session-net');
  // Display precision, not storage precision. A USDT net of zero should read
  // "0.00", not "0.00000000".
  el.textContent = `${net > 0n ? '+' : ''}${format(net, currency)}`;
  el.dataset.sign = net > 0n ? 'up' : net < 0n ? 'down' : '';
}, 1000);

/* ---------------- boot ---------------- */

mountDrawers({
  session: () => session,
  history: () => history,
  info: () => info,
  rotateSeeds: (seed) => transport.rotateSeeds(seed),
  setLimit: (kind, value) => {
    void fetch('/api/limits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, value, currency }),
    }).then(() => toast('Limit set. It applies from your next bet.'));
  },
  selfExclude: (days) => {
    void fetch('/api/exclude', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ days }),
    }).then(() => toast(`Locked for ${days} day${days === 1 ? '' : 's'}. No bet will be accepted.`, 'block'));
  },
  toast,
});

async function boot(): Promise<void> {
  await course.init();
  window.addEventListener('resize', () => course.resize(), { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(() => course.resize(), 120));

  try {
    info = (await fetch('/api/info').then((r) => r.json())) as GameInfo;
  } catch {
    /* the panel degrades to em-dashes rather than blocking play */
  }

  await transport.connect();

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

void boot();

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

/** Exposed for the reduced-motion smoke check and nothing else. */
export { displayCarryAt };
