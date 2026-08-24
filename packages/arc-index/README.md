# arc-index

Dual-emitter-safe USDC indexing and balance reconciliation for Arc.

## The problem

Arc emits `Transfer` logs from two addresses:

| Source | Emitter | Decimals | Covers |
|---|---|---|---|
| Native system (EIP-7708) | `0xffff…fffe` | 18 | every real movement |
| ERC-20 `NativeFiatToken` | `0x3600…0000` | 6 | ERC-20 calls only |

Both use the standard topic0. A single `transfer()` emits **two** logs — so the
default "subscribe to `Transfer` by topic" recipe in every indexer template
double-counts, and adds a 6-decimal number to an 18-decimal one while doing it.

`arc-index` treats the native emitter as the single source of truth and uses the
ERC-20 stream only to label how each movement was initiated.

## Usage

```bash
node src/cli.ts scan --blocks 150
node src/cli.ts reconcile --address 0x… --blocks 60
node src/cli.ts top --blocks 60 --limit 5
node src/cli.ts scan --blocks 500 --json > movements.json
```

## What `scan` reports

- **canonical movements** — one per real balance change, at 18 decimals
- **`via: "erc20"` vs `"native"`** — whether the chain logged it twice or once
- **dust** — movements with precision below 6 decimals, invisible to `balanceOf`
- **self-transfers and zero-value logs** — ERC-20 logs with no native counterpart,
  because the native emitter deliberately skips both. These move no value; an
  indexer trusting the ERC-20 stream alone invents balance changes for them.
- **anomalies** — a value-moving ERC-20 log with *no* native counterpart. This
  should never happen; a non-empty list means the index is unsound.

## What `reconcile` proves

Replay every indexed movement for an address and compare against
`eth_getBalance` at both ends of the range.

- `exact` — every wei of movement is explained by logs.
- `fees-only` — a negative residual, consistent with gas. EIP-7708 does not emit
  a `Transfer` for fee payment, so this is the expected result for a fee payer.
- `mismatch` — value arrived that no log explains. The index is incomplete.

## Notes

- `eth_getLogs` caps differ per endpoint and none are documented: **30 000** on
  `rpc.testnet.arc.io`, **10 000** on the dRPC mirror, 50 000+ on Blockdaemon.
  Requests are
  chunked and split recursively on failure, so a provider with a tighter limit
  still works.
- The RPC sits behind Cloudflare and returns 429 on bursts. The shared client
  rate-limits itself; override with `ARC_RPC_RPS` (default 12).
- Mint is `Transfer(0x0, to, v)` and burn is `Transfer(from, 0x0, v)`. The zero
  address is excluded from net-flow accounting.

## Tests

```bash
node --test 'test/*.test.ts'
```

10 tests against canned logs, no network. They pin the pairing rule (matching
`from`, `to`, and `value × 10¹²`), one-to-one log consumption, dust truncation,
the self-transfer and zero-value exceptions, and that net deltas sum to zero.
