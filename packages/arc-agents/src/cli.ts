#!/usr/bin/env node
import { Rpc, ARC_TESTNET } from "../../arc-common/rpc.ts";
import type { Hex } from "../../arc-common/abi.ts";
import {
  countAgents, getAgent, getReputation, listAgents, resolveMetadata, pool,
} from "./registry.ts";

const USAGE = `arc-agents -- read the ERC-8004 agent registry on Arc

Usage:
  arc-agents count
  arc-agents list [--from N] [--limit N] [--resolve]
  arc-agents show <id> [--resolve]
  arc-agents reputation <id> [--limit N] [--max-clients N]

The AgentIdentity contract is a plain ERC-721 with no totalSupply(). Counting by
replaying registration logs means backfilling the chain's whole history at a 30k
block cap, so this probes state instead: O(log n) calls rather than O(blocks).

Options:
  --from N     First token id (default 0)
  --limit N    Rows to read (default 20)
  --resolve    Fetch metadata JSON from IPFS/HTTP
  --gateway U  IPFS gateway base URL (or set ARC_IPFS_GATEWAY, comma-separated)
  --max-clients N  Attesters to query (default 100; the public RPC rate-limits)
  --rpc URL    Override RPC endpoint
  --json       Machine-readable output
`;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const jsonSafe = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }

  const json = argv.includes("--json");
  const resolve = argv.includes("--resolve");
  const gateway = arg(argv, "gateway");
  const rpc = new Rpc(arg(argv, "rpc") ?? ARC_TESTNET.rpcUrl);
  await rpc.assertArc();

  if (cmd === "count") {
    const r = await countAgents(rpc);
    if (json) return console.log(jsonSafe(r)), 0;
    console.log(`\nERC-8004 AgentIdentity  ${ARC_TESTNET.erc8004.identity}\n`);
    console.log(`  registered agents   ${r.total}`);
    console.log(`  highest token id    ${r.highestId}`);
    console.log(`  cost                ${r.ethCalls} eth_calls`);
    console.log(`\n  ${ARC_TESTNET.explorer}/address/${ARC_TESTNET.erc8004.identity}`);
    return 0;
  }

  if (cmd === "list") {
    const from = BigInt(arg(argv, "from") ?? "0");
    const limit = Number(arg(argv, "limit") ?? "20");
    const agents = await listAgents(rpc, from, limit);

    const meta = resolve
      ? await pool(agents, 6, (a) => resolveMetadata(a.metadataURI, { gateway }))
      : agents.map(() => null);

    if (json) {
      return console.log(jsonSafe(agents.map((a, i) => ({ ...a, metadata: meta[i] })))), 0;
    }

    console.log(`\nAgents ${from}..${from + BigInt(limit) - 1n}  (${agents.length} minted)\n`);
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const name = meta[i]?.name ?? (resolve ? "<metadata unavailable>" : "");
      console.log(`  #${String(a.id).padEnd(8)} ${a.owner}  ${name}`);
      if (a.metadataURI) console.log(`  ${" ".repeat(9)} ${a.metadataURI}`);
    }
    if (resolve) {
      const missing = meta.filter((m) => m === null).length;
      if (missing) {
        console.log(`\n  ${missing} of ${agents.length} metadata documents did not resolve.`);
        console.log(`  Set ARC_IPFS_GATEWAY or pass --gateway if IPFS egress is blocked here.`);
      }
    }
    return 0;
  }

  if (cmd === "show") {
    const id = argv[1];
    if (!id || id.startsWith("-")) {
      console.error("arc-agents show: an agent id is required");
      return 2;
    }
    const agent = await getAgent(rpc, BigInt(id));
    if (!agent) {
      console.error(`arc-agents: agent #${id} is not registered`);
      return 1;
    }
    const [rep, meta] = await Promise.all([
      getReputation(rpc, agent.id, { maxClients: Number(arg(argv, "max-clients") ?? "100") }),
      resolve ? resolveMetadata(agent.metadataURI, { gateway }) : Promise.resolve(null),
    ]);
    if (json) return console.log(jsonSafe({ ...agent, metadata: meta, reputation: rep })), 0;

    console.log(`\nAgent #${agent.id}\n`);
    console.log(`  owner          ${agent.owner}`);
    console.log(`  metadata URI   ${agent.metadataURI || "<none>"}`);
    console.log(
      `  attestations   ${rep.attestations}${rep.partial ? "+" : ""} from ${rep.clients.length} distinct clients` +
        (rep.partial ? `  (counted ${rep.clientsQueried})` : ""),
    );
    if (meta) {
      console.log(`\n  name           ${meta.name ?? "-"}`);
      console.log(`  type           ${meta.agent_type ?? "-"}`);
      console.log(`  version        ${meta.version ?? "-"}`);
      if (meta.description) console.log(`  description    ${meta.description}`);
      if (meta.capabilities?.length) console.log(`  capabilities   ${meta.capabilities.join(", ")}`);
    } else if (resolve) {
      console.log(`\n  metadata did not resolve (gateway unreachable or document missing)`);
    }
    console.log(`\n  ${ARC_TESTNET.explorer}/token/${ARC_TESTNET.erc8004.identity}/instance/${agent.id}`);
    return 0;
  }

  if (cmd === "reputation") {
    const id = argv[1];
    if (!id || id.startsWith("-")) {
      console.error("arc-agents reputation: an agent id is required");
      return 2;
    }
    const limit = Number(arg(argv, "limit") ?? "10");
    const rep = await getReputation(rpc, BigInt(id), {
      maxClients: Number(arg(argv, "max-clients") ?? "100"),
    });
    if (json) return console.log(jsonSafe(rep)), 0;

    console.log(`\nReputation for agent #${rep.agentId}\n`);
    console.log(`  distinct clients   ${rep.clients.length}`);
    console.log(`  attestations       ${rep.attestations}${rep.partial ? "+" : ""}`);
    if (rep.partial) {
      console.log(`  counted            ${rep.clientsQueried} of ${rep.clients.length} clients`);
      console.log(`                     raise with --max-clients ${rep.clients.length}`);
    }
    if (rep.clients.length === 0) {
      console.log(`\n  no attestations recorded`);
      return 0;
    }
    console.log(`\n  top attesters`);
    for (const { client, count } of rep.topClients.slice(0, limit)) {
      console.log(`    ${String(count).padStart(4)}x  ${client}`);
    }
    console.log(`\n  Note: per-attestation scores need the canonical ERC-8004`);
    console.log(`  ReputationRegistry ABI, which Arc's docs do not publish.`);
    return 0;
  }

  console.error(`arc-agents: unknown command "${cmd}"`);
  return 2;
}

// Never process.exit() here: it can truncate a large --json write to a pipe.
process.exitCode = await main(process.argv.slice(2));
