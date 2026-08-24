#!/usr/bin/env node
import { Rpc, ARC_TESTNET } from "../../arc-common/rpc.ts";
import { formatUnits, type Hex } from "../../arc-common/abi.ts";
import { scan, netDeltas, SCALE } from "./movements.ts";
import { reconcile } from "./reconcile.ts";

const USAGE = `arc-index -- dual-emitter-safe USDC indexing for Arc

Usage:
  arc-index scan [--blocks N] [--from B] [--to B] [--json]
  arc-index reconcile --address 0x... [--blocks N] [--json]
  arc-index top [--blocks N] [--limit N]

Arc logs every USDC movement twice when it goes through the ERC-20 interface:
once from the native system emitter (18 decimals) and once from the ERC-20
contract (6 decimals). Indexing "Transfer" by topic alone double-counts.
See https://docs.arc.io/arc/references/usdc-system-events

Options:
  --blocks N     Window size ending at head (default 200)
  --from B       Explicit start block
  --to B         Explicit end block (default head)
  --address A    Address to reconcile
  --limit N      Rows to print (default 10)
  --rpc URL      Override RPC endpoint
  --json         Machine-readable output
`;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const usdc = (v: bigint) => `${formatUnits(v, 18)} USDC`;

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }

  const json = argv.includes("--json");
  const rpc = new Rpc(arg(argv, "rpc") ?? ARC_TESTNET.rpcUrl);
  await rpc.assertArc();

  const head = await rpc.blockNumber();
  const to = arg(argv, "to") ? BigInt(arg(argv, "to")!) : head;
  const span = BigInt(arg(argv, "blocks") ?? "200");
  const from = arg(argv, "from") ? BigInt(arg(argv, "from")!) : to - span + 1n;

  if (cmd === "scan" || cmd === "top") {
    const result = await scan(rpc, from, to);
    const { stats } = result;

    if (json) {
      console.log(
        JSON.stringify(
          result,
          (_k, v) => (typeof v === "bigint" ? v.toString() : v),
          2,
        ),
      );
      return result.anomalies.length ? 1 : 0;
    }

    if (cmd === "top") {
      const limit = Number(arg(argv, "limit") ?? "10");
      const ranked = [...netDeltas(result.movements)].sort((a, b) =>
        b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0,
      );
      console.log(`\nNet USDC flow, blocks ${from}..${to}\n`);
      for (const [address, delta] of ranked.slice(0, limit)) {
        console.log(`  +${usdc(delta).padStart(24)}  ${address}`);
      }
      console.log("  ...");
      for (const [address, delta] of ranked.slice(-limit)) {
        console.log(`  ${usdc(delta).padStart(25)}  ${address}`);
      }
      return 0;
    }

    const pct = (part: number, whole: number) =>
      whole === 0 ? "0.0" : ((part / whole - 1) * 100).toFixed(1);
    const volPct = stats.canonicalVolume > 0n
      ? (Number((stats.doubleCountedVolume * 1000n) / stats.canonicalVolume) / 10 - 100).toFixed(1)
      : "0.0";

    console.log(`\nArc USDC movements, blocks ${from}..${to} (${to - from + 1n} blocks)\n`);
    console.log(`  raw logs`);
    console.log(`    native emitter (18 dec)   ${stats.nativeLogs}`);
    console.log(`    ERC-20 emitter (6 dec)    ${stats.erc20Logs}`);
    console.log(`\n  canonical movements         ${result.movements.length}`);
    console.log(`    initiated via ERC-20      ${stats.erc20Movements}  (logged twice by the chain)`);
    console.log(`    plain native sends        ${stats.nativeOnlyMovements}  (logged once)`);
    console.log(`    sub-6-decimal dust        ${stats.dustMovements}  (invisible to balanceOf)`);
    console.log(`\n  ERC-20 logs the native emitter deliberately omits`);
    console.log(`    self-transfers            ${stats.selfTransferLogs}  (from == to, no balance change)`);
    console.log(`    zero-value                ${stats.zeroValueLogs}`);
    console.log(`\n  what a naive indexer gets wrong`);
    console.log(`    transfer rows             ${stats.naiveRecords} vs ${result.movements.length} real  (+${pct(stats.naiveRecords, result.movements.length)}% phantom rows)`);
    console.log(`    volume, no dedup          ${usdc(stats.doubleCountedVolume)}  (+${volPct}%)`);
    console.log(`    volume, canonical         ${usdc(stats.canonicalVolume)}`);

    if (result.anomalies.length) {
      console.log(`\n  anomalies (${result.anomalies.length})`);
      for (const a of result.anomalies.slice(0, 5)) {
        console.log(`    ${a.txHash}\n      ${a.reason}`);
      }
      return 1;
    }
    console.log(`\n  ✓ every value-moving ERC-20 log paired with its native log`);
    return 0;
  }

  if (cmd === "reconcile") {
    const address = arg(argv, "address");
    if (!address) {
      console.error("arc-index reconcile: --address is required");
      return 2;
    }
    const r = await reconcile(rpc, address as Hex, from, to);
    if (json) {
      console.log(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      return r.verdict === "mismatch" ? 1 : 0;
    }

    console.log(`\nReconciling ${r.address}, blocks ${r.fromBlock}..${r.toBlock}\n`);
    console.log(`  balance before   ${usdc(r.balanceBefore)}`);
    console.log(`  balance after    ${usdc(r.balanceAfter)}`);
    console.log(`  actual delta     ${usdc(r.actualDelta)}   (eth_getBalance)`);
    console.log(`  indexed delta    ${usdc(r.indexedDelta)}   (${r.movementCount} movements)`);
    console.log(`  residual         ${usdc(r.residual)}`);
    console.log(`  ERC-20 view      ${formatUnits(r.balanceAfter / SCALE, 6)} USDC   (6 dec, truncated)`);
    console.log("");
    if (r.verdict === "exact") {
      console.log("  ✓ exact: every wei of movement is accounted for by logs");
    } else if (r.verdict === "fees-only") {
      console.log(`  ✓ ${usdc(-r.residual)} left without a log -- consistent with gas fees,`);
      console.log("    which EIP-7708 does not emit a Transfer for");
    } else {
      console.log("  ✗ mismatch: value arrived that no log explains. The index is incomplete.");
      return 1;
    }
    return 0;
  }

  console.error(`arc-index: unknown command "${cmd}"`);
  return 2;
}

// Never process.exit() here: it tears down the process before a large --json
// write to a pipe has flushed, silently truncating the output.
process.exitCode = await main(process.argv.slice(2));
