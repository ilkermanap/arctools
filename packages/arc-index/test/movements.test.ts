import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Log } from "../../arc-common/rpc.ts";
import type { Hex } from "../../arc-common/abi.ts";
import { Rpc } from "../../arc-common/rpc.ts";
import {
  scan, netDeltas, NATIVE_EMITTER, ERC20_EMITTER, TRANSFER_TOPIC, SCALE, ZERO,
} from "../src/movements.ts";

const A = "0x1111111111111111111111111111111111111111" as Hex;
const B = "0x2222222222222222222222222222222222222222" as Hex;

const pad = (a: Hex) => ("0x" + a.slice(2).padStart(64, "0")) as Hex;
const hex = (v: bigint) => ("0x" + v.toString(16).padStart(64, "0")) as Hex;

let seq = 0;
function log(emitter: Hex, from: Hex, to: Hex, value: bigint, tx = "0xaa", block = 100n): Log {
  return {
    address: emitter,
    topics: [TRANSFER_TOPIC, pad(from), pad(to)],
    data: hex(value),
    blockNumber: ("0x" + block.toString(16)) as Hex,
    transactionHash: tx as Hex,
    logIndex: ("0x" + (seq++).toString(16)) as Hex,
  };
}

/** An Rpc that serves canned logs, so the dedup logic is tested without a network. */
function fakeRpc(native: Log[], erc20: Log[]): Rpc {
  const rpc = new Rpc("http://fake");
  // @ts-ignore -- deliberately narrowing the surface the scanner uses.
  rpc.logs = async (opts: { address?: string }) =>
    opts.address?.toLowerCase() === NATIVE_EMITTER ? native : erc20;
  return rpc;
}

test("an ERC-20 transfer is one movement, not two", async () => {
  seq = 0;
  const six = 1_500_000n; // 1.5 USDC at 6 decimals
  const r = await scan(fakeRpc([log(NATIVE_EMITTER, A, B, six * SCALE)], [log(ERC20_EMITTER, A, B, six)]), 100n, 100n);

  assert.equal(r.movements.length, 1);
  assert.equal(r.movements[0].via, "erc20");
  assert.equal(r.movements[0].value, six * SCALE);
  assert.equal(r.movements[0].value6, six);
  assert.equal(r.stats.canonicalVolume, six * SCALE);
  assert.equal(r.stats.doubleCountedVolume, six * SCALE * 2n, "no-dedup volume doubles");
  assert.equal(r.stats.naiveRecords, 2);
  assert.deepEqual(r.anomalies, []);
});

test("a plain native send is one movement with no ERC-20 log", async () => {
  seq = 0;
  const r = await scan(fakeRpc([log(NATIVE_EMITTER, A, B, 7n * SCALE)], []), 100n, 100n);
  assert.equal(r.movements.length, 1);
  assert.equal(r.movements[0].via, "native");
  assert.equal(r.stats.doubleCountedVolume, r.stats.canonicalVolume);
});

test("sub-6-decimal native dust is flagged and invisible to the ERC-20 view", async () => {
  seq = 0;
  const r = await scan(fakeRpc([log(NATIVE_EMITTER, A, B, 100n)], []), 100n, 100n);
  assert.equal(r.movements[0].dust, true);
  assert.equal(r.movements[0].value6, 0n, "truncates to zero at 6 decimals");
});

test("a self-transfer logs only on the ERC-20 side and is not an anomaly", async () => {
  seq = 0;
  const r = await scan(fakeRpc([], [log(ERC20_EMITTER, A, A, 400_000n)]), 100n, 100n);
  assert.equal(r.movements.length, 0, "no balance changed, so no movement");
  assert.equal(r.stats.selfTransferLogs, 1);
  assert.deepEqual(r.anomalies, []);
});

test("a zero-value ERC-20 log is not an anomaly either", async () => {
  seq = 0;
  const r = await scan(fakeRpc([], [log(ERC20_EMITTER, A, B, 0n)]), 100n, 100n);
  assert.equal(r.stats.zeroValueLogs, 1);
  assert.deepEqual(r.anomalies, []);
});

test("a value-moving ERC-20 log with no native counterpart IS an anomaly", async () => {
  seq = 0;
  const r = await scan(fakeRpc([], [log(ERC20_EMITTER, A, B, 5_000_000n)]), 100n, 100n);
  assert.equal(r.anomalies.length, 1);
  assert.match(r.anomalies[0].reason, /no native counterpart/);
});

test("pairing needs matching from, to, and scaled value", async () => {
  seq = 0;
  // Same participants, but the ERC-20 value does not scale to the native one.
  const r = await scan(
    fakeRpc([log(NATIVE_EMITTER, A, B, 1_000_000n * SCALE)], [log(ERC20_EMITTER, A, B, 999_999n)]),
    100n, 100n,
  );
  assert.equal(r.movements[0].via, "native", "must not pair on participants alone");
  assert.equal(r.anomalies.length, 1);
});

test("each ERC-20 log is consumed by at most one native log", async () => {
  seq = 0;
  const v = 2_000_000n;
  // Two identical transfers in one transaction: two pairs, not one pair plus a duplicate.
  const r = await scan(
    fakeRpc(
      [log(NATIVE_EMITTER, A, B, v * SCALE), log(NATIVE_EMITTER, A, B, v * SCALE)],
      [log(ERC20_EMITTER, A, B, v), log(ERC20_EMITTER, A, B, v)],
    ),
    100n, 100n,
  );
  assert.equal(r.movements.length, 2);
  assert.deepEqual(r.movements.map((m) => m.via), ["erc20", "erc20"]);
  assert.deepEqual(r.anomalies, []);
});

test("mint and burn are read from the zero address", async () => {
  seq = 0;
  const r = await scan(
    fakeRpc([log(NATIVE_EMITTER, ZERO, A, 5n * SCALE), log(NATIVE_EMITTER, A, ZERO, 2n * SCALE)], []),
    100n, 100n,
  );
  assert.deepEqual(r.movements.map((m) => m.kind), ["mint", "burn"]);

  // The zero address is not a real holder, so it must not appear in net flow.
  const deltas = netDeltas(r.movements);
  assert.equal(deltas.get(ZERO), undefined);
  assert.equal(deltas.get(A), 3n * SCALE);
});

test("net deltas sum to zero across a closed set of transfers", async () => {
  seq = 0;
  const r = await scan(
    fakeRpc([log(NATIVE_EMITTER, A, B, 9n * SCALE), log(NATIVE_EMITTER, B, A, 4n * SCALE)], []),
    100n, 100n,
  );
  const total = [...netDeltas(r.movements).values()].reduce((a, b) => a + b, 0n);
  assert.equal(total, 0n);
});

// Real mainnet case suggested in https://github.com/ilkermanap/arctools/issues/1.
// The saved response is read locally: this test never calls an RPC endpoint.
test("a mainnet escrow payout pairs six Transfer logs into three movements", async () => {
  const { result: receipt } = JSON.parse(readFileSync(
    new URL("./fixtures/mainnet-escrow-payout.receipt.json", import.meta.url), "utf8",
  )) as { result: { transactionHash: Hex; status: Hex; blockNumber: Hex; logs: Log[] } };
  assert.equal(receipt.transactionHash,
    "0x73d026991436c92b1700af66f230b64a4004aa96758ce837cb732e6f253867b3");
  assert.equal(receipt.status, "0x1");

  const transfers = receipt.logs.filter((entry) => entry.topics[0] === TRANSFER_TOPIC);
  assert.equal(transfers.length, 6);
  const block = BigInt(receipt.blockNumber);
  const r = await scan(fakeRpc(
    transfers.filter((entry) => entry.address.toLowerCase() === NATIVE_EMITTER),
    transfers.filter((entry) => entry.address.toLowerCase() === ERC20_EMITTER),
  ), block, block);

  const escrow = "0x64ca39fc57315d0d488accac07c37c6e841cd058" as Hex;
  const adapter = "0x73c617e808ed5c7ca41413dfc6ee940ddcbb0b8d" as Hex;
  const feeRecipient = "0xadac7534d3fe868e28c77df5cd930f2635bcb63a" as Hex;
  const worker = "0x092f4483526ebc2476c247cb88d166adb7c3232f" as Hex;
  assert.deepEqual(r.movements.map(({ from, to, value6, via }) => ({ from, to, value6, via })), [
    { from: escrow, to: adapter, value6: 2_000_000n, via: "erc20" },
    { from: adapter, to: feeRecipient, value6: 20_000n, via: "erc20" },
    { from: adapter, to: worker, value6: 1_980_000n, via: "erc20" },
  ]);
  assert.deepEqual(r.anomalies, []);

  const deltas = netDeltas(r.movements);
  assert.equal(deltas.get(escrow), -2_000_000n * SCALE);
  assert.equal(deltas.get(adapter), 0n);
  assert.equal(deltas.get(feeRecipient), 20_000n * SCALE);
  assert.equal(deltas.get(worker), 1_980_000n * SCALE);
  // Transfer flow includes the escrow-to-adapter leg; it is not worker earnings.
  assert.equal(r.stats.canonicalVolume, 4_000_000n * SCALE);
});
