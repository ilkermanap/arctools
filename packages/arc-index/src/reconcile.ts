/**
 * Prove an index is right instead of assuming it.
 *
 * Replaying the canonical movements for an address must reproduce the balance
 * change the node reports. Any residual is unlogged value movement -- gas fees
 * are the expected case, since Arc's EIP-7708 log covers CALL, CREATE,
 * SELFDESTRUCT and the mint/burn/transfer precompiles, but not fee payment.
 */
import { Rpc } from "../../arc-common/rpc.ts";
import type { Hex } from "../../arc-common/abi.ts";
import { netDeltas, scan, type ScanResult } from "./movements.ts";

export interface Reconciliation {
  address: Hex;
  fromBlock: bigint;
  toBlock: bigint;
  balanceBefore: bigint;
  balanceAfter: bigint;
  /** balanceAfter - balanceBefore, straight from the node. */
  actualDelta: bigint;
  /** Sum of indexed movements touching this address. */
  indexedDelta: bigint;
  /** actualDelta - indexedDelta. Negative means value left without a log. */
  residual: bigint;
  movementCount: number;
  verdict: "exact" | "fees-only" | "mismatch";
}

export async function reconcile(
  rpc: Rpc,
  address: Hex,
  fromBlock: bigint,
  toBlock: bigint,
  prescanned?: ScanResult,
): Promise<Reconciliation> {
  const result = prescanned ?? (await scan(rpc, fromBlock, toBlock));
  const lower = address.toLowerCase() as Hex;

  const touching = result.movements.filter((m) => m.from === lower || m.to === lower);
  const indexedDelta = netDeltas(touching).get(lower) ?? 0n;

  const [balanceBefore, balanceAfter] = await Promise.all([
    rpc.balance(address, "0x" + (fromBlock - 1n).toString(16)),
    rpc.balance(address, "0x" + toBlock.toString(16)),
  ]);

  const actualDelta = balanceAfter - balanceBefore;
  const residual = actualDelta - indexedDelta;

  // Fees can only ever reduce a balance, so a negative residual is explainable
  // and a positive one means the index missed incoming value.
  const verdict: Reconciliation["verdict"] =
    residual === 0n ? "exact" : residual < 0n ? "fees-only" : "mismatch";

  return {
    address: lower,
    fromBlock,
    toBlock,
    balanceBefore,
    balanceAfter,
    actualDelta,
    indexedDelta,
    residual,
    movementCount: touching.length,
    verdict,
  };
}
