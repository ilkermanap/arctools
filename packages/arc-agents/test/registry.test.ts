import { test } from "node:test";
import assert from "node:assert/strict";
import { Rpc } from "../../arc-common/rpc.ts";
import { selector } from "../../arc-common/abi.ts";
import {
  countAgents, exists, getAgent, getReputation, listAgents, pool,
  DEFAULT_IPFS_GATEWAYS, ipfsGateways, resolveMetadata,
} from "../src/registry.ts";

const OWNER_OF = selector("ownerOf(uint256)");
const TOKEN_URI = selector("tokenURI(uint256)");
const GET_CLIENTS = selector("getClients(uint256)");
const GET_LAST_INDEX = selector("getLastIndex(uint256,address)");

const word = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
const uintArg = (data: string, index = 0) =>
  BigInt("0x" + data.replace(/^0x/, "").slice(8 + index * 64, 8 + (index + 1) * 64));

function encodeString(s: string): string {
  const bytes = Buffer.from(s, "utf8");
  return (
    word("20") +
    word(bytes.length.toString(16)) +
    bytes.toString("hex").padEnd(Math.ceil(bytes.length / 32) * 64, "0")
  );
}

function encodeAddressArray(addrs: string[]): string {
  return (
    "0x" + word("20") + word(addrs.length.toString(16)) + addrs.map((a) => word(a)).join("")
  );
}

/** An Rpc whose eth_call is answered from a fixture, with a call counter. */
function fakeRpc(handler: (to: string, data: string) => string | null): Rpc & { calls: number } {
  const rpc = new Rpc("http://fake") as Rpc & { calls: number };
  rpc.calls = 0;
  // @ts-ignore -- narrowing the surface under test.
  rpc.ethCall = async (to: string, data: string) => {
    rpc.calls++;
    const result = handler(to, data);
    if (result === null) throw new Error("execution reverted");
    return result;
  };
  return rpc;
}

/** The canonical EIP-55 test vector, so checksumming is actually exercised. */
const OWNER_LOWER = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const OWNER_CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

/** A registry holding ids 0..highest, as the real AgentIdentity behaves. */
function registryOf(highest: bigint, uris: Record<string, string> = {}) {
  return fakeRpc((_to, data) => {
    const fn = data.slice(0, 10);
    const id = uintArg(data);
    if (fn === OWNER_OF) {
      if (id > highest) return null; // ownerOf reverts for an unminted id
      return "0x" + word(OWNER_LOWER);
    }
    if (fn === TOKEN_URI) {
      if (id > highest) return null;
      return "0x" + encodeString(uris[String(id)] ?? "");
    }
    return null;
  });
}

test("pool runs with bounded concurrency and preserves input order", async () => {
  let active = 0;
  let peak = 0;
  const out = await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(peak <= 3, `concurrency peaked at ${peak}`);
});

test("pool handles fewer items than workers", async () => {
  assert.deepEqual(await pool([1], 8, async (n) => n), [1]);
  assert.deepEqual(await pool([], 8, async (n) => n), []);
});

test("exists maps a revert to false, not an error", async () => {
  const rpc = registryOf(5n);
  assert.equal(await exists(rpc, 0n), true);
  assert.equal(await exists(rpc, 5n), true);
  assert.equal(await exists(rpc, 6n), false);
});

test("countAgents binary-searches the highest minted id", async () => {
  for (const highest of [0n, 1n, 2n, 7n, 8n, 9n, 1000n, 885_422n]) {
    const rpc = registryOf(highest);
    const r = await countAgents(rpc);
    assert.equal(r.highestId, highest, `highest=${highest}`);
    assert.equal(r.total, highest + 1n);
    assert.equal(r.ethCalls, rpc.calls);
  }
});

test("countAgents costs far fewer calls than a linear scan", async () => {
  const rpc = registryOf(885_422n);
  const r = await countAgents(rpc);
  // Exponential probe (~20) plus binary search (~20).
  assert.ok(r.ethCalls < 50, `took ${r.ethCalls} calls`);
});

test("an empty registry reports zero rather than guessing", async () => {
  const rpc = fakeRpc(() => null);
  const r = await countAgents(rpc);
  assert.equal(r.total, 0n);
  assert.equal(r.highestId, -1n);
});

test("getAgent returns a checksummed owner and the metadata URI", async () => {
  const rpc = registryOf(3n, { "2": "ipfs://bafyfixture" });
  const agent = await getAgent(rpc, 2n);
  assert.ok(agent);
  assert.equal(agent.id, 2n);
  assert.equal(agent.metadataURI, "ipfs://bafyfixture");
  // The RPC returns a lowercase address; getAgent must checksum it per EIP-55.
  assert.equal(agent.owner, OWNER_CHECKSUMMED);
});

test("getAgent returns null for an unminted id instead of throwing", async () => {
  assert.equal(await getAgent(registryOf(3n), 99n), null);
});

test("listAgents skips ids past the end of the registry", async () => {
  const agents = await listAgents(registryOf(4n), 3n, 5);
  assert.deepEqual(agents.map((a) => a.id), [3n, 4n]);
});

test("getReputation sums attestations across clients", async () => {
  const clients = [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
  ];
  const counts: Record<string, bigint> = { [clients[0]]: 18n, [clients[1]]: 2n };

  const rpc = fakeRpc((_to, data) => {
    if (data.slice(0, 10) === GET_CLIENTS) return encodeAddressArray(clients);
    if (data.slice(0, 10) === GET_LAST_INDEX) {
      const addr = "0x" + data.slice(-40);
      return "0x" + word(counts[addr].toString(16));
    }
    return null;
  });

  const rep = await getReputation(rpc, 7n);
  assert.equal(rep.clients.length, 2);
  assert.equal(rep.clientsQueried, 2);
  assert.equal(rep.attestations, 20);
  assert.equal(rep.partial, false);
  assert.deepEqual(rep.topClients.map((c) => c.count), [18, 2], "sorted by count");
});

test("getReputation caps the fan-out and says the result is partial", async () => {
  const clients = Array.from(
    { length: 300 },
    (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0"),
  );
  const rpc = fakeRpc((_to, data) =>
    data.slice(0, 10) === GET_CLIENTS ? encodeAddressArray(clients) : "0x" + word("1"),
  );

  const rep = await getReputation(rpc, 1n, { maxClients: 25 });
  assert.equal(rep.clients.length, 300, "the full client list is still reported");
  assert.equal(rep.clientsQueried, 25);
  assert.equal(rep.attestations, 25);
  assert.equal(rep.partial, true);
});

test("an agent with no attestations is not an error", async () => {
  const rpc = fakeRpc(() => encodeAddressArray([]));
  const rep = await getReputation(rpc, 1n);
  assert.deepEqual(rep.clients, []);
  assert.equal(rep.attestations, 0);
  assert.equal(rep.partial, false);
});

test("ipfsGateways honours an override and normalises trailing slashes", () => {
  assert.deepEqual(ipfsGateways(), DEFAULT_IPFS_GATEWAYS);
  assert.deepEqual(ipfsGateways("https://a.example/ipfs"), ["https://a.example/ipfs/"]);
  assert.deepEqual(ipfsGateways("https://a.example/ipfs/, https://b.example/ipfs/"), [
    "https://a.example/ipfs/",
    "https://b.example/ipfs/",
  ]);
});

test("the retired cloudflare-ipfs gateway is not a default", () => {
  assert.ok(!DEFAULT_IPFS_GATEWAYS.some((g) => g.includes("cloudflare-ipfs.com")));
});

test("resolveMetadata returns null for an empty or unsupported URI", async () => {
  assert.equal(await resolveMetadata(""), null);
  assert.equal(await resolveMetadata("ar://something"), null);
});

test("resolveMetadata falls through to the next gateway on failure", async () => {
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    if (seen.length === 1) throw new Error("network down");
    return new Response(JSON.stringify({ name: "Agent" }), { status: 200 });
  }) as typeof fetch;

  try {
    const meta = await resolveMetadata("ipfs://bafycid", {
      gateway: "https://a.example/ipfs/,https://b.example/ipfs/",
    });
    assert.deepEqual(meta, { name: "Agent" });
    assert.deepEqual(seen, ["https://a.example/ipfs/bafycid", "https://b.example/ipfs/bafycid"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("resolveMetadata returns null rather than throwing when every gateway fails", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
  try {
    assert.equal(await resolveMetadata("ipfs://bafycid", { gateway: "https://a.example/ipfs/" }), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});
