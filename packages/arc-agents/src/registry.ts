/**
 * ERC-8004 agent identity and reputation reader for Arc.
 *
 * Two things make this registry awkward to index the usual way:
 *
 *  1. AgentIdentity is a plain ERC-721 with no `totalSupply()` -- it does not
 *     implement ERC721Enumerable -- so there is no direct way to ask how many
 *     agents exist.
 *  2. Registration happened long before the current chain head. rpc.testnet.arc.io
 *     caps eth_getLogs at 30_000 blocks, so a full log backfill of ~58M blocks
 *     costs ~1_950 requests before you learn anything.
 *
 * Token ids are minted sequentially from 0, so an exponential probe plus a
 * binary search over `ownerOf` finds the registry size in ~40 eth_calls instead.
 *
 * https://docs.arc.io/arc/tutorials/register-your-first-ai-agent
 */
import { Rpc, ARC_TESTNET } from "../../arc-common/rpc.ts";
import {
  encodeCall, encodeUint, encodeAddress, decodeUint, decodeAddress, decodeString,
  wordAt, checksumAddress, type Hex,
} from "../../arc-common/abi.ts";

export const IDENTITY = ARC_TESTNET.erc8004.identity;
export const REPUTATION = ARC_TESTNET.erc8004.reputation;

export interface Agent {
  id: bigint;
  owner: Hex;
  metadataURI: string;
}

export interface AgentMetadata {
  name?: string;
  description?: string;
  agent_type?: string;
  capabilities?: string[];
  version?: string;
  [key: string]: unknown;
}

export interface Reputation {
  agentId: bigint;
  /** Distinct addresses that have attested about this agent. */
  clients: Hex[];
  /** How many of those clients were actually queried for a count. */
  clientsQueried: number;
  /** Total attestations across the queried clients. */
  attestations: number;
  /** True when clients were left unqueried because of maxClients. */
  partial: boolean;
  topClients: { client: Hex; count: number }[];
}

/** Run `jobs` with bounded concurrency, preserving input order. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function decodeAddressArray(data: string): Hex[] {
  const head = Number(decodeUint(data, 0)) / 32;
  const len = Number(decodeUint(data, head));
  return Array.from({ length: len }, (_, i) => ("0x" + wordAt(data, head + 1 + i).slice(24)) as Hex);
}

export async function exists(rpc: Rpc, id: bigint): Promise<boolean> {
  try {
    // ownerOf reverts for an unminted id, which is the only membership test the
    // contract exposes.
    await rpc.ethCall(IDENTITY, encodeCall("ownerOf(uint256)", encodeUint(id)));
    return true;
  } catch {
    return false;
  }
}

export interface CountResult {
  /** Highest minted token id. */
  highestId: bigint;
  /** highestId + 1, since ids start at 0. */
  total: bigint;
  ethCalls: number;
}

/** Exponential probe then binary search for the highest minted token id. */
export async function countAgents(rpc: Rpc): Promise<CountResult> {
  let calls = 0;
  const has = async (id: bigint) => {
    calls++;
    return exists(rpc, id);
  };

  if (!(await has(0n))) return { highestId: -1n, total: 0n, ethCalls: calls };

  let hi = 1n;
  while (await has(hi)) {
    hi *= 2n;
    if (hi > 1n << 40n) throw new Error("registry size probe exceeded 2^40; ids are not sequential");
  }

  let lo = hi / 2n;
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n;
    if (await has(mid)) lo = mid;
    else hi = mid;
  }
  return { highestId: lo, total: lo + 1n, ethCalls: calls };
}

export async function getAgent(rpc: Rpc, id: bigint): Promise<Agent | null> {
  try {
    const [ownerRaw, uriRaw] = await Promise.all([
      rpc.ethCall(IDENTITY, encodeCall("ownerOf(uint256)", encodeUint(id))),
      rpc.ethCall(IDENTITY, encodeCall("tokenURI(uint256)", encodeUint(id))),
    ]);
    return {
      id,
      owner: checksumAddress(decodeAddress(ownerRaw)),
      metadataURI: decodeString(uriRaw),
    };
  } catch {
    return null;
  }
}

export async function listAgents(
  rpc: Rpc,
  from: bigint,
  limit: number,
  concurrency = 8,
): Promise<Agent[]> {
  const ids = Array.from({ length: limit }, (_, i) => from + BigInt(i));
  const agents = await pool(ids, concurrency, (id) => getAgent(rpc, id));
  return agents.filter((a): a is Agent => a !== null);
}

export async function getReputation(
  rpc: Rpc,
  agentId: bigint,
  opts: { concurrency?: number; maxClients?: number } = {},
): Promise<Reputation> {
  // Popular agents have thousands of attesters, and one eth_call per attester
  // trips the public RPC's rate limit, so the fan-out is bounded by default.
  const concurrency = opts.concurrency ?? 4;
  const maxClients = opts.maxClients ?? 100;

  const raw = await rpc.ethCall(REPUTATION, encodeCall("getClients(uint256)", encodeUint(agentId)));
  const clients = decodeAddressArray(raw);
  const queried = clients.slice(0, maxClients);

  const counts = await pool(queried, concurrency, async (client) => {
    const r = await rpc.ethCall(
      REPUTATION,
      encodeCall("getLastIndex(uint256,address)", encodeUint(agentId), encodeAddress(client)),
    );
    return Number(decodeUint(r));
  });

  const topClients = queried
    .map((client, i) => ({ client: checksumAddress(client), count: counts[i] }))
    .sort((a, b) => b.count - a.count);

  return {
    agentId,
    clients,
    clientsQueried: queried.length,
    attestations: counts.reduce((a, b) => a + b, 0),
    partial: queried.length < clients.length,
    topClients,
  };
}

/**
 * Path-style IPFS gateways. cloudflare-ipfs.com is deliberately absent: it was
 * retired in 2024. Override with ARC_IPFS_GATEWAY when the defaults are blocked --
 * several public gateways redirect to a per-CID subdomain, which sandboxed and
 * corporate networks routinely refuse.
 */
export const DEFAULT_IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://trustless-gateway.link/ipfs/",
];

export function ipfsGateways(override?: string): string[] {
  const raw = override ?? process.env.ARC_IPFS_GATEWAY;
  if (!raw) return DEFAULT_IPFS_GATEWAYS;
  return raw.split(",").map((g) => (g.trim().endsWith("/") ? g.trim() : g.trim() + "/"));
}

/**
 * Resolve an agent's metadata document. The JSON at the URI is
 * application-defined, so callers get whatever the agent operator published.
 *
 * Returns null instead of throwing: a listing of 20 agents must not fail because
 * one gateway is unreachable.
 */
export async function resolveMetadata(
  uri: string,
  opts: { timeoutMs?: number; gateway?: string } = {},
): Promise<AgentMetadata | null> {
  if (!uri) return null;
  const timeoutMs = opts.timeoutMs ?? 6000;

  const urls = uri.startsWith("ipfs://")
    ? ipfsGateways(opts.gateway).map((g) => g + uri.slice("ipfs://".length))
    : /^https?:\/\//.test(uri)
      ? [uri]
      : [];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        // A raw-codec CID (bafkrei...) resolves to the file bytes directly, so a
        // trustless gateway can serve it without a redirect to a CID subdomain.
        headers: { accept: "application/json, application/vnd.ipld.raw, */*" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) continue;
      const text = await res.text();
      return JSON.parse(text) as AgentMetadata;
    } catch {
      // Try the next gateway.
    }
  }
  return null;
}
