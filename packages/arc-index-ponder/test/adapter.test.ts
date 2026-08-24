import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arcTestnetChain, arcUsdcContracts, erc20MarkerLookup, isUnmatchableErc20Event,
  movementFromNativeEvent, ARC_TESTNET_CHAIN_ID, ERC20_EMITTER, NATIVE_EMITTER, SCALE, ZERO,
  SAFE_GET_LOGS_RANGE,
  type MovementRow, type PonderTransferEvent,
} from "../src/index.ts";

const A = "0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa";
const B = "0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb";

function evt(from: string, to: string, value: bigint, logIndex = 0, tx = "0xTX"): PonderTransferEvent {
  return {
    args: { from, to, value },
    log: { logIndex, transactionHash: tx },
    block: { number: 100n, timestamp: 1_700_000_000n },
  };
}

test("chain config pins a getLogs range every Arc endpoint accepts", () => {
  const chain = arcTestnetChain();
  assert.equal(chain.id, ARC_TESTNET_CHAIN_ID);
  assert.equal(chain.pollingInterval, 500, "blocks are ~0.5s");
  assert.equal(chain.ws, undefined, "ws is only set when asked for");

  // The default endpoint enforces 30_000 and the dRPC mirror 10_000, so the
  // default has to fit the smallest. The 100_000 quoted in one endpoint's error
  // message is not enforced anywhere and would fail every request.
  assert.equal(chain.ethGetLogsBlockRange, SAFE_GET_LOGS_RANGE);
  assert.equal(SAFE_GET_LOGS_RANGE, 10_000);
  assert.ok(chain.ethGetLogsBlockRange <= 10_000, "must fit the strictest endpoint");

  const custom = arcTestnetChain({
    rpc: ["a", "b"], ws: "wss://x", pollingInterval: 2000, ethGetLogsBlockRange: 30_000,
  });
  assert.deepEqual(custom.rpc, ["a", "b"]);
  assert.equal(custom.ws, "wss://x");
  assert.equal(custom.pollingInterval, 2000);
  assert.equal(custom.ethGetLogsBlockRange, 30_000, "raisable for a permissive endpoint");
});

test("contracts cover both emitters, and the ERC-20 stream is optional", () => {
  const both = arcUsdcContracts({ startBlock: 5 });
  assert.deepEqual(Object.keys(both), ["ArcUsdcNative", "ArcUsdcErc20"]);
  assert.equal(both.ArcUsdcNative.address, NATIVE_EMITTER);
  assert.equal(both.ArcUsdcErc20.address, ERC20_EMITTER);
  assert.equal(both.ArcUsdcNative.chain, "arcTestnet");
  assert.equal(both.ArcUsdcNative.startBlock, 5);

  const nativeOnly = arcUsdcContracts({ includeErc20Markers: false });
  assert.deepEqual(Object.keys(nativeOnly), ["ArcUsdcNative"]);
  assert.equal(nativeOnly.ArcUsdcNative.startBlock, undefined, "omitted, not undefined-valued key");
  assert.ok(!("startBlock" in nativeOnly.ArcUsdcNative));
});

test("a native event becomes exactly one movement row", () => {
  const row: MovementRow = movementFromNativeEvent(evt(A, B, 1_500_000n * SCALE, 3, "0xFeed"));
  assert.equal(row.id, "0xfeed-3");
  assert.equal(row.txHash, "0xfeed");
  assert.equal(row.from, A.toLowerCase());
  assert.equal(row.to, B.toLowerCase());
  assert.equal(row.value, 1_500_000n * SCALE);
  assert.equal(row.value6, 1_500_000n);
  assert.equal(row.via, "native", "rows always start unmarked");
  assert.equal(row.kind, "transfer");
  assert.equal(row.dust, false);
});

test("dust and mint/burn are classified from the native event alone", () => {
  assert.equal(movementFromNativeEvent(evt(A, B, 100n)).dust, true);
  assert.equal(movementFromNativeEvent(evt(A, B, 100n)).value6, 0n);
  assert.equal(movementFromNativeEvent(evt(ZERO, A, SCALE)).kind, "mint");
  assert.equal(movementFromNativeEvent(evt(A, ZERO, SCALE)).kind, "burn");
});

test("the marker lookup scales the ERC-20 amount up to native precision", () => {
  const lookup = erc20MarkerLookup(evt(A, B, 2_000_000n, 4, "0xFeed"));
  assert.equal(lookup.txHash, "0xfeed");
  assert.equal(lookup.value, 2_000_000n * SCALE);
  assert.equal(lookup.from, A.toLowerCase());
  assert.equal(lookup.via, "native", "only unmarked rows are candidates");
});

test("a native row and its ERC-20 marker agree on every matched field", () => {
  const six = 750_000n;
  const row = movementFromNativeEvent(evt(A, B, six * SCALE, 2, "0xFeed"));
  const lookup = erc20MarkerLookup(evt(A, B, six, 3, "0xFeed"));

  assert.equal(row.txHash, lookup.txHash);
  assert.equal(row.from, lookup.from);
  assert.equal(row.to, lookup.to);
  assert.equal(row.value, lookup.value);
  assert.equal(row.via, lookup.via);
});

test("unmatchable ERC-20 events are the ones the native emitter omits", () => {
  assert.equal(isUnmatchableErc20Event(evt(A, B, 0n)), true, "zero value");
  assert.equal(isUnmatchableErc20Event(evt(A, A, 500_000n)), true, "self-transfer");
  assert.equal(isUnmatchableErc20Event(evt(A, A.toLowerCase(), 500_000n)), true, "case-insensitive");
  assert.equal(isUnmatchableErc20Event(evt(A, B, 500_000n)), false);
});

/**
 * The Ponder recipe is insert-then-mark, so the ordering rule has to hold for
 * repeated identical transfers. This replays the example handler's query against
 * an in-memory table.
 */
test("repeated identical transfers pair in log order", () => {
  const six = 1_000_000n;
  const rows = [
    movementFromNativeEvent(evt(A, B, six * SCALE, 0, "0xFeed")),
    movementFromNativeEvent(evt(A, B, six * SCALE, 5, "0xFeed")),
  ];

  const mark = (event: PonderTransferEvent) => {
    const l = erc20MarkerLookup(event);
    const target = rows
      .filter((r) => r.txHash === l.txHash && r.from === l.from && r.to === l.to &&
        r.value === l.value && r.via === l.via)
      .sort((a, b) => a.logIndex - b.logIndex)[0];
    if (target) target.via = "erc20";
    return target;
  };

  assert.equal(mark(evt(A, B, six, 1, "0xFeed"))?.logIndex, 0);
  assert.equal(mark(evt(A, B, six, 6, "0xFeed"))?.logIndex, 5);
  assert.deepEqual(rows.map((r) => r.via), ["erc20", "erc20"]);

  // A third marker has nothing left to claim, which is the anomaly signal.
  assert.equal(mark(evt(A, B, six, 9, "0xFeed")), undefined);
});

test("a marker never claims a row from another transaction", () => {
  const six = 1_000_000n;
  const row = movementFromNativeEvent(evt(A, B, six * SCALE, 0, "0xAAA"));
  const lookup = erc20MarkerLookup(evt(A, B, six, 1, "0xBBB"));
  assert.notEqual(row.txHash, lookup.txHash);
});
