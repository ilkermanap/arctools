import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocIndex, loadSite } from "../src/docs.ts";
import { Cache } from "../src/cache.ts";
import { HttpError, jsonSafe, routes } from "../src/api.ts";

const POINTER = [
  "> ## Documentation Index",
  "> Fetch the complete documentation index at: https://docs.arc.io/llms.txt",
  "> Use this file to discover all available pages before exploring further.",
  "",
].join("\n");

function fixtureSite(): string {
  const dir = mkdtempSync(join(tmpdir(), "arc-docs-"));
  mkdirSync(join(dir, "arc", "references"), { recursive: true });

  writeFileSync(
    join(dir, "arc", "references", "gas-and-fees.md"),
    `${POINTER}# Gas and fees\n\n> Runtime parameters for Arc gas pricing.\n\nArc denominates all fees in USDC.\nThe minimum base fee is 20 Gwei on testnet.\n`,
  );
  writeFileSync(
    join(dir, "overview.md"),
    `${POINTER}# Overview\n\n> What Arc is.\n\nUSDC is the native gas token.\n`,
  );
  // Not markdown: must be ignored by the loader.
  writeFileSync(join(dir, "logo.svg"), "<svg/>");
  return dir;
}

test("loadSite reads markdown recursively and derives titles and summaries", () => {
  const pages = loadSite("arc", fixtureSite());
  assert.equal(pages.length, 2);

  const gas = pages.find((p) => p.path === "arc/references/gas-and-fees")!;
  assert.equal(gas.title, "Gas and fees");
  assert.equal(gas.summary, "Runtime parameters for Arc gas pricing.");
  assert.equal(gas.site, "arc");
});

test("the Mintlify index pointer is stripped so it cannot dominate scores", () => {
  const pages = loadSite("arc", fixtureSite());
  for (const p of pages) assert.doesNotMatch(p.text, /Documentation Index/);
});

test("loadSite returns nothing for a missing directory", () => {
  assert.deepEqual(loadSite("arc", join(tmpdir(), "definitely-not-here-42")), []);
});

test("search ranks a title match above a body match", () => {
  const idx = new DocIndex().add(loadSite("arc", fixtureSite()));
  const hits = idx.search("gas");
  assert.equal(hits[0].path, "arc/references/gas-and-fees");
  assert.ok(hits[0].score > 40, "a title hit should score above the body weight");
});

test("search requires every term to appear", () => {
  const idx = new DocIndex().add(loadSite("arc", fixtureSite()));
  assert.equal(idx.search("usdc gwei").length, 1, "both terms live in gas-and-fees");
  assert.equal(idx.search("usdc unicorn").length, 0);
  assert.equal(idx.search("a").length, 0, "single characters are not terms");
});

test("excerpts mark each matched term", () => {
  const idx = new DocIndex().add(loadSite("arc", fixtureSite()));
  const hit = idx.search("gwei")[0];
  assert.ok(hit.excerpts.length > 0);
  assert.match(hit.excerpts.join("\n"), /«Gwei»/);
});

test("list omits page bodies, and get returns them", () => {
  const idx = new DocIndex().add(loadSite("arc", fixtureSite()));
  assert.ok(idx.list("arc").every((p) => p.text === ""));
  assert.match(idx.get("arc", "overview")!.text, /native gas token/);
  assert.equal(idx.get("arc", "nope"), undefined);
  assert.deepEqual(idx.sites.map((s) => s.site), ["arc"]);
});

test("cache serves within the TTL and recomputes after it", async () => {
  const cache = new Cache();
  let calls = 0;
  const fn = async () => ++calls;

  assert.equal(await cache.wrap("k", 50, fn), 1);
  assert.equal(await cache.wrap("k", 50, fn), 1);
  assert.equal(calls, 1);

  await new Promise((r) => setTimeout(r, 70));
  assert.equal(await cache.wrap("k", 50, fn), 2);
});

test("concurrent cache misses share one computation", async () => {
  const cache = new Cache();
  let calls = 0;
  const slow = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 30));
    return "v";
  };
  const all = await Promise.all([1, 2, 3, 4].map(() => cache.wrap("k", 1000, slow)));
  assert.deepEqual(all, ["v", "v", "v", "v"]);
  assert.equal(calls, 1, "four callers must not make four RPC passes");
});

test("a failed computation is not cached", async () => {
  const cache = new Cache();
  let calls = 0;
  const boom = async () => {
    calls++;
    throw new Error("nope");
  };
  await assert.rejects(cache.wrap("k", 1000, boom));
  await assert.rejects(cache.wrap("k", 1000, boom));
  assert.equal(calls, 2);
});

test("jsonSafe stringifies bigints so responses serialise", () => {
  assert.deepEqual(jsonSafe({ head: 58n, nested: { v: [1n, 2n] } }), {
    head: "58",
    nested: { v: ["1", "2"] },
  });
});

test("/api/lint validates its body and lints the source", async () => {
  const deps = { rpc: null as never, cache: new Cache(), docs: new DocIndex() };
  const lint = routes["/api/lint"];

  await assert.rejects(() => lint(new URLSearchParams(), deps, null), HttpError);
  await assert.rejects(() => lint(new URLSearchParams(), deps, { source: 42 }), HttpError);

  const res = (await lint(new URLSearchParams(), deps, {
    filename: "R.sol",
    lang: "solidity",
    source: "contract R { function f() external view returns (uint256) { return block.prevrandao; } }",
  })) as { counts: { error: number }; findings: { rule: string }[] };

  assert.equal(res.counts.error, 1);
  assert.equal(res.findings[0].rule, "arc/no-prevrandao");
});

test("/api/docs/search rejects a too-short query and answers a real one", async () => {
  const docs = new DocIndex().add(loadSite("arc", fixtureSite()));
  const deps = { rpc: null as never, cache: new Cache(), docs };
  const search = routes["/api/docs/search"];

  await assert.rejects(() => search(new URLSearchParams("q=a"), deps, null), HttpError);
  await assert.rejects(() => search(new URLSearchParams(""), deps, null), HttpError);

  const res = (await search(new URLSearchParams("q=gwei"), deps, null)) as { hits: unknown[] };
  assert.equal(res.hits.length, 1);
});

test("/api/docs/page 404s for an unknown page", async () => {
  const docs = new DocIndex().add(loadSite("arc", fixtureSite()));
  const deps = { rpc: null as never, cache: new Cache(), docs };
  await assert.rejects(
    () => routes["/api/docs/page"](new URLSearchParams("site=arc&path=nope"), deps, null),
    (err: HttpError) => err.status === 404,
  );
});
