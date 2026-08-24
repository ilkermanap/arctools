#!/usr/bin/env node
/**
 * Local dev console for Arc: the mirrored docs plus live chain data, over one
 * dependency-free HTTP server.
 *
 * Usage:
 *   node packages/arc-server/src/server.ts [--port 8787] [--rpc URL] [--open]
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Rpc, ARC_TESTNET } from "../../arc-common/rpc.ts";
import { Cache } from "./cache.ts";
import { DocIndex, loadSite } from "./docs.ts";
import { HttpError, routes, type Deps } from "./api.ts";
import { PAGE } from "./ui.ts";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const PORT = Number(arg("port", process.env.PORT ?? "8787"));
const HOST = arg("host", "127.0.0.1");
const ROOT = arg("root", process.cwd());

/** Mirrored doc trees, by site key. Missing directories are simply skipped. */
const SITES: [string, string][] = [
  ["arc", join(ROOT, "docs")],
  ["circle", join(ROOT, "docs-circle")],
];

const MAX_BODY = 4 * 1024 * 1024;

function send(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    // Local-only tool, but the API is read-mostly and worth locking down anyway.
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value, null, 2), "application/json; charset=utf-8");
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "request body exceeds 4 MB");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

async function main(): Promise<void> {
  const docs = new DocIndex();
  for (const [site, dir] of SITES) {
    const pages = loadSite(site, dir);
    if (pages.length) {
      docs.add(pages);
      console.log(`  docs: ${site.padEnd(7)} ${String(pages.length).padStart(4)} pages  ${dir}`);
    } else {
      console.log(`  docs: ${site.padEnd(7)}    - not mirrored (node tools/mirror-docs.ts --site ${site})`);
    }
  }

  const rpc = new Rpc(arg("rpc", ARC_TESTNET.rpcUrl));
  const deps: Deps = { rpc, cache: new Cache(), docs };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? HOST}`);

      try {
        if (req.method !== "GET" && req.method !== "POST") {
          throw new HttpError(405, `${req.method} is not allowed`);
        }

        if (url.pathname === "/" || url.pathname === "/index.html") {
          return send(res, 200, PAGE, "text/html; charset=utf-8");
        }

        const handler = routes[url.pathname];
        if (!handler) throw new HttpError(404, `no route ${url.pathname}`);

        const body = req.method === "POST" ? await readBody(req) : null;
        return sendJson(res, 200, await handler(url.searchParams, deps, body));
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (status >= 500) console.error(`  ${url.pathname}: ${(err as Error).message}`);
        return sendJson(res, status, { error: (err as Error).message });
      }
    })();
  });

  server.listen(PORT, HOST, () => {
    console.log(`\n  Arc dev console  http://${HOST}:${PORT}`);
    console.log(`  rpc              ${rpc.url}`);
    console.log(`  docs indexed     ${docs.pages.length} pages\n`);
  });

  // Without this a dropped browser connection can hold the process open.
  server.keepAliveTimeout = 5_000;

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log("\n  shutting down");
      server.close(() => process.exit(0));
    });
  }
}

await main();
