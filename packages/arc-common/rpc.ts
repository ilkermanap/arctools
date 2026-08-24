// Tiny JSON-RPC client for Arc. Uses global fetch (Node 18+), no dependencies.
import type { Hex } from "./abi.ts";

export const ARC_TESTNET = {
  name: "Arc Testnet",
  chainId: 5042002,
  rpcUrl: "https://rpc.testnet.arc.io",
  wsUrl: "wss://rpc.testnet.arc.io",
  explorer: "https://testnet.arcscan.app",
  faucet: "https://faucet.circle.com",
  /** USDC is the native gas token; this is its built-in ERC-20 interface. */
  usdc: "0x3600000000000000000000000000000000000000" as Hex,
  eurc: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as Hex,
  usyc: "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C" as Hex,
  /** Native gas accounting uses 18 decimals; the ERC-20 view truncates to 6. */
  nativeDecimals: 18,
  erc20Decimals: 6,
  minBaseFeeGwei: 20,
  erc8004: {
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Hex,
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713" as Hex,
    validation: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272" as Hex,
  },
  erc8183: "0x0747EEf0706327138c69792bF28Cd525089e4583" as Hex,
  memo: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505" as Hex,
  multicall3From: "0x522fAf9A91c41c443c66765030741e4AaCe147D0" as Hex,
  fxEscrow: "0xd68256f4D69C6BbEcB873D8588AE0Dc6B8E22E10" as Hex,
} as const;

export interface Log {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  removed?: boolean;
}

export class RpcError extends Error {
  code: number;

  constructor(code: number, message: string) {
    super(`RPC ${code}: ${message}`);
    this.code = code;
    this.name = "RpcError";
  }
}

// Node's strip-only TypeScript mode rejects parameter properties and enums, so
// every class in this repo declares its fields explicitly. Keeping that rule
// means `node file.ts` works with no build step and no dependencies.
export class Rpc {
  url: string;
  #retries: number;
  #id = 0;
  /** Earliest wall-clock time the next request may start. */
  #nextSlot = 0;
  #minIntervalMs: number;

  constructor(url: string = ARC_TESTNET.rpcUrl, opts: { retries?: number; rps?: number } = {}) {
    this.url = url;
    this.#retries = opts.retries ?? 5;
    const rps = opts.rps ?? Number(process.env.ARC_RPC_RPS ?? "12");
    this.#minIntervalMs = rps > 0 ? 1000 / rps : 0;
  }

  /**
   * Space request starts out. Arc's public RPC sits behind Cloudflare and answers
   * bursts with 429 even at modest concurrency, so callers get a smooth rate
   * instead of having to coordinate their own fan-out.
   */
  async #gate(): Promise<void> {
    if (this.#minIntervalMs === 0) return;
    const now = Date.now();
    const start = Math.max(now, this.#nextSlot);
    // Claim the slot synchronously, before awaiting, so concurrent callers queue.
    this.#nextSlot = start + this.#minIntervalMs;
    const wait = start - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++this.#id, method, params });
    let lastError: unknown;

    let waitMs = 0;

    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      await this.#gate();
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 429) {
          // Rate limits need real patience, not the transport backoff: honour
          // Retry-After when the node sends it, otherwise back off hard.
          const retryAfter = Number(res.headers.get("retry-after"));
          waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 1000 * 2 ** attempt;
          // Back the sustained rate off too, or every later call retries as well.
          this.#minIntervalMs = Math.min(Math.max(this.#minIntervalMs, 1) * 2, 1000);
          throw new Error("HTTP 429 (rate limited)");
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { result?: T; error?: { code: number; message: string } };
        // A JSON-RPC error is the node's answer, not a transport fault: do not retry it.
        if (json.error) throw new RpcError(json.error.code, json.error.message);
        return json.result as T;
      } catch (err) {
        if (err instanceof RpcError) throw err;
        lastError = err;
        if (waitMs === 0) waitMs = 250 * 2 ** attempt;
      }
    }
    throw new Error(`${method} failed after ${this.#retries + 1} attempts: ${lastError}`);
  }

  async chainId(): Promise<number> {
    return Number(BigInt(await this.call<Hex>("eth_chainId")));
  }

  async blockNumber(): Promise<bigint> {
    return BigInt(await this.call<Hex>("eth_blockNumber"));
  }

  async gasPrice(): Promise<bigint> {
    return BigInt(await this.call<Hex>("eth_gasPrice"));
  }

  /** Native balance, in 18-decimal native USDC units. */
  async balance(address: string, block: string = "latest"): Promise<bigint> {
    return BigInt(await this.call<Hex>("eth_getBalance", [address, block]));
  }

  async code(address: string, block: string = "latest"): Promise<Hex> {
    return this.call<Hex>("eth_getCode", [address, block]);
  }

  async ethCall(to: string, data: Hex, block: string = "latest"): Promise<Hex> {
    return this.call<Hex>("eth_call", [{ to, data }, block]);
  }

  async logs(opts: {
    fromBlock: bigint;
    toBlock: bigint;
    address?: string | string[];
    topics?: (Hex | Hex[] | null)[];
  }): Promise<Log[]> {
    return this.call<Log[]>("eth_getLogs", [
      {
        fromBlock: "0x" + opts.fromBlock.toString(16),
        toBlock: "0x" + opts.toBlock.toString(16),
        ...(opts.address ? { address: opts.address } : {}),
        ...(opts.topics ? { topics: opts.topics } : {}),
      },
    ]);
  }

  /** Assert we are talking to the chain we think we are. */
  async assertArc(expected = ARC_TESTNET.chainId): Promise<void> {
    const actual = await this.chainId();
    if (actual !== expected) {
      throw new Error(`Expected chain ${expected}, RPC ${this.url} reports ${actual}`);
    }
  }
}
