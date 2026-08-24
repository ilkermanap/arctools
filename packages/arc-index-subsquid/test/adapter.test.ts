import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arcUsdcLogRequest, movementId, movementsFromBatch, toRows,
  ERC20_EMITTER, NATIVE_EMITTER, SCALE, TRANSFER_TOPIC,
  type SqdBlock, type SqdLog,
} from "../src/index.ts";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

const pad = (a: string) => "0x" + a.slice(2).padStart(64, "0");
const hex = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");

let seq = 0;
function log(emitter: string, from: string, to: string, value: bigint, tx = "0xAA"): SqdLog {
  return {
    address: emitter,
    topics: [TRANSFER_TOPIC, pad(from), pad(to)],
    data: hex(value),
    logIndex: seq++,
    transactionHash: tx,
  };
}
const block = (height: number, logs: SqdLog[]): SqdBlock => ({ header: { height }, logs });

test("one addLog request covers both emitters", () => {
  const req = arcUsdcLogRequest();
  assert.deepEqual(req.address, [NATIVE_EMITTER, ERC20_EMITTER]);
  assert.deepEqual(req.topic0, [TRANSFER_TOPIC]);
});

test("an ERC-20 transfer in a batch yields one movement", () => {
  seq = 0;
  const six = 2_500_000n;
  const r = movementsFromBatch([
    block(100, [log(NATIVE_EMITTER, A, B, six * SCALE), log(ERC20_EMITTER, A, B, six)]),
  ]);

  assert.equal(r.movements.length, 1);
  assert.equal(r.movements[0].via, "erc20");
  assert.equal(r.movements[0].value, six * SCALE);
  assert.equal(r.stats.naiveRecords, 2);
  assert.deepEqual(r.anomalies, []);
  assert.deepEqual(r.incomplete, []);
});

test("block range is derived from the batch, in any order", () => {
  seq = 0;
  const r = movementsFromBatch([
    block(120, [log(NATIVE_EMITTER, A, B, SCALE)]),
    block(101, [log(NATIVE_EMITTER, B, A, SCALE)]),
  ]);
  assert.equal(r.fromBlock, 101);
  assert.equal(r.toBlock, 120);
  assert.equal(r.movements.length, 2);
  // Movements come back in chain order regardless of batch ordering.
  assert.deepEqual(r.movements.map((m) => Number(m.blockNumber)), [101, 120]);
});

test("an empty batch is not an error", () => {
  const r = movementsFromBatch([]);
  assert.deepEqual(r.movements, []);
  assert.equal(r.fromBlock, 0);
  assert.equal(r.toBlock, 0);
  assert.equal(r.stats.canonicalVolume, 0n);
});

test("logs missing selected fields are reported, not silently dropped", () => {
  seq = 0;
  const bad: SqdLog = { logIndex: 7, address: NATIVE_EMITTER };
  const r = movementsFromBatch([block(100, [bad])]);

  assert.equal(r.movements.length, 0);
  assert.equal(r.incomplete.length, 1);
  assert.equal(r.incomplete[0].height, 100);
  assert.deepEqual(r.incomplete[0].missing, ["topics", "data", "transactionHash"]);
});

test("unrelated contracts and events are ignored", () => {
  seq = 0;
  const other = log("0x9999999999999999999999999999999999999999", A, B, SCALE);
  const wrongTopic: SqdLog = { ...log(NATIVE_EMITTER, A, B, SCALE), topics: ["0xdeadbeef", pad(A), pad(B)] };
  const r = movementsFromBatch([block(100, [other, wrongTopic])]);

  assert.equal(r.movements.length, 0);
  assert.deepEqual(r.incomplete, [], "a filtered-out log is not incomplete");
});

test("movement ids are stable and unique per native log", () => {
  seq = 0;
  const v = 1_000_000n;
  const r = movementsFromBatch([
    block(100, [
      log(NATIVE_EMITTER, A, B, v * SCALE),
      log(NATIVE_EMITTER, A, B, v * SCALE),
    ]),
  ]);
  const ids = r.movements.map(movementId);
  assert.equal(new Set(ids).size, 2, "identical transfers still get distinct ids");
  assert.match(ids[0], /^0xaa-\d+$/);
});

test("toRows preserves bigints for the store layer", () => {
  seq = 0;
  const r = movementsFromBatch([block(100, [log(NATIVE_EMITTER, A, B, 3n * SCALE)])]);
  const [row] = toRows(r);
  assert.equal(typeof row.value, "bigint");
  assert.equal(typeof row.blockNumber, "bigint");
  assert.equal(row.via, "native");
  assert.equal(row.from, A.toLowerCase());
});

test("self-transfers in a batch produce no movement and no anomaly", () => {
  seq = 0;
  const r = movementsFromBatch([block(100, [log(ERC20_EMITTER, A, A, 400_000n)])]);
  assert.equal(r.movements.length, 0);
  assert.equal(r.stats.selfTransferLogs, 1);
  assert.deepEqual(r.anomalies, []);
});

test("a value-moving ERC-20 log with no native pair is an anomaly with its position", () => {
  seq = 0;
  const r = movementsFromBatch([block(100, [log(ERC20_EMITTER, A, B, 9_000_000n)])]);
  assert.equal(r.anomalies.length, 1);
  assert.equal(r.anomalies[0].logIndex, 0);
  assert.match(r.anomalies[0].reason, /no native counterpart/);
});
