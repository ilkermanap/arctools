import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describeTargets, resolveLintPaths, type HreLike } from "../src/paths.ts";

function project(dirs: string[], foundryToml?: string): string {
  const root = mkdtempSync(join(tmpdir(), "hh-arc-"));
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
  if (foundryToml) writeFileSync(join(root, "foundry.toml"), foundryToml);
  return root;
}

const hre = (root: string, sources: string[], tests?: Record<string, unknown>): HreLike => ({
  config: { paths: { root, sources: { solidity: sources }, tests } },
});

test("lints Hardhat's configured source directories", () => {
  const root = project(["contracts"]);
  const r = resolveLintPaths(hre(root, ["contracts"]));
  assert.equal(r.origin, "hardhat");
  assert.deepEqual(r.targets.map((t) => relative(root, t)), ["contracts"]);
  assert.deepEqual(r.notes, [], "nothing was inferred, so nothing to report");
});

test("conventional script directories are linted, since Hardhat has no path for them", () => {
  const root = project(["contracts", "scripts", "ignition/modules"]);
  const r = resolveLintPaths(hre(root, ["contracts"]));
  assert.equal(r.origin, "hardhat", "scripts are an addition, not a fallback");
  assert.deepEqual(
    r.targets.map((t) => relative(root, t)).sort(),
    ["contracts", "ignition/modules", "scripts"],
  );
  assert.match(r.notes.join(" "), /no configured script path/);
});

test("test directories are included, from string or array entries", () => {
  const root = project(["contracts", "test", "test/solidity"]);
  const r = resolveLintPaths(
    hre(root, ["contracts"], { solidity: ["test/solidity"], mocha: "test" }),
  );
  assert.deepEqual(
    r.targets.map((t) => relative(root, t)).sort(),
    ["contracts", "test", "test/solidity"],
  );
});

test("explicit paths win and nothing is inferred", () => {
  const root = project(["contracts", "scripts"]);
  const r = resolveLintPaths(hre(root, ["contracts"]), { paths: ["scripts"] });
  assert.equal(r.origin, "explicit");
  assert.deepEqual(r.targets.map((t) => relative(root, t)), ["scripts"]);
});

test("absolute explicit paths are passed through unchanged", () => {
  const root = project(["contracts"]);
  const abs = join(root, "contracts");
  const r = resolveLintPaths(hre(root, []), { paths: [abs] });
  assert.deepEqual(r.targets, [abs]);
});

test("non-existent paths are dropped rather than passed to the scanner", () => {
  const root = project(["contracts"]);
  const r = resolveLintPaths(hre(root, ["contracts", "nope"]));
  assert.deepEqual(r.targets.map((t) => relative(root, t)), ["contracts"]);
});

test("--foundry merges foundry.toml sources with Hardhat's", () => {
  const root = project(
    ["contracts", "src", "script"],
    '[profile.default]\nsrc = "src"\nscript = "script"\n',
  );
  const r = resolveLintPaths(hre(root, ["contracts"]), { foundry: true });
  assert.equal(r.origin, "hardhat+foundry");
  assert.deepEqual(r.targets.map((t) => relative(root, t)).sort(), ["contracts", "script", "src"]);
  assert.match(r.notes.join(" "), /foundry\.toml \[profile\.default\]/);
});

test("--foundry without a foundry.toml says so instead of failing", () => {
  const root = project(["contracts"]);
  const r = resolveLintPaths(hre(root, ["contracts"]), { foundry: true });
  assert.equal(r.origin, "hardhat");
  assert.match(r.notes.join(" "), /no foundry\.toml/);
});

test("a project with no configured sources falls back rather than passing silently", () => {
  const root = project(["contracts", "scripts"]);
  const r = resolveLintPaths(hre(root, []));
  assert.equal(r.origin, "fallback");
  assert.deepEqual(r.targets.map((t) => relative(root, t)).sort(), ["contracts", "scripts"]);
  assert.match(r.notes.join(" "), /falling back/);
});

test("finding scripts/ does not mask an empty Hardhat config", () => {
  // Regression: treating any collected directory as "Hardhat told us something"
  // let scripts/ satisfy the check and silently skipped contracts/.
  const root = project(["contracts", "scripts"]);
  const r = resolveLintPaths(hre(root, []));
  assert.ok(
    r.targets.some((t) => relative(root, t) === "contracts"),
    "contracts/ must still be found",
  );
  assert.equal(r.origin, "fallback");
});

test("no sources and no conventional directory reports the fact", () => {
  const root = project(["random"]);
  const r = resolveLintPaths(hre(root, []));
  assert.deepEqual(r.targets, []);
  assert.equal(r.origin, "fallback");
  assert.match(r.notes.join(" "), /no conventional source directory exists/);
});

test("duplicate directories across sources and tests collapse", () => {
  const root = project(["contracts"]);
  const r = resolveLintPaths(hre(root, ["contracts", "contracts"], { mocha: "contracts" }));
  assert.equal(r.targets.length, 1);
});

test("describeTargets renders paths relative to the project root", () => {
  const root = "/tmp/proj";
  assert.equal(describeTargets(root, ["/tmp/proj/contracts", "/tmp/proj/scripts"]), "contracts, scripts");
  assert.equal(describeTargets(root, [root]), ".");
});
