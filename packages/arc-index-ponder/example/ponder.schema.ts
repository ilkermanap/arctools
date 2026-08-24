import { index, onchainTable } from "ponder";

/**
 * One row per real USDC balance change on Arc.
 *
 * `value` is the authoritative 18-decimal native amount; `value6` is the same
 * movement as the ERC-20 interface reports it, truncated. Both are stored so a
 * consumer never has to infer which scale a number is in.
 */
export const usdcMovement = onchainTable(
  "usdc_movement",
  (t) => ({
    // txHash-logIndex of the native log.
    id: t.text().primaryKey(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    logIndex: t.integer().notNull(),
    from: t.hex().notNull(),
    to: t.hex().notNull(),
    // 18 decimals.
    value: t.bigint().notNull(),
    // 6 decimals, truncated.
    value6: t.bigint().notNull(),
    // "native" = plain send, one log. "erc20" = token call, the chain logged it twice.
    via: t.text().notNull(),
    kind: t.text().notNull(),
    dust: t.boolean().notNull(),
  }),
  (table) => ({
    // The marker lookup queries by (txHash, from, to, value) and orders by
    // logIndex, so that combination needs to be cheap.
    markerIdx: index().on(table.txHash, table.from, table.to, table.value, table.logIndex),
    fromIdx: index().on(table.from),
    toIdx: index().on(table.to),
    blockIdx: index().on(table.blockNumber),
  }),
);
