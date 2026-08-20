# ACE — Paytable and rules

Everything a player, an operator or a lab needs to reconstruct any outcome.
The figures here are the figures the engine runs: `/api/info` serves them from
the same constants, so the disclosure panel in the game cannot drift from this
document.

## Headline

| | |
|---|---|
| Return to player | **99.0099%** |
| RTP variation by strategy | none — flat at every cash-out target |
| Maximum carry | **10,000.00x** (1,000,000 yards) |
| Minimum carry | 1.00x |
| Instant bust frequency | 1 hole in 101 (0.9901%) |
| Total 1.00x frequency | 1.9704% |
| Median carry | 1.97x |
| House edge | 0.9901% |

## How a hole is decided

```
h     = first 52 bits of HMAC-SHA256(serverSeed, clientSeed + ":" + nonce)

carry = 1.00                                    if h % 101 == 0
      = floor(100 * 2^52 / (2^52 - h)) / 100    otherwise

carry = min(carry, 10000)
yards = carry * 100
```

`P(carry ≥ m) = (1 − 1/101) / m` for every `m`, which is why RTP is the same
whether a player lays up at 1.01x or holds for the cap.

## Carry bands

Measured over 100,000,000 simulated holes. Full table in
[`math-evidence.md`](math-evidence.md).

| Band | Frequency | Odds |
|---|---|---|
| In the drink at 1.00x | 1.97% | 1 in 51 |
| 1.01x – 1.49x | 32.0% | 1 in 3 |
| 1.50x – 1.99x | 16.5% | 1 in 6 |
| 2.00x – 4.99x | 29.7% | 1 in 3 |
| 5.00x – 9.99x | 9.90% | 1 in 10 |
| 10.00x – 49.99x | 7.92% | 1 in 13 |
| 50.00x – 999.99x | 1.88% | 1 in 53 |
| 1,000.00x – 9,999.99x | 0.089% | 1 in 1,122 |
| 10,000.00x (cap) | 0.0099% | 1 in 10,086 |

## Settlement rules

**Marking.** A hole pays at the carry the ball had reached when the mark reached
the server, minus a fixed **200ms uplink grace**. The grace exists so a player is
not charged for their own network; it is fixed rather than client-reported
because a client-supplied latency figure is a free multiplier for anyone willing
to lie about it. It never converts a losing hole into a winning one — the graced
carry is still compared against the crash point.

**Lay-up.** A lay-up target is enforced by the server. If the hole reaches it,
the server banks it on time whether or not the client is still connected. A
dropped connection cannot cost a player a lay-up, and cannot cost them their
stake.

**The cap.** A hole whose derivation exceeds 10,000x is clamped inside the
derivation, and is settled as a **win at 10,000x** rather than a bust. Max win is
a payable outcome, not a ceiling a player has to hand-time. The cap is reachable
about 1 hole in 10,086; that frequency is pinned by the flat RTP and is not
independently tunable.

**Rounding.** Payout is `floor(stake × carry)` in the currency's smallest unit.
Truncation is toward zero, so rounding favours the house by at most one minor
unit per hole.

**Disconnection.** An in-flight hole keeps running server-side. A lay-up is
honoured; a manual hole that is never marked settles at its crash point, which
is the same result it would have had if the player had watched it.

**One ball at a time.** A player cannot have two holes in the air at once.

## Table limits

Per currency, set by the operator. The reference configuration:

| Currency | Min | Max |
|---|---|---|
| BTC | 0.00000100 | 0.01000000 |
| ETH | 0.00010000 | 0.50000000 |
| USDT | 0.10 | 1,000.00 |
| USD / EUR | 0.10 | 1,000.00 |

Maximum exposure per hole is `max stake × 10,000`. That product, not the cap
alone, is the number to set table limits against.

## Vocabulary

| Concept | Term |
|---|---|
| Place bet | Tee it up |
| Cash out | Mark it |
| Bust | In the drink |
| Multiplier | Carry (`2.41x` = `241y`) |
| Round | Hole |
| Auto cash out | Lay-up at |
