/**
 * RPC-backed scanning on top of the pure dedup core in `core.ts`.
 *
 * Everything about *what counts as a movement* lives in core.ts; this file only
 * fetches logs and hands them over.
 */
import { Rpc, type Log } from "../../arc-common/rpc.ts";
import {
  deriveMovements, toRawLog, ERC20_EMITTER, NATIVE_EMITTER, TRANSFER_TOPIC,
  type Address, type DeriveResult, type RawLog,
} from "./core.ts";

export {
  deriveMovements, netDeltas, toRawLog,
  NATIVE_EMITTER, ERC20_EMITTER, TRANSFER_TOPIC, ZERO, SCALE,
} from "./core.ts";
export type { Movement, Anomaly, Stats, Via, Kind, RawLog, Address } from "./core.ts";

export interface ScanResult extends DeriveResult {
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * Arc's documented RPC endpoints enforce different eth_getLogs caps -- 30_000 on
 * rpc.testnet.arc.io, 10_000 on the dRPC mirror, more on Blockdaemon -- and none
 * of them are documented. The default here fits the smallest, and any endpoint
 * that refuses anyway is handled by splitting rather than failing.
 */
async function logsChunked(
  rpc: Rpc,
  emitter: Address,
  fromBlock: bigint,
  toBlock: bigint,
  chunk = 10_000n,
): Promise<Log[]> {
  const out: Log[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = start + chunk - 1n > toBlock ? toBlock : start + chunk - 1n;
    try {
      out.push(
        ...(await rpc.logs({
          fromBlock: start,
          toBlock: end,
          address: emitter,
          topics: [TRANSFER_TOPIC],
        })),
      );
    } catch (err) {
      if (end === start) throw err;
      const mid = start + (end - start) / 2n;
      out.push(...(await logsChunked(rpc, emitter, start, mid, chunk)));
      out.push(...(await logsChunked(rpc, emitter, mid + 1n, end, chunk)));
    }
  }
  return out;
}

function normalise(logs: Log[]): RawLog[] {
  const out: RawLog[] = [];
  for (const log of logs) {
    const raw = toRawLog(log);
    if (raw) out.push(raw);
  }
  return out;
}

export async function scan(rpc: Rpc, fromBlock: bigint, toBlock: bigint): Promise<ScanResult> {
  const [native, erc20] = await Promise.all([
    logsChunked(rpc, NATIVE_EMITTER, fromBlock, toBlock),
    logsChunked(rpc, ERC20_EMITTER, fromBlock, toBlock),
  ]);
  return {
    fromBlock,
    toBlock,
    ...deriveMovements([...normalise(native), ...normalise(erc20)]),
  };
}
