/**
 * Bottom-sheet drawers: fairness, races, limits, history.
 *
 * These are the panels an operator's compliance team and a suspicious player
 * both go looking for, so they are one tap from the table rather than buried
 * behind a settings menu. Everything they show comes from the server — RTP and
 * max win are read from /api/info rather than written into the markup, so the
 * numbers on screen cannot drift from the numbers the engine runs.
 */
import { format, parseAmount, type SessionState } from './shared.js';
import type { HoleResultWire } from '../net/types.js';

export interface DrawerHost {
  session: () => SessionState | null;
  history: () => HoleResultWire[];
  info: () => GameInfo | null;
  rotateSeeds: (clientSeed: string) => void;
  setLimit: (kind: 'loss' | 'session', value: string) => void;
  selfExclude: (days: number) => void;
  toast: (msg: string, kind?: 'block') => void;
}

export interface GameInfo {
  rtpDisplay: string;
  maxWinDisplay: string;
  derivation: string;
  instantBust: string;
  rounding: string;
  latencyGraceMs: number;
  blockedJurisdictions: string[];
  evidence: string;
  verifier: string;
}

const el = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

export function mountDrawers(host: DrawerHost): void {
  const drawer = el<HTMLDivElement>('#drawer');
  const title = el<HTMLHeadingElement>('#drawer-title');
  const body = el<HTMLDivElement>('#drawer-body');

  const close = (): void => {
    drawer.hidden = true;
  };

  drawer.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).hasAttribute('data-close')) close();
  });

  const open = (kind: string): void => {
    const built = build(kind, host);
    title.textContent = built.title;
    body.innerHTML = built.html;
    drawer.hidden = false;
    built.wire?.(body);
  };

  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-drawer]')) {
    btn.addEventListener('click', () => open(btn.dataset.drawer as string));
  }
  el<HTMLButtonElement>('#btn-info').addEventListener('click', () => open('info'));
  el<HTMLButtonElement>('#btn-session').addEventListener('click', () => open('session'));
}

interface Built {
  title: string;
  html: string;
  wire?: (root: HTMLElement) => void;
}

function kv(k: string, v: string): string {
  return `<div class="kv"><div class="kv__k">${k}</div><div class="kv__v">${escapeHtml(v)}</div></div>`;
}

function build(kind: string, host: DrawerHost): Built {
  const s = host.session();
  const info = host.info();

  switch (kind) {
    case 'info':
      return {
        title: 'ACE — how the hole is decided',
        html: `
          <p>Tee it up, the ball carries, the carry multiplier climbs. Water sits somewhere out
          there at a distance the server committed to <em>before</em> your swing. Mark it before
          the ball lands and you keep the carry.</p>
          ${kv('RTP', info?.rtpDisplay ?? '—')}
          ${kv('Max carry', info?.maxWinDisplay ?? '—')}
          ${kv('Instant bust', info?.instantBust ?? '—')}
          ${kv('Rounding', info?.rounding ?? '—')}
          ${kv('Mark grace', `${info?.latencyGraceMs ?? 0}ms uplink allowance`)}
          <h3>The derivation</h3>
          <code>${escapeHtml(info?.derivation ?? '')}</code>
          <p>RTP is flat: it is the same at a 1.01x lay-up as it is holding for 10,000x. That is
          a property of the curve, not a marketing claim, and the
          <a href="${info?.evidence ?? '#'}">math evidence file</a> proves it over
          100,000,000 simulated holes.</p>
          <h3>Not available in</h3>
          <p class="mono">${(info?.blockedJurisdictions ?? []).join(' · ') || '—'}</p>
        `,
      };

    case 'fair':
      return {
        title: 'Fairness',
        html: `
          <p>Every hole is derived from three values. You hold two of them, and the hash of the
          third is published before you play — so we cannot change the outcome after your swing,
          and you can prove it.</p>
          ${kv('Server seed hash', s?.serverSeedHash ?? '—')}
          ${kv('Client seed', s?.clientSeed ?? '—')}
          ${kv('Nonce', String(s?.nonce ?? 0))}
          <h3>Change your client seed</h3>
          <p>Rotating reveals the current server seed in full so you can check every hole you
          played under it, and publishes the hash of the next one.</p>
          <div class="field__row" style="margin-top:8px">
            <input id="new-seed" class="mono" placeholder="your own seed" autocomplete="off" />
            <button class="mini" id="do-rotate" style="min-width:72px">Rotate</button>
          </div>
          <h3>Verify independently</h3>
          <p>The <a href="${info?.verifier ?? '/verify'}" target="_blank" rel="noopener">verifier</a>
          runs entirely in your browser and talks to no server. Paste a seed triplet, get the carry.</p>
        `,
        wire: (root) => {
          root.querySelector('#do-rotate')?.addEventListener('click', () => {
            const input = root.querySelector<HTMLInputElement>('#new-seed');
            host.rotateSeeds(input?.value ?? '');
            host.toast('Seeds rotated. Previous server seed revealed.');
          });
        },
      };

    case 'rg':
      return {
        title: 'Your limits',
        html: `
          <p>These are enforced by the server. A limit you set here is checked before every bet
          is accepted — not by hiding a button.</p>
          <div class="field" style="margin-top:10px">
            <label for="lim-loss">Daily loss limit</label>
            <div class="field__row">
              <input id="lim-loss" class="mono" inputmode="decimal" placeholder="none" />
              <button class="mini" id="set-loss" style="min-width:64px">Set</button>
            </div>
          </div>
          <div class="field" style="margin-top:10px">
            <label for="lim-session">Session time limit (minutes)</label>
            <div class="field__row">
              <input id="lim-session" class="mono" inputmode="numeric" placeholder="none" />
              <button class="mini" id="set-session" style="min-width:64px">Set</button>
            </div>
          </div>
          <h3>Take a break</h3>
          <button class="rgbtn" data-exclude="1">Cool off — 24 hours</button>
          <button class="rgbtn" data-exclude="30">Self-exclude — 30 days</button>
          <button class="rgbtn" data-exclude="180">Self-exclude — 6 months</button>
          <p style="margin-top:12px">Self-exclusion cannot be undone from inside the game. Once
          it is set, no bet from this account will be accepted until it expires.</p>
        `,
        wire: (root) => {
          root.querySelector('#set-loss')?.addEventListener('click', () => {
            host.setLimit('loss', root.querySelector<HTMLInputElement>('#lim-loss')?.value ?? '');
          });
          root.querySelector('#set-session')?.addEventListener('click', () => {
            host.setLimit('session', root.querySelector<HTMLInputElement>('#lim-session')?.value ?? '');
          });
          for (const b of root.querySelectorAll<HTMLButtonElement>('[data-exclude]')) {
            b.addEventListener('click', () => host.selfExclude(Number(b.dataset.exclude)));
          }
        },
      };

    case 'history': {
      const rows = host.history();
      return {
        title: 'My holes',
        html: rows.length
          ? rows
              .map(
                (r) => `
              <div class="row">
                <span class="row__rank">#${r.nonce}</span>
                <span class="mono">${r.carry.toFixed(2)}x</span>
                <span class="mono" style="color:var(--brass)">${r.yards}y</span>
                <a class="mono" href="/verify?serverSeedHash=${encodeURIComponent(r.serverSeedHash)}&clientSeed=${encodeURIComponent(r.clientSeed)}&nonce=${r.nonce}" target="_blank" rel="noopener">verify</a>
              </div>`,
              )
              .join('')
          : '<p>No holes yet. Tee it up.</p>',
      };
    }

    case 'race':
      return {
        title: 'Races',
        html: `<div id="race-body"><p>Loading standings…</p></div>`,
        wire: (root) => {
          void (async () => {
            const target = root.querySelector('#race-body');
            if (!target) return;
            try {
              const [vol, carry] = await Promise.all([
                fetch('/api/leaderboard?scope=wagered').then((r) => r.json()),
                fetch('/api/leaderboard?scope=highest_carry').then((r) => r.json()),
              ]);
              target.innerHTML = [vol, carry]
                .filter((r) => r && !r.error)
                .map(
                  (r) => `
                    <h3>${escapeHtml(r.name)}</h3>
                    <p class="mono" style="font-size:11px">Pool ${escapeHtml(r.prizePool)} · ends ${new Date(r.endsAt).toLocaleDateString()}</p>
                    ${
                      r.entries.length
                        ? r.entries
                            .map(
                              (e: { rank: number; handle: string; value: string; prize: string | null }) => `
                        <div class="row">
                          <span class="row__rank">${e.rank}</span>
                          <span>${escapeHtml(e.handle)}</span>
                          <span class="mono">${escapeHtml(e.value)}</span>
                          <span class="mono" style="color:var(--brass)">${escapeHtml(e.prize ?? '')}</span>
                        </div>`,
                            )
                            .join('')
                        : '<p>No entries yet — first hole on the board takes it.</p>'
                    }`,
                )
                .join('');
            } catch {
              target.innerHTML = '<p>Standings are unavailable right now.</p>';
            }
          })();
        },
      };

    case 'session': {
      const started = s?.sessionStartedAt ?? Date.now();
      const mins = Math.floor((Date.now() - started) / 60000);
      const net = s ? BigInt(s.netPosition) : 0n;
      return {
        title: 'This session',
        html: `
          ${kv('Open for', `${mins} minute${mins === 1 ? '' : 's'}`)}
          ${kv('Net position', s ? format(net, s.currency, { withCode: true }) : '—')}
          ${kv('Holes played', String(host.history().length))}
          ${kv('Jurisdiction', s?.jurisdiction ?? '—')}
          ${kv('Age verified', s?.ageVerified ? 'yes' : 'no')}
          ${kv('KYC', s?.kycVerified ? 'verified' : 'required')}
          <p style="margin-top:14px">Net position counts every hole this session, wins and
          losses both. It is here, one tap from the table, because a number you have to hunt for
          is a number you are not being shown.</p>
        `,
      };
    }

    default:
      return { title: '', html: '' };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export { parseAmount };
