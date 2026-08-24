import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isIgnored, lintSource, parseIgnore } from "../src/engine.ts";
import { RULES } from "../src/rules.ts";
import { stripNonCode } from "../src/source.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const ids = (fs: { rule: string; line: number }[]) =>
  fs.map((f) => `${f.rule}@${f.line}`).sort();

test("Bad.sol reports every Arc hazard exactly once", () => {
  const found = ids(lintSource(read("Bad.sol"), "Bad.sol", "solidity"));
  assert.deepEqual(found, [
    "arc/balanceof-zero-is-not-empty@44",
    "arc/burn-to-zero-address@36",
    "arc/burn-to-zero-address@40",
    "arc/decimals-mix@10",
    "arc/ether-unit-is-usdc@48",
    "arc/no-assembly-prevrandao@27",
    "arc/no-blob-opcodes@32",
    "arc/no-prevrandao@17",
    "arc/no-prevrandao@22",
    "arc/selfdestruct-value-rules@40",
  ]);
});

test("Good.sol is clean", () => {
  assert.deepEqual(lintSource(read("Good.sol"), "Good.sol", "solidity"), []);
});

test("script rules read values inside string literals", () => {
  const found = ids(lintSource(read("deploy.ts"), "deploy.ts", "script"));
  assert.deepEqual(found, [
    "arc/gas-fee-floor@6",
    "arc/hardcoded-eth-rpc@3",
    "arc/wrong-usdc-decimals@15",
  ]);
});

test("a 20 Gwei max fee is at the floor, not below it", () => {
  const src = `x({ maxFeePerGas: parseGwei("20") });`;
  assert.equal(lintSource(src, "a.ts", "script").length, 0);
  assert.equal(lintSource(`x({ maxFeePerGas: parseGwei("19") });`, "a.ts", "script").length, 1);
});

test("hazards inside comments and revert strings are ignored", () => {
  const src = [
    "contract C {",
    "  // block.prevrandao selfdestruct(x)",
    "  /* block.blobbasefee */",
    '  function f() external { require(false, "block.prevrandao"); }',
    "}",
  ].join("\n");
  assert.deepEqual(lintSource(src, "C.sol", "solidity"), []);
});

test("a URL in a string does not swallow the rest of the line", () => {
  const kept = stripNonCode('const u = "http://127.0.0.1:8545"; parseGwei("1");', false);
  assert.match(kept, /parseGwei/);
  assert.match(kept, /8545/);
});

test("comments are blanked in place, preserving offsets", () => {
  const src = 'a // c\nb';
  const stripped = stripNonCode(src);
  assert.equal(stripped.length, src.length);
  assert.equal(stripped, "a     \nb");
});

test("suppression comments mute only the named rule on the next line", () => {
  const base = "contract C { function f() external view returns (uint256) {\n";
  const bare = `${base}  return block.prevrandao; } }`;
  assert.equal(lintSource(bare, "C.sol", "solidity").length, 1);

  const muted = `${base}  // arc-lint-disable-next-line arc/no-prevrandao\n  return block.prevrandao; } }`;
  assert.equal(lintSource(muted, "C.sol", "solidity").length, 0);

  const wrongRule = `${base}  // arc-lint-disable-next-line arc/no-blob-opcodes\n  return block.prevrandao; } }`;
  assert.equal(lintSource(wrongRule, "C.sol", "solidity").length, 1);
});

test("every rule carries a doc link and at least one language", () => {
  const seen = new Set<string>();
  for (const r of RULES) {
    assert.ok(!seen.has(r.id), `duplicate rule id ${r.id}`);
    seen.add(r.id);
    assert.match(r.id, /^arc\//);
    assert.match(r.doc, /^https:\/\/docs\.arc\.io\//);
    assert.ok(r.langs.length > 0, `${r.id} has no languages`);
    assert.ok(r.detail.length > 40, `${r.id} detail is too thin to act on`);
  }
});

test("ignore patterns match substrings, and * anchors the whole path", () => {
  const dirOnly = parseIgnore("packages/arc-lint/test/");
  assert.equal(isIgnored("packages/arc-lint/test/fixtures/Bad.sol", dirOnly), true);
  assert.equal(isIgnored("packages/arc-index/src/cli.ts", dirOnly), false);

  const glob = parseIgnore("*Bad.sol");
  assert.equal(isIgnored("a/b/Bad.sol", glob), true);
  assert.equal(isIgnored("a/b/Good.sol", glob), false);

  // A glob is anchored, so it must not match a longer path by accident.
  const anchored = parseIgnore("src/*.ts");
  assert.equal(isIgnored("src/cli.ts", anchored), true);
  assert.equal(isIgnored("pkg/src/cli.ts", anchored), false);

  assert.deepEqual(parseIgnore("# comment\n\n  \n"), []);
});

test("regex metacharacters in a pattern are literal", () => {
  const p = parseIgnore("a+b.ts");
  assert.equal(isIgnored("x/a+b.ts", p), true);
  assert.equal(isIgnored("x/aab.ts", p), false);
});
