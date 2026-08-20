# ACE

A golf-themed provably fair crash original, built to sit next to a Stake Original
without apologising for itself.

Tee it up. The ball carries. Carry and the multiplier climb together — `2.41x` is
`241 yards`, the same number in two costumes. Water sits out there at a distance
the server committed to before your swing. **Mark it** before the ball lands and
you keep the carry. Wait too long and it is in the drink.

```
99.0099% RTP · flat at every cash-out target · 10,000x max carry · 1 in 101 instant bust
```

**Play it:** https://ace-golf-crash-git-claude-ace-maste-bb3a9e-tyler-7404s-projects.vercel.app
· **Verify it:** [`/verify`](https://ace-golf-crash-git-claude-ace-maste-bb3a9e-tyler-7404s-projects.vercel.app/verify)

- **Table** — `/`
- **Verifier** — `/verify` (pure client-side, works offline)
- **Math evidence** — [`docs/math-evidence.md`](docs/math-evidence.md) — 100,000,000 simulated holes
- **Paytable** — [`docs/paytable.md`](docs/paytable.md)
- **Operator integration** — [`docs/integration.md`](docs/integration.md)

---

## The one thing to read before anything else

The brief specified the widely copied bustabit curve,
`floor((100E − h)/(E − h))/100`, and asked for the modulo to be tuned until RTP
sat at 99.00% ± 0.05%. **No modulo does that**, because that curve's RTP is not
flat — it slides from 99.00% at a 1.01x lay-up down to 98.02% asymptotically:

| Lay-up | Bustabit curve | ACE curve |
|---|---|---|
| 1.01x | 99.00% | 99.01% |
| 2.00x | 98.51% | 99.01% |
| 10.00x | 98.12% | 99.01% |
| 1,000x | 98.02% | 99.01% |

That is disqualifying three times over: it cannot be certified against a single
published RTP, the low band becomes an advantage-play surface, and players
holding for big carries are quietly charged an extra percentage point they were
never told about.

ACE ships the inverse-CDF form, `floor(100 · 2^52 / (2^52 − h)) / 100`, which
gives `P(carry ≥ m) = 1/m` exactly and therefore a genuinely flat
`RTP = 1 − 1/101 = 99.0099%` at every target. Identical seed triplet, identical
published hash, identical verification story — and it is actually flat. The
comparison is measured on the same hash stream and published in the evidence
file; `legacyBustabitCarry()` is retained solely so the evidence can quote it.

---

## Architecture

```
packages/core     Isomorphic. Derivation, flight curve, money, autobet, protocol,
                  state machine, and a dependency-free SHA-256 so the verifier
                  runs in a bare browser. One implementation, shared by the
                  server, the client, the verifier and the simulation harness.

packages/server   Stateful game server. Round engine, seed lifecycle, WebSocket
                  gateway, REST, hash-chained audit log, and the reference
                  wallet / RG / geo adapters.

apps/web          PixiJS 8 client, portrait, plus the standalone verifier.

api/              Serverless entrypoint for the hosted demo. Same engine,
                  long-poll instead of a socket.

assets/           Provenance manifest for every generated art asset: model,
                  prompt, job id.
```

### Non-negotiables, and where they are enforced

| Rule | Where |
|---|---|
| The client decides nothing | Outcome derived in `Table.place()`, never serialised before settlement |
| No `Math.random()` in the client | `packages/core` derivation only; the client's only randomness is a default client seed |
| Provably fair, Stake-standard | `provably-fair.ts`, `seed-manager.ts`, `/verify` |
| 10,000x cap | Inside `carryFromHash()`, so a verifier reproduces the clamp |
| Money is never a float | `money.ts` — bigint minor units, everywhere |
| Exclusion refuses the bet | `Table.place()` calls `RgProvider.checkBet()` before any debit |
| Every round reconstructible | `AuditLog`, hash-chained, `/api/audit/verify` |

### Why per-player tables

ACE derives each hole from that player's own seed triplet rather than from a
shared countdown chain. It is what makes the Stake-standard triplet in the brief
literally the thing that governs play, it removes the lobby wait so cadence is
set by the flight rather than the slowest player, and it scales horizontally
with no round clock to synchronise. The live feed carries other players' holes
for social proof, exactly as Stake's own originals do.

---

## Quickstart

```bash
npm install
npm test                 # 16 tests: hash vectors, derivation, money, autobet
npm run sim:quick        # 1,000,000-hole math tripwire
npm run sim              # the full 100,000,000-hole evidence run (~2 min on 4 cores)

npm run dev:server       # game server on :8787
npm run dev              # client on :5173, proxied to the server
```

Assets are fetched from the provenance manifest rather than committed blind:

```bash
node scripts/fetch-assets.mjs        # materialise into apps/web/public/assets
```

## Deploying

The repository is linked to the Vercel project **`ace-golf-crash`**
(team `tyler-7404s-projects`). Every push builds: the production branch
publishes to the production URL, and any other branch gets its own preview URL.
No secrets are needed for that path — the git integration owns it.

Vercel's production branch is `main`, and this build lives on
`claude/ace-master-build-fwo2m8`, so the live URL above is the branch alias —
stable, and it tracks the tip of the branch. Merging the branch into `main`
makes `ace-golf-crash.vercel.app` serve it instead.

The **Deploy to Vercel** workflow is the alternative, for deploying from CI
rather than from the git integration. It needs three repository secrets
(*Settings → Secrets and variables → Actions*):

| Secret | Where to get it |
|---|---|
| `VERCEL_TOKEN` | vercel.com/account/tokens |
| `VERCEL_ORG_ID` | `.vercel/project.json` after `vercel link`, or the team settings page |
| `VERCEL_PROJECT_ID` | same file, or the project settings page |

Until they are set the deploy job skips with a notice instead of failing, so the
rest of CI stays meaningful. The deployed URL is printed in the workflow summary.

**The hosted build is a demo.** It runs the real engine, the real derivation and
the real compliance checks, with the in-memory reference wallet and a per-instance
session. A cold start rotates your seed and resets the demo balance — a
legitimate rotation, not a hole in the guarantee, but not a production posture
either. Production runs `packages/server` with the operator's own adapters.

## What is here, against the brief

| # | Deliverable | Status |
|---|---|---|
| 1 | Math first — derivation, harness, committed evidence | ✅ 100M holes, χ² p = 0.32, PASS |
| 2 | Server — engine, seeds, protocol, wallet, audit | ✅ |
| 3 | Verifier page, standalone and public | ✅ 2.7 KB of JS, no network |
| 4 | Client — state machine, flight, bet controls, cash out | ✅ |
| 5 | Autobet, history strip, live feed | ✅ |
| 6 | RG and compliance layer | ✅ interfaces + reference impls |
| 7 | Leaderboards and races | ✅ two scopes, configurable pools |
| 8 | Performance pass on real hardware | ⚠️ **not done** — see below |

**Item 8 is genuinely outstanding.** The renderer is built to the budget — static
layers drawn once, DPR capped at 2, bounded trail, one DOM write per changed
frame, and every figure it draws is a shape rather than a texture — but "profile
it, do not assume it" means a real Snapdragon 6-series, and this build has not
been on one. Treat 60fps as designed-for, not measured. The same applies to the
haptics: three distinct patterns are implemented and are silently absent on iOS
Safari, which does not expose the Vibration API.

## Bundle

| Chunk | Gzipped |
|---|---|
| Pixi renderer | 136 KB |
| Game | 10 KB |
| Verifier (loads no Pixi) | 2.7 KB |

Well inside the 3 MB budget; CI fails the build if that ever stops being true.
