# arc-index-subsquid

Dual-emitter-safe Arc USDC indexing for [Subsquid (SQD)](https://sqd.ai) batch
processors.

## Why an adapter

Arc logs every USDC movement from a native system emitter (18 decimals,
EIP-7708), and *again* from the ERC-20 contract (6 decimals) when the movement
went through the token interface. Both use the standard `Transfer` topic, so the
usual "subscribe to Transfer" recipe double-counts.

A batch processor is the natural fit: SQD hands you whole blocks, so both streams
for a transaction are always in the same batch and the dedup rule applies with no
buffering.

## Usage

```ts
import { EvmBatchProcessor } from "@subsquid/evm-processor";
import {
  ARC_FINALITY_CONFIRMATION, ARC_RPC_SETTINGS, REQUIRED_LOG_FIELDS,
  arcUsdcLogRequest, movementsFromBatch, toRows,
} from "arc-index-subsquid";

const processor = new EvmBatchProcessor()
  .setRpcEndpoint(ARC_RPC_SETTINGS)
  .setFinalityConfirmation(ARC_FINALITY_CONFIRMATION)
  .setFields({ log: REQUIRED_LOG_FIELDS })
  .addLog(arcUsdcLogRequest());          // one request covers both emitters

processor.run(new TypeormDatabase(), async (ctx) => {
  const result = movementsFromBatch(ctx.blocks);
  await ctx.store.insert(toRows(result).map((r) => new UsdcMovement(r)));
});
```

A complete processor and schema are in [`example/`](example).

## No gateway for Arc

SQD publishes no gateway for Arc — 94 EVM networks are listed as of August 2026,
none of them Arc. **Ingestion is RPC-only: do not call `setGateway`.**

`ARC_RPC_SETTINGS` is deliberately conservative (`rateLimit: 10`) because Arc's
public RPC sits behind Cloudflare and answers bursts with 429. Point it at a
dedicated endpoint for a real backfill.

## What you get

`movementsFromBatch(ctx.blocks)` returns:

- **`movements`** — one per real balance change, at 18 decimals, each tagged
  `via: "erc20"` (the chain logged it twice) or `via: "native"` (a plain send).
  `value6` carries the truncated 6-decimal view, and `dust` marks amounts the
  ERC-20 interface cannot represent.
- **`stats`** — including `naiveRecords` vs the real count, and
  `doubleCountedVolume` vs `canonicalVolume`, so a dashboard can show what
  deduplication is actually saving.
- **`anomalies`** — a value-moving ERC-20 log with no native counterpart. This
  should never happen; a non-empty list means the index is unsound.
- **`incomplete`** — logs SQD returned without the fields the adapter needs.
  Forgetting `setFields` otherwise looks exactly like an empty chain, so it is
  reported rather than skipped.

Self-transfers and zero-value transfers are counted in `stats` but produce no
movement: the ERC-20 contract logs both, the native emitter logs neither, and
neither moves value.

## Notes

- No dependency on `@subsquid/evm-processor`. The batch is accepted structurally,
  so the adapter works across processor versions and is testable offline.
- `movementId` is `txHash-logIndex` of the native log — stable across reindexes,
  and distinct even for two identical transfers in one transaction.
- The dedup rule itself lives in [`arc-index/src/core.ts`](../arc-index/src/core.ts),
  shared with the CLI and the Ponder adapter.

## Tests

```bash
node --test 'test/*.test.ts'
```

10 tests against synthetic batches, no network.
