# ACE — working agreement

Persisted from the master build brief. This governs every future session on this
repo. Where a later decision superseded the brief, both are recorded, with the
reason.

## Role

Lead engineer on a real-money casino title. Production TypeScript, not
prototypes. When a decision has a certification consequence, say so **before**
writing the code.

## The game

**ACE** — crash, dressed as golf, for a real-money crypto casino. Player tees
off, the ball carries, carry and multiplier climb together, water is out there
at a distance the server committed to before the swing. Mark it or lose it.

Crash is proven, high-retention and understood in one round. Golf gives it a
visual language nobody else in the category uses, and a vocabulary that writes
itself.

### Vocabulary — use these exact terms in UI and code

| Concept | Term |
|---|---|
| Place bet | Tee it up |
| Cash out | Mark it |
| Bust | In the drink |
| Multiplier | Carry (`2.41x` and `241y`) |
| Round | Hole |
| Session | Round of 18 |
| Auto cash out | Lay-up at |

`2.41x` renders as `241 yards`. **Never break that equivalence** — it is the
whole visual hook.

## Non-negotiable

1. **The client decides nothing.** Renderer and input surface only. It computes
   no outcomes, holds no balance, validates no bets. `Math.random()` anywhere in
   the client is an automatic certification failure and an automatic exploit.
2. **Provably fair, Stake-standard.** Server seed (hash published up front,
   plaintext revealed on rotation), player-editable client seed, per-hole nonce.
3. **10,000x cap**, enforced server-side inside the derivation, documented in the
   paytable, proven reachable by simulation.
4. **Math first.** Nothing else gets built until the derivation, the harness and
   the committed evidence file are signed off.

## Locked math

```
h     = first 52 bits of HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}`)
carry = 1.00                                  if h % 101 === 0
      = floor(100 * 2^52 / (2^52 - h)) / 100  otherwise
carry = min(carry, 10000)
```

`HOUSE_EDGE_MODULO = 101`, `MAX_CARRY = 10000`. Changing either invalidates
`docs/math-evidence.md` and requires a fresh 100M-hole run before merge. CI
enforces this.

## Stack

PixiJS 8 + WebGL, TypeScript strict, Vite. Howler-shaped audio API, hard mute
default, one gesture to unlock. WebSocket for round state, REST for wallet and
history; assume the socket drops constantly and a reconnect must restore an
in-flight hole without losing a bet. PWA first, Capacitor for store builds, one
codebase. One explicit state machine: `IDLE → BETTING → IN_FLIGHT → SETTLED`.

Bundle under 3MB gzipped, first interactive under 2s on throttled 4G.

## Mobile

Portrait only, one thumb. Every control in the bottom third; the flight lives up
top where a thumb never covers it. **Mark it** is the largest element on screen,
minimum 64px, and never moves position between states. 60fps locked during
flight on a Snapdragon 6-series — profile it, do not assume it; particle counts
come down before frame rate does. Three distinct haptic patterns. Respect
`prefers-reduced-motion` with a flattened path that still communicates carry.
Safe-area insets handled.

## Art direction

Dark and premium. A leather caddie yardage book and a brass yardage plate, not a
Vegas floor. Pine `#0E1210`, green `#1A211D`, card `#E9E3D3`, brass `#B08D3F`,
oxblood `#7C2D2D`, water `#26414C`. Serif with weight for display numbers,
monospace with tabular figures for all live data. The carry counter is the hero:
enormous, tabular, never reflows. One orchestrated moment per hole — the ball
and the number move, the chrome does not. The bust stings for exactly 800ms and
then gets out of the way.

## Compliance — built in from commit one, never retrofitted

Geo-fencing from server config, not client checks. RG hooks: deposit, loss and
session limits, reality check, cool-off, self-exclusion. **An exclusion refuses
the bet; it does not hide a button.** Session clock and net position within one
tap. Age gate and KYC before any real-money round. Immutable audit log carrying
everything needed to reconstruct any round. RTP and max win in the game's own
info panel. RG written as a clean abstraction so an operator wires their own
system in — that portability is what makes this sellable as B2B.

## Anti-goals

Do not: compute outcomes client-side, store balance in `localStorage`, use floats
for money, add a second game mode before the first is certified, animate anything
during the carry climb except the ball and the number, or ship without the
verifier.

---

## Decisions taken, and why

**The brief's curve was replaced.** `floor((100E − h)/(E − h))/100` cannot hit
99.00% ± 0.05% at any modulo, because its RTP is not flat — 99.00% at 1.01x
sliding to 98.02% asymptotically. Not certifiable against one published figure,
an advantage-play surface at the low end, an undisclosed extra edge at the high
end. Replaced with the inverse-CDF form above: same triplet, same commitment,
same verification story, genuinely flat. Measured side by side in the evidence
file; `legacyBustabitCarry()` kept only so the evidence can quote it.

**Per-player tables, not a shared countdown.** Makes the Stake-standard triplet
literally what governs play, removes the lobby wait so cadence is set by the
flight, and scales with no round clock to synchronise. The live feed carries
other players' holes for social proof, as Stake's own originals do.

**The cap settles as a win.** A hole reaching 10,000x is banked at 10,000x rather
than busting, so max win is payable rather than something a player must
hand-time. Cap frequency (1 in ~10,086) is pinned by the flat RTP and is not
independently tunable — you cannot have both a flat published RTP and an
astronomically rare cap.

**200ms fixed uplink grace on marking.** So a player is not charged for their own
network. Fixed rather than client-reported, because a client-supplied latency
figure is a free multiplier for anyone willing to lie. Never converts a loss into
a win.

**DOM for controls, Pixi for the flight surface.** Native inputs, accessibility,
safe-area insets, and tabular text without re-rasterising a texture every frame.

**Wallet / RG / geo shipped as interfaces plus reference implementations.**
Agreed with the owner. The demo build is playable end to end; an operator swaps
four classes and changes nothing else.

## Still outstanding

**Performance pass on real hardware.** The renderer is built to the budget, but
"profile it, do not assume it" means a real Snapdragon 6-series and this build
has not been on one. 60fps is designed-for, not measured. Do not claim otherwise.
