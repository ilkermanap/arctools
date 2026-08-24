# arc-index-ponder

Dual-emitter-safe Arc USDC indexing for [Ponder](https://ponder.sh).

## The problem, and why Ponder needs a different shape

Arc logs every USDC movement from a native system emitter (18 decimals,
EIP-7708), and *again* from the ERC-20 contract (6 decimals) when the movement
went through the token interface. Both use the standard `Transfer` topic.

Ponder delivers one event at a time, so there is no batch in which to pair the
two logs. The fix follows from what the chain guarantees:

1. The **native emitter logs every real movement**. Indexing it alone already
   yields each movement exactly once.
2. The **ERC-20 emitter adds no movements** — only the knowledge that a movement
   was ERC-20-initiated.
3. Arc emits the **native log first**, before any other log in the transaction.

So: insert a row on every native event, and let each ERC-20 event *update* the
row it duplicates. Point 3 is what makes the update safe — the row always exists
by the time the marker arrives.

## Usage

```ts
// ponder.config.ts
import { createConfig } from "ponder";
import { arcTestnetChain, arcUsdcContracts } from "arc-index-ponder";

export default createConfig({
  chains: { arcTestnet: arcTestnetChain({ rpc: process.env.PONDER_RPC_URL_ARC }) },
  contracts: arcUsdcContracts({ chain: "arcTestnet", startBlock: 58_500_000 }),
});
```

```ts
// src/index.ts
import { ponder } from "ponder:registry";
import { movementFromNativeEvent, erc20MarkerLookup, isUnmatchableErc20Event } from "arc-index-ponder";

ponder.on("ArcUsdcNative:Transfer", async ({ event, context }) => {
  await context.db.insert(usdcMovement).values(movementFromNativeEvent(event));
});

ponder.on("ArcUsdcErc20:Transfer", async ({ event, context }) => {
  if (isUnmatchableErc20Event(event)) return;
  // …find the earliest matching row still marked "native", set it to "erc20"
});
```

A complete config, schema, and handler set are in [`example/`](example).

## Matching repeated transfers

`erc20MarkerLookup(event)` gives the equalities to query on: `txHash`, `from`,
`to`, and the ERC-20 amount **scaled up by 10¹²**, restricted to rows still
marked `via: "native"`.

Order by `logIndex` ascending and take the first row. That ordering is what makes
two identical transfers in one transaction pair up correctly — the nth ERC-20 log
claims the nth native row, exactly as the batch dedup does.

The example schema indexes `(txHash, from, to, value, logIndex)` for this query.

## `arcTestnetChain()`

Pins `ethGetLogsBlockRange` to 10 000 — the largest range every documented Arc
endpoint accepts. The four endpoints the docs present as interchangeable enforce
different caps (30 000 default, 10 000 dRPC, 50 000+ Blockdaemon) and none are
documented; the default endpoint even reports a 100 000 limit it does not
enforce. Raise it with `arcTestnetChain({ ethGetLogsBlockRange })` if your
endpoint allows more. `pollingInterval` defaults to 500 ms, matching Arc's block
time.

## Things the native emitter never logs

`isUnmatchableErc20Event` identifies them: **zero-value** transfers and
**self-transfers** (`from == to`). The ERC-20 contract emits both per the token
standard; the native emitter emits neither, and neither moves value. Skip them
instead of reporting a failed match — otherwise every self-transfer looks like a
missing row.

## Notes

- No dependency on `ponder` itself. Events are accepted structurally, so the
  helpers are testable without a running app.
- Set `includeErc20Markers: false` to index the native emitter alone. You still
  get every movement exactly once — just without the `via` distinction.
- Row ids are `txHash-logIndex` of the native log: stable across reindexes.

## Tests

```bash
node --test 'test/*.test.ts'
```

9 tests, no network — including a replay of the example handler's matching query
against an in-memory table, to pin the ordering rule.
