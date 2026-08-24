/** JSON API handlers. Each returns a plain object; the server serialises it. */
import { Rpc, ARC_TESTNET } from "../../arc-common/rpc.ts";
import { formatUnits, type Hex } from "../../arc-common/abi.ts";
import { scan } from "../../arc-index/src/movements.ts";
import { reconcile } from "../../arc-index/src/reconcile.ts";
import { countAgents, getAgent, getReputation, listAgents } from "../../arc-agents/src/registry.ts";
import { lintSource } from "../../arc-lint/src/engine.ts";
import { RULES, type Lang } from "../../arc-lint/src/rules.ts";
import type { Cache } from "./cache.ts";
import type { DocIndex } from "./docs.ts";

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}

/** BigInt is not JSON-serialisable, so every numeric field crosses as a string. */
export function jsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

function intParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
  max: number,
  min = 1,
): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new HttpError(400, `${name} must be an integer >= ${min}`);
  }
  if (n > max) throw new HttpError(400, `${name} must be <= ${max}`);
  return n;
}

function addressParam(params: URLSearchParams, name: string): Hex {
  const raw = params.get(name);
  if (!raw) throw new HttpError(400, `${name} is required`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new HttpError(400, `${name} is not an address`);
  return raw.toLowerCase() as Hex;
}

export interface Deps {
  rpc: Rpc;
  cache: Cache;
  docs: DocIndex;
}

export const routes: Record<
  string,
  (params: URLSearchParams, deps: Deps, body: unknown) => Promise<unknown>
> = {
  "/api/health": async (_p, { cache, docs }) => ({
    ok: true,
    network: ARC_TESTNET.name,
    chainId: ARC_TESTNET.chainId,
    docPages: docs.pages.length,
    cacheEntries: cache.size,
  }),

  "/api/chain": (_p, { rpc, cache }) =>
    cache.wrap("chain", 4_000, async () => {
      const [chainId, head, gasPrice] = await Promise.all([
        rpc.chainId(),
        rpc.blockNumber(),
        rpc.gasPrice(),
      ]);
      return jsonSafe({
        chainId,
        expectedChainId: ARC_TESTNET.chainId,
        head,
        gasPriceWei: gasPrice,
        gasPriceGwei: formatUnits(gasPrice, 9),
        minBaseFeeGwei: ARC_TESTNET.minBaseFeeGwei,
        rpcUrl: rpc.url,
        explorer: ARC_TESTNET.explorer,
      });
    }),

  "/api/index/scan": (params, { rpc, cache }) => {
    const blocks = intParam(params, "blocks", 150, 5_000);
    return cache.wrap(`scan:${blocks}`, 12_000, async () => {
      const head = await rpc.blockNumber();
      const result = await scan(rpc, head - BigInt(blocks) + 1n, head);
      // The full movement list can run to thousands of rows; the dashboard only
      // renders a sample, so cap what crosses the wire.
      return jsonSafe({
        ...result,
        movements: result.movements.slice(-50).reverse(),
        movementsTotal: result.movements.length,
      });
    });
  },

  "/api/index/reconcile": (params, { rpc, cache }) => {
    const address = addressParam(params, "address");
    const blocks = intParam(params, "blocks", 100, 5_000);
    return cache.wrap(`rec:${address}:${blocks}`, 12_000, async () => {
      const head = await rpc.blockNumber();
      return jsonSafe(await reconcile(rpc, address, head - BigInt(blocks) + 1n, head));
    });
  },

  "/api/agents/count": (_p, { rpc, cache }) =>
    // The registry only grows, and the probe costs ~41 eth_calls, so cache hard.
    cache.wrap("agents:count", 300_000, async () => jsonSafe(await countAgents(rpc))),

  "/api/agents/list": (params, { rpc, cache }) => {
    const from = BigInt(intParam(params, "from", 0, 100_000_000, 0));
    const limit = intParam(params, "limit", 20, 100);
    return cache.wrap(`agents:${from}:${limit}`, 60_000, async () =>
      jsonSafe(await listAgents(rpc, from, limit)),
    );
  },

  "/api/agents/show": (params, { rpc, cache }) => {
    const id = BigInt(intParam(params, "id", 0, 100_000_000, 0));
    return cache.wrap(`agent:${id}`, 60_000, async () => {
      const agent = await getAgent(rpc, id);
      if (!agent) throw new HttpError(404, `agent #${id} is not registered`);
      const reputation = await getReputation(rpc, id, { maxClients: 50 });
      return jsonSafe({ ...agent, reputation });
    });
  },

  "/api/lint/rules": async () =>
    RULES.map((r) => ({
      id: r.id,
      severity: r.severity,
      langs: r.langs,
      title: r.title,
      detail: r.detail,
      doc: r.doc,
    })),

  "/api/lint": async (_params, _deps, body) => {
    const input = body as { source?: unknown; lang?: unknown; filename?: unknown } | null;
    if (!input || typeof input.source !== "string") {
      throw new HttpError(400, "body must be JSON with a `source` string");
    }
    if (input.source.length > 2_000_000) throw new HttpError(413, "source exceeds 2 MB");

    const lang: Lang =
      input.lang === "script" || input.lang === "solidity"
        ? input.lang
        : typeof input.filename === "string" && input.filename.endsWith(".sol")
          ? "solidity"
          : "solidity";

    const filename = typeof input.filename === "string" ? input.filename : `input.${lang === "solidity" ? "sol" : "ts"}`;
    const findings = lintSource(input.source, filename, lang);
    return {
      filename,
      lang,
      findings,
      counts: {
        error: findings.filter((f) => f.severity === "error").length,
        warning: findings.filter((f) => f.severity === "warning").length,
        info: findings.filter((f) => f.severity === "info").length,
      },
    };
  },

  "/api/docs/sites": async (_p, { docs }) => docs.sites,

  "/api/docs/list": async (params, { docs }) => docs.list(params.get("site") ?? undefined),

  "/api/docs/search": async (params, { docs }) => {
    const q = params.get("q");
    if (!q || q.trim().length < 2) throw new HttpError(400, "q must be at least 2 characters");
    return { query: q, hits: docs.search(q, intParam(params, "limit", 20, 100)) };
  },

  "/api/docs/page": async (params, { docs }) => {
    const site = params.get("site");
    const path = params.get("path");
    if (!site || !path) throw new HttpError(400, "site and path are required");
    const page = docs.get(site, path);
    if (!page) throw new HttpError(404, `no page ${site}/${path}`);
    return page;
  },
};
