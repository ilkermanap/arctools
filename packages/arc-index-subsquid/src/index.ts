/**
 * Subsquid (SQD) adapter for Arc USDC indexing.
 *
 * A batch processor is the natural fit for Arc's dual-emitter problem: SQD hands
 * you whole blocks at a time, so both `Transfer` streams for a transaction are
 * always in the same batch and the dedup rule applies without buffering.
 *
 * This package has no dependency on `@subsquid/evm-processor`. It accepts the
 * batch shape structurally, so it works across processor versions and stays
 * testable without a running pipeline.
 *
 * NOTE: SQD publishes no gateway for Arc (94 EVM networks as of 2026-08, none of
 * them Arc), so ingestion is RPC-only. Do not call `setGateway`.
 */
import {
  deriveMovements, toRawLog, ERC20_EMITTER, NATIVE_EMITTER, TRANSFER_TOPIC,
  type DeriveResult, type Movement, type RawLog,
} from "../../arc-index/src/core.ts";

export {
  NATIVE_EMITTER, ERC20_EMITTER, TRANSFER_TOPIC, SCALE, ZERO, netDeltas,
} from "../../arc-index/src/core.ts";
export type { Movement, Anomaly, Stats, Via, Kind } from "../../arc-index/src/core.ts";

/** The subset of SQD's `Log` this adapter reads. */
export interface SqdLog {
  address?: string;
  topics?: readonly string[];
  data?: string;
  logIndex: number;
  transactionHash?: string;
}

/** The subset of SQD's `BlockData` this adapter reads. */
export interface SqdBlock {
  header: { height: number };
  logs: readonly SqdLog[];
}

/**
 * The log fields the processor must request. SQD returns only what you select,
 * and a missing `topics` or `data` silently yields zero movements.
 */
export const REQUIRED_LOG_FIELDS = {
  address: true,
  topics: true,
  data: true,
  transactionHash: true,
} as const;

/**
 * `addLog` arguments covering both emitters in one request. Pass the result
 * straight to `processor.addLog({ ...arcUsdcLogRequest(), range })`.
 */
export function arcUsdcLogRequest(): { address: string[]; topic0: string[] } {
  return {
    address: [NATIVE_EMITTER, ERC20_EMITTER],
    topic0: [TRANSFER_TOPIC],
  };
}

export const ARC_TESTNET_RPC = "https://rpc.testnet.arc.io";

/**
 * Recommended processor settings for Arc.
 *
 * `rateLimit` is deliberately conservative: Arc's public RPC sits behind
 * Cloudflare and answers bursts with 429. `maxBatchCallSize` stays small because
 * the RPC caps eth_getLogs at 100_000 blocks and large multicalls time out.
 */
export const ARC_RPC_SETTINGS = {
  url: ARC_TESTNET_RPC,
  rateLimit: 10,
  maxBatchCallSize: 100,
} as const;

/** Arc reaches deterministic finality in under a second, so one block is enough. */
export const ARC_FINALITY_CONFIRMATION = 1;

/** A log that SQD returned without the fields this adapter needs. */
export interface IncompleteLog {
  height: number;
  logIndex: number;
  missing: string[];
}

export interface BatchResult extends DeriveResult {
  fromBlock: number;
  toBlock: number;
  /**
   * Logs skipped because the processor did not select the required fields.
   * A non-empty list almost always means `setFields` is missing
   * `REQUIRED_LOG_FIELDS`, which would otherwise look like an empty chain.
   */
  incomplete: IncompleteLog[];
}

/** Normalise one SQD log, reporting which required fields were absent. */
function normalise(
  log: SqdLog,
  height: number,
): { raw: RawLog | null; missing: string[] } {
  const missing: string[] = [];
  if (log.address === undefined) missing.push("address");
  if (log.topics === undefined) missing.push("topics");
  if (log.data === undefined) missing.push("data");
  if (log.transactionHash === undefined) missing.push("transactionHash");
  if (missing.length > 0) return { raw: null, missing };

  return {
    raw: toRawLog({
      address: log.address!,
      topics: log.topics!,
      data: log.data!,
      blockNumber: BigInt(height),
      transactionHash: log.transactionHash!,
      logIndex: log.logIndex,
    }),
    missing,
  };
}

/**
 * Turn one SQD batch into canonical USDC movements.
 *
 * Call this once per batch, from inside `processor.run`, and persist
 * `result.movements`. Every ERC-20-initiated movement appears exactly once, with
 * `via: "erc20"`; plain native sends appear with `via: "native"`.
 */
export function movementsFromBatch(blocks: readonly SqdBlock[]): BatchResult {
  const logs: RawLog[] = [];
  const incomplete: IncompleteLog[] = [];
  let fromBlock = Number.POSITIVE_INFINITY;
  let toBlock = Number.NEGATIVE_INFINITY;

  for (const block of blocks) {
    const height = block.header.height;
    fromBlock = Math.min(fromBlock, height);
    toBlock = Math.max(toBlock, height);

    for (const log of block.logs) {
      const { raw, missing } = normalise(log, height);
      if (missing.length > 0) {
        incomplete.push({ height, logIndex: log.logIndex, missing });
        continue;
      }
      if (raw) logs.push(raw);
    }
  }

  return {
    fromBlock: Number.isFinite(fromBlock) ? fromBlock : 0,
    toBlock: Number.isFinite(toBlock) ? toBlock : 0,
    incomplete,
    ...deriveMovements(logs),
  };
}

/**
 * A stable primary key for a movement row: the native log identifies it
 * uniquely, and nothing else in the transaction can collide with it.
 */
export function movementId(movement: Movement): string {
  return `${movement.txHash}-${movement.logIndex}`;
}

/** Rows ready for `ctx.store.insert`, with bigints kept as bigints. */
export function toRows(result: BatchResult): {
  id: string;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
  from: string;
  to: string;
  value: bigint;
  value6: bigint;
  via: string;
  kind: string;
  dust: boolean;
}[] {
  return result.movements.map((m) => ({
    id: movementId(m),
    blockNumber: m.blockNumber,
    txHash: m.txHash,
    logIndex: m.logIndex,
    from: m.from,
    to: m.to,
    value: m.value,
    value6: m.value6,
    via: m.via,
    kind: m.kind,
    dust: m.dust,
  }));
}
