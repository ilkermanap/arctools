/**
 * Ponder adapter for Arc USDC indexing.
 *
 * Ponder delivers one event at a time, so the batch dedup used elsewhere in this
 * repo does not apply directly. The fix follows from what the chain guarantees:
 *
 *   1. The native system emitter (0xffff…fffe, 18 decimals) logs EVERY real
 *      movement. Indexing it alone already yields each movement exactly once.
 *   2. The ERC-20 emitter (0x3600…0000, 6 decimals) logs only movements that went
 *      through the token interface. It adds no movements — only the knowledge
 *      that a movement was ERC-20-initiated.
 *   3. Arc emits the native log FIRST, before any other log in the transaction.
 *
 * So: insert a movement row on every native event, then let each ERC-20 event
 * *update* the row it duplicates. Point (3) is what makes the update safe — the
 * row always exists by the time the marker arrives.
 *
 * Matching an ERC-20 log to its native row uses (txHash, from, to, value×10¹²)
 * and takes the lowest unmarked logIndex. Two identical transfers in one
 * transaction therefore pair in order, exactly as the batch dedup does.
 *
 * This package does not import `ponder`. It provides config objects, an ABI, and
 * pure mapping helpers, so it is testable without a running Ponder app.
 *
 * https://docs.arc.io/arc/references/usdc-system-events
 */
import {
  ERC20_EMITTER, NATIVE_EMITTER, SCALE, TRANSFER_TOPIC, ZERO,
  type Address, type Kind, type Via,
} from "../../arc-index/src/core.ts";

export {
  NATIVE_EMITTER, ERC20_EMITTER, TRANSFER_TOPIC, SCALE, ZERO,
} from "../../arc-index/src/core.ts";
export type { Via, Kind, Address } from "../../arc-index/src/core.ts";

export const ARC_TESTNET_RPC = "https://rpc.testnet.arc.io";
export const ARC_TESTNET_WS = "wss://rpc.testnet.arc.io";
export const ARC_TESTNET_CHAIN_ID = 5042002;

/**
 * Chain entry for `createConfig({ chains: { arcTestnet: arcTestnetChain() } })`.
 *
 * `ethGetLogsBlockRange` is pinned to Arc's documented-by-error 100_000-block
 * cap. Without it Ponder probes for the limit by triggering failures, which is
 * slow and noisy on a rate-limited endpoint.
 */
export function arcTestnetChain(
  overrides: { rpc?: string | string[]; ws?: string; pollingInterval?: number } = {},
): {
  id: number;
  rpc: string | string[];
  ws?: string;
  pollingInterval: number;
  ethGetLogsBlockRange: number;
} {
  return {
    id: ARC_TESTNET_CHAIN_ID,
    rpc: overrides.rpc ?? ARC_TESTNET_RPC,
    ...(overrides.ws ? { ws: overrides.ws } : {}),
    // Blocks are ~0.5 s, so polling faster than that only burns rate limit.
    pollingInterval: overrides.pollingInterval ?? 500,
    ethGetLogsBlockRange: 100_000,
  };
}

/**
 * The only event either emitter produces that this adapter needs. Both use the
 * standard ERC-20 signature, so one ABI covers both contracts.
 */
export const TRANSFER_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

export interface ContractsOptions {
  /** Chain key used in `createConfig({ chains })`. */
  chain?: string;
  startBlock?: number | "latest";
  endBlock?: number | "latest";
  /**
   * Index the ERC-20 emitter as well, to label movements as ERC-20-initiated.
   * Leave this off and you still get every movement — just without `via`.
   */
  includeErc20Markers?: boolean;
}

/**
 * Contracts entry for `createConfig({ contracts: arcUsdcContracts() })`.
 *
 * `ArcUsdcNative` is the source of truth. `ArcUsdcErc20` is a labelling stream —
 * never treat its events as movements of their own.
 */
export function arcUsdcContracts(options: ContractsOptions = {}): Record<
  string,
  {
    abi: typeof TRANSFER_ABI;
    chain: string;
    address: Address;
    startBlock?: number | "latest";
    endBlock?: number | "latest";
  }
> {
  const { chain = "arcTestnet", startBlock, endBlock, includeErc20Markers = true } = options;
  const shared = {
    abi: TRANSFER_ABI,
    chain,
    ...(startBlock !== undefined ? { startBlock } : {}),
    ...(endBlock !== undefined ? { endBlock } : {}),
  };

  return {
    ArcUsdcNative: { ...shared, address: NATIVE_EMITTER },
    ...(includeErc20Markers ? { ArcUsdcErc20: { ...shared, address: ERC20_EMITTER } } : {}),
  };
}

/** The subset of a Ponder Transfer event this adapter reads. */
export interface PonderTransferEvent {
  args: { from: string; to: string; value: bigint };
  log: { logIndex: number; transactionHash: string };
  block: { number: bigint; timestamp: bigint };
}

export interface MovementRow {
  /** `txHash-logIndex` of the native log. Stable and collision-free. */
  id: string;
  blockNumber: bigint;
  timestamp: bigint;
  txHash: string;
  logIndex: number;
  from: Address;
  to: Address;
  /** Authoritative amount, 18 decimals. */
  value: bigint;
  /** The 6-decimal ERC-20 view of the same amount, truncated. */
  value6: bigint;
  via: Via;
  kind: Kind;
  /** `value` carries precision the 6-decimal view cannot represent. */
  dust: boolean;
}

function kindOf(from: Address, to: Address): Kind {
  if (from === ZERO) return "mint";
  if (to === ZERO) return "burn";
  return "transfer";
}

const lower = (a: string) => a.toLowerCase() as Address;

/**
 * Map a native `Transfer` event to a movement row. This is the ONLY place rows
 * are created, which is what makes double-counting structurally impossible.
 */
export function movementFromNativeEvent(event: PonderTransferEvent): MovementRow {
  const from = lower(event.args.from);
  const to = lower(event.args.to);
  const value = event.args.value;

  return {
    id: `${event.log.transactionHash.toLowerCase()}-${event.log.logIndex}`,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
    txHash: event.log.transactionHash.toLowerCase(),
    logIndex: event.log.logIndex,
    from,
    to,
    value,
    value6: value / SCALE,
    via: "native",
    kind: kindOf(from, to),
    dust: value % SCALE !== 0n,
  };
}

/**
 * The row an ERC-20 `Transfer` event duplicates, expressed as a lookup.
 *
 * Query movements with these equalities, order by `logIndex` ascending, take the
 * first row still marked `via: "native"`, and set it to `"erc20"`. Ordering is
 * what makes repeated identical transfers in one transaction pair correctly.
 */
export function erc20MarkerLookup(event: PonderTransferEvent): {
  txHash: string;
  from: Address;
  to: Address;
  /** The ERC-20 amount scaled up to the native 18-decimal precision. */
  value: bigint;
  via: Via;
} {
  return {
    txHash: event.log.transactionHash.toLowerCase(),
    from: lower(event.args.from),
    to: lower(event.args.to),
    value: event.args.value * SCALE,
    via: "native",
  };
}

/**
 * True when an ERC-20 event is one the native emitter never logged, so no
 * movement row will ever match it. Skip these instead of reporting a miss:
 * zero-value and self-transfers move nothing, and Arc documents both omissions.
 */
export function isUnmatchableErc20Event(event: PonderTransferEvent): boolean {
  return event.args.value === 0n || lower(event.args.from) === lower(event.args.to);
}
