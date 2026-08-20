# Operator integration

ACE is built to be placed, not to be a one-casino toy. Everything an operator
already owns — the ledger, responsible gambling, geo, KYC — stays theirs. The
game defers to it through four interfaces and keeps no shadow copy of any of it.

Implementing these four is the whole integration.

## 1. Wallet — `packages/server/src/wallet/types.ts`

```ts
interface WalletProvider {
  getAccount(playerId, currency): Promise<WalletAccount | null>;
  debit(req: DebitRequest): Promise<WalletResult>;
  credit(req: CreditRequest): Promise<WalletResult>;
  limits(currency): Promise<{ min: MinorUnits; max: MinorUnits }>;
}
```

Contract, in the order it matters:

1. **`debit` and `credit` must be idempotent on `idempotencyKey`.** The engine
   retries on transport failure and must not double-charge. An implementation
   that cannot guarantee this is not safe to place the title against.
2. A debit fully succeeds or fully fails. No partial stakes.
3. `credit` is called exactly once per settled winning hole, **after** the
   outcome is written to the audit log.
4. Everything is `bigint` minor units. No float crosses this boundary in either
   direction.

Keys are `stake:<betId>` and `payout:<betId>`, both stable across retries.

`DemoWallet` is the reference implementation and does implement idempotency
properly, because that is the part integrators most often get wrong and it is
the file they will read first.

## 2. Responsible gambling — `compliance/types.ts`

```ts
interface RgProvider {
  getStatus(playerId): Promise<PlayerStatus>;
  getLimits(playerId, currency): Promise<RgLimits>;
  setLimits(playerId, currency, limits): Promise<RgLimits>;
  checkBet(playerId, currency, stake, counters): Promise<RgDecision>;
  selfExclude(playerId, untilMs): Promise<void>;
  coolOff(playerId, untilMs): Promise<void>;
  recordSettlement(playerId, currency, stake, payout): Promise<void>;
}
```

`checkBet` runs **before every single bet**, server-side, with no
client-supplied input trusted. It must be cheap and it must never fail open.

The rule that gets audited: **an exclusion is enforced by refusing the bet, not
by hiding a button.** A client can be modified; the server cannot. `Table.place()`
calls `checkBet` before it touches the wallet, so an excluded player's bet never
reaches the ledger and never consumes a nonce.

Hard blocks are evaluated before soft limits, deliberately — a self-excluded
player must never be told they hit a loss limit. The exclusion is the answer.

## 3. Geo — `compliance/geo.ts`

```ts
interface GeoProvider {
  resolve(ip, headers): Promise<string>;   // ISO 3166-1 alpha-2
  isBlocked(jurisdiction): Promise<boolean>;
}
```

Jurisdiction is resolved server-side from edge headers
(`cf-ipcountry`, `x-vercel-ip-country`, …) or the operator's geo service. It is
never read from a request body or query parameter, because those are the
client's to forge.

The blocklist is **server config**, not a compiled-in client list: a compiled-in
country list is a list of places to spoof, and it means a policy change needs a
client release. Set `ACE_BLOCKED_JURISDICTIONS` or replace `ConfigGeoProvider`.

## 4. Audit — `audit/audit-log.ts`

```ts
interface AuditSink {
  readonly durable: boolean;
  append(entry: AuditEntry): Promise<void> | void;
  tail(limit): Promise<AuditEntry[]> | AuditEntry[];
  all(): Promise<AuditEntry[]> | AuditEntry[];
}
```

Every entry carries the SHA-256 of the previous entry. Removing or editing any
record breaks every hash after it, and `verifyChain()` — exposed publicly at
`/api/audit/verify` — is what an auditor runs.

Point this at whatever your regulator expects: S3 with object lock, an
append-only Postgres table, a WORM bucket. `MemorySink` is a reference
implementation and **is not durable**; leaving it in production is a
certification failure, and the server says so at boot.

Recorded per hole: the seed triplet, the HMAC, and **the crash point at tee off,
before the player could act on it**. That record is what proves the outcome was
committed up front rather than chosen at settlement.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Game server port |
| `ACE_BLOCKED_JURISDICTIONS` | 13-country default deny list | Comma-separated ISO codes |
| `ACE_DEFAULT_JURISDICTION` | `GB` | Fallback when no edge header is present |
| `ACE_SESSION_SECRET` | per-instance random | Session token signing (serverless demo) |
| `ACE_CORS_ORIGIN` | `*` | Lock this down in production |

## Client integration

The client picks its transport automatically. Point it at your server:

```
VITE_ACE_WS=wss://ace.yourdomain.com/ws
```

Absent that, it falls back to the serverless HTTP transport. Both paths receive
the outcome only at settlement; neither ever learns a crash point early.

## Certification notes

- RTP and max win are served from `/api/info`, read from the same constants the
  engine runs, and surfaced in the game's own info panel.
- The evidence file is regenerated by `npm run sim` and CI fails if the
  committed evidence no longer matches `HOUSE_EDGE_MODULO` or `MAX_CARRY`.
- The verifier at `/verify` is standalone, offline-capable, and imports the same
  `@ace/core` derivation the server settles with. There is no second
  implementation to disagree with the first.
- `packages/core/src/ace.test.ts` pins the bundled SHA-256 against published
  FIPS 180-4 vectors and against `node:crypto`, so the pure-JS path used by the
  verifier can never silently diverge from the native path used by the server.
