/**
 * A complete SQD processor for Arc USDC. Copy into a squid project alongside
 * a `schema.graphql` and generated TypeORM model.
 *
 * Install:  npm i @subsquid/evm-processor @subsquid/typeorm-store
 */
import { EvmBatchProcessor } from "@subsquid/evm-processor";
import { TypeormDatabase } from "@subsquid/typeorm-store";
import {
  ARC_FINALITY_CONFIRMATION,
  ARC_RPC_SETTINGS,
  REQUIRED_LOG_FIELDS,
  arcUsdcLogRequest,
  movementsFromBatch,
  toRows,
} from "arc-index-subsquid";
import { UsdcMovement } from "./model/generated/index.js";

const processor = new EvmBatchProcessor()
  // SQD publishes no gateway for Arc, so ingestion is RPC-only.
  // Do NOT call setGateway() here — there is nothing to point it at.
  .setRpcEndpoint(ARC_RPC_SETTINGS)
  .setFinalityConfirmation(ARC_FINALITY_CONFIRMATION)
  .setBlockRange({ from: Number(process.env.START_BLOCK ?? 58_500_000) })
  .setFields({ log: REQUIRED_LOG_FIELDS })
  // One request covers both emitters; the adapter sorts out which is which.
  .addLog(arcUsdcLogRequest());

processor.run(new TypeormDatabase({ supportHotBlocks: true }), async (ctx) => {
  const result = movementsFromBatch(ctx.blocks);

  if (result.incomplete.length > 0) {
    // Almost always a missing setFields entry, which otherwise looks like an
    // empty chain rather than a misconfiguration.
    ctx.log.error(
      `${result.incomplete.length} logs lacked required fields ` +
        `(${result.incomplete[0].missing.join(", ")}) — check setFields`,
    );
  }

  for (const anomaly of result.anomalies) {
    // An ERC-20 transfer with no native counterpart should be impossible.
    ctx.log.warn(`anomaly in ${anomaly.txHash}: ${anomaly.reason}`);
  }

  await ctx.store.insert(toRows(result).map((row) => new UsdcMovement(row)));

  if (result.movements.length > 0) {
    ctx.log.info(
      `${result.fromBlock}-${result.toBlock}: ${result.movements.length} movements ` +
        `from ${result.stats.naiveRecords} raw logs ` +
        `(${result.stats.erc20Movements} would have been double-counted)`,
    );
  }
});
