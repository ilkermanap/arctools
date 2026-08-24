/**
 * The dual-emitter dedup rule, as a pure function over normalised logs.
 *
 * This module has no RPC, network, or framework dependency on purpose. Every
 * consumer -- the CLI scanner, the Ponder adapter, the Subsquid adapter -- turns
 * its own log shape into `RawLog[]` and calls `deriveMovements`, so all of them
 * agree on what a USDC movement is.
 *
 * Background: Arc emits a `Transfer` log from the native system emitter
 * (18 decimals, EIP-7708) for every real movement, and *additionally* from the
 * ERC-20 contract (6 decimals) when the movement went through the token
 * interface. Both share the standard topic0.
 *
 * https://docs.arc.io/arc/references/usdc-system-events
 */

export type Address = `0x${string}`;

/** Native system emitter (EIP-7708). Records every real movement, 18 decimals. */
export const NATIVE_EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe" as Address;

/** ERC-20 NativeFiatToken. Records ERC-20 interface activity only, 6 decimals. */
export const ERC20_EMITTER = "0x3600000000000000000000000000000000000000" as Address;

/** keccak256("Transfer(address,address,uint256)") -- shared by both emitters. */
export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

export const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** 18-decimal native units per 1 unit of the 6-decimal ERC-20 view. */
export const SCALE = 10n ** 12n;

/** A `Transfer` log, normalised and lowercased. `value` is in the emitter's own decimals. */
export interface RawLog {
  emitter: Address;
  from: Address;
  to: Address;
  value: bigint;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
}

export type Via = "native" | "erc20";
export type Kind = "transfer" | "mint" | "burn";

export interface Movement {
  blockNumber: bigint;
  txHash: string;
  /** logIndex of the authoritative native log. */
  logIndex: number;
  from: Address;
  to: Address;
  /** Authoritative amount, 18 decimals. */
  value: bigint;
  /** What the 6-decimal ERC-20 view shows for this movement (truncated). */
  value6: bigint;
  via: Via;
  kind: Kind;
  /** Set when `value` has precision the 6-decimal view cannot represent. */
  dust: boolean;
}

export interface Anomaly {
  txHash: string;
  logIndex: number;
  reason: string;
}

export interface Stats {
  nativeLogs: number;
  erc20Logs: number;
  /** Sum of canonical movements, 18 decimals. */
  canonicalVolume: bigint;
  /**
   * What an indexer reports if it normalises each emitter's decimals correctly
   * but never deduplicates: every ERC-20-initiated movement counted twice.
   */
  doubleCountedVolume: bigint;
  /** Transfer rows a topic-only indexer would create: one per raw log. */
  naiveRecords: number;
  nativeOnlyMovements: number;
  erc20Movements: number;
  dustMovements: number;
  /**
   * ERC-20 logs with no native counterpart because the native emitter suppresses
   * them. Neither moves value; an indexer trusting the ERC-20 stream alone
   * invents balance changes for the self-transfers.
   */
  selfTransferLogs: number;
  zeroValueLogs: number;
}

export interface DeriveResult {
  movements: Movement[];
  anomalies: Anomaly[];
  stats: Stats;
}

function kindOf(from: Address, to: Address): Kind {
  if (from === ZERO) return "mint";
  if (to === ZERO) return "burn";
  return "transfer";
}

/** Group by transaction hash, ordering each group by logIndex. */
function groupByTx(logs: RawLog[]): Map<string, RawLog[]> {
  const out = new Map<string, RawLog[]>();
  for (const log of logs) {
    const list = out.get(log.txHash);
    if (list) list.push(log);
    else out.set(log.txHash, [log]);
  }
  for (const list of out.values()) list.sort((a, b) => a.logIndex - b.logIndex);
  return out;
}

/**
 * Reduce a mixed set of `Transfer` logs to one movement per real balance change.
 *
 * Logs may arrive in any order and may span several blocks; only same-transaction
 * pairing is attempted, which is the only place the chain emits a duplicate.
 */
export function deriveMovements(logs: RawLog[]): DeriveResult {
  const nativeLogs: RawLog[] = [];
  const erc20Logs: RawLog[] = [];
  for (const log of logs) {
    if (log.emitter === NATIVE_EMITTER) nativeLogs.push(log);
    else if (log.emitter === ERC20_EMITTER) erc20Logs.push(log);
  }

  const erc20ByTx = groupByTx(erc20Logs);
  const nativeByTx = groupByTx(nativeLogs);

  const movements: Movement[] = [];
  const anomalies: Anomaly[] = [];
  let canonicalVolume = 0n;
  let doubleCounted = 0n;
  let selfTransferLogs = 0;
  let zeroValueLogs = 0;

  /**
   * An unpaired ERC-20 log is only surprising if it moved value. The native
   * emitter deliberately skips zero-value and self-transfers, while the ERC-20
   * contract emits them per the token standard.
   */
  const classifyUnpaired = (log: RawLog): void => {
    if (log.value === 0n) {
      zeroValueLogs++;
      return;
    }
    if (log.from === log.to) {
      selfTransferLogs++;
      return;
    }
    anomalies.push({
      txHash: log.txHash,
      logIndex: log.logIndex,
      reason:
        `ERC-20 Transfer log #${log.logIndex} moved ${log.value} (6 dec) from ${log.from} ` +
        `to ${log.to} with no native counterpart. The native emitter records every real ` +
        `movement, so the block range clipped a log or the chain diverged from spec.`,
    });
  };

  for (const [txHash, txNative] of nativeByTx) {
    // Each ERC-20 log pairs with at most one native log, so consume as we go.
    const candidates = (erc20ByTx.get(txHash) ?? []).map((log) => ({ log, used: false }));

    for (const log of txNative) {
      const pair = candidates.find(
        (c) =>
          !c.used &&
          c.log.from === log.from &&
          c.log.to === log.to &&
          c.log.value * SCALE === log.value,
      );
      if (pair) pair.used = true;

      movements.push({
        blockNumber: log.blockNumber,
        txHash,
        logIndex: log.logIndex,
        from: log.from,
        to: log.to,
        value: log.value,
        value6: log.value / SCALE,
        via: pair ? "erc20" : "native",
        kind: kindOf(log.from, log.to),
        dust: log.value % SCALE !== 0n,
      });
      canonicalVolume += log.value;
      if (pair) doubleCounted += log.value;
    }

    for (const c of candidates) if (!c.used) classifyUnpaired(c.log);
  }

  // ERC-20 logs in transactions the native emitter recorded nothing for.
  for (const [txHash, txErc20] of erc20ByTx) {
    if (nativeByTx.has(txHash)) continue;
    for (const log of txErc20) classifyUnpaired(log);
  }

  movements.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);

  return {
    movements,
    anomalies,
    stats: {
      nativeLogs: nativeLogs.length,
      erc20Logs: erc20Logs.length,
      canonicalVolume,
      doubleCountedVolume: canonicalVolume + doubleCounted,
      naiveRecords: nativeLogs.length + erc20Logs.length,
      nativeOnlyMovements: movements.filter((m) => m.via === "native").length,
      erc20Movements: movements.filter((m) => m.via === "erc20").length,
      dustMovements: movements.filter((m) => m.dust).length,
      selfTransferLogs,
      zeroValueLogs,
    },
  };
}

/** Net 18-decimal balance delta per address. The zero address is not a holder. */
export function netDeltas(movements: Movement[]): Map<Address, bigint> {
  const out = new Map<Address, bigint>();
  const bump = (a: Address, d: bigint) => out.set(a, (out.get(a) ?? 0n) + d);
  for (const m of movements) {
    if (m.from !== ZERO) bump(m.from, -m.value);
    if (m.to !== ZERO) bump(m.to, m.value);
  }
  return out;
}

/**
 * Decode a `Transfer` log from the raw fields every EVM data source exposes.
 * Returns null for anything that is not a USDC `Transfer` from a known emitter,
 * so callers can pass a whole batch without pre-filtering.
 */
export function toRawLog(input: {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber: bigint | number | string;
  transactionHash: string;
  logIndex: number | string;
}): RawLog | null {
  const emitter = input.address.toLowerCase() as Address;
  if (emitter !== NATIVE_EMITTER && emitter !== ERC20_EMITTER) return null;
  if (input.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null;
  // A malformed Transfer log (missing indexed params) is not decodable.
  if (input.topics.length < 3) return null;

  return {
    emitter,
    from: ("0x" + input.topics[1].slice(-40).toLowerCase()) as Address,
    to: ("0x" + input.topics[2].slice(-40).toLowerCase()) as Address,
    value: BigInt(input.data === "0x" || input.data === "" ? "0x0" : input.data),
    blockNumber: BigInt(input.blockNumber),
    txHash: input.transactionHash.toLowerCase(),
    logIndex: Number(input.logIndex),
  };
}
