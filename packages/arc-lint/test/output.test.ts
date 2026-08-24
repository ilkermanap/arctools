import { test } from "node:test";
import assert from "node:assert/strict";
import { lintSource } from "../src/engine.ts";
import { RULES, type Finding } from "../src/rules.ts";
import { toSarif } from "../src/sarif.ts";
import { toAnnotations, toStepSummary, toSummary } from "../src/github.ts";
import { FOUNDRY_DEFAULTS, parseFoundryToml } from "../src/foundry.ts";

const finding = (over: Partial<Finding> = {}): Finding => ({
  rule: "arc/no-prevrandao",
  severity: "error",
  file: "src/A.sol",
  line: 12,
  column: 4,
  message: "block.prevrandao is always 0 on Arc",
  detail: "Arc has no beacon-chain RANDAO mix.",
  doc: "https://docs.arc.io/arc/references/evm-differences",
  snippet: "return block.prevrandao;",
  ...over,
});

// ---------- SARIF ----------

test("SARIF declares every rule so ruleIndex stays stable across runs", () => {
  const sarif = toSarif([finding()]) as any;
  const driver = sarif.runs[0].tool.driver;
  assert.equal(sarif.version, "2.1.0");
  assert.equal(driver.rules.length, RULES.length);
  const result = sarif.runs[0].results[0];
  assert.equal(driver.rules[result.ruleIndex].id, result.ruleId);
});

test("SARIF maps info to note, the only level SARIF has for it", () => {
  const sarif = toSarif([
    finding({ severity: "error" }),
    finding({ severity: "warning" }),
    finding({ severity: "info" }),
  ]) as any;
  assert.deepEqual(
    sarif.runs[0].results.map((r: any) => r.level),
    ["error", "warning", "note"],
  );
});

test("SARIF locations use forward slashes on every platform", () => {
  const sarif = toSarif([finding({ file: "src\\nested\\A.sol" })]) as any;
  const loc = sarif.runs[0].results[0].locations[0].physicalLocation;
  assert.equal(loc.artifactLocation.uri, "src/nested/A.sol");
  assert.equal(loc.region.startLine, 12);
  assert.equal(loc.region.startColumn, 4);
  assert.equal(loc.region.snippet.text, "return block.prevrandao;");
});

test("SARIF omits the snippet region when there is no snippet", () => {
  const sarif = toSarif([finding({ snippet: "" })]) as any;
  assert.equal("snippet" in sarif.runs[0].results[0].locations[0].physicalLocation.region, false);
});

test("SARIF for a clean run is valid and empty", () => {
  const sarif = toSarif([]) as any;
  assert.deepEqual(sarif.runs[0].results, []);
  assert.equal(sarif.runs[0].tool.driver.rules.length, RULES.length);
});

test("every SARIF rule carries a helpUri and a rule name", () => {
  const driver = (toSarif([]) as any).runs[0].tool.driver;
  for (const rule of driver.rules) {
    assert.match(rule.helpUri, /^https:\/\/docs\.arc\.io\//);
    assert.match(rule.name, /^[A-Za-z][A-Za-z0-9]*$/, `${rule.id} -> ${rule.name}`);
    assert.ok(["error", "warning", "note"].includes(rule.defaultConfiguration.level));
  }
});

// ---------- GitHub annotations ----------

test("annotations use the workflow command matching each severity", () => {
  const lines = toAnnotations([
    finding({ severity: "error" }),
    finding({ severity: "warning" }),
    finding({ severity: "info" }),
  ]);
  assert.match(lines[0], /^::error /);
  assert.match(lines[1], /^::warning /);
  assert.match(lines[2], /^::notice /);
});

test("annotation properties escape the characters that would break the command", () => {
  const [line] = toAnnotations([finding({ message: "a: b, c" })]);
  // A raw colon or comma in a property value would terminate it early.
  const title = /title=([^:]*)::/.exec(line)![1];
  assert.match(title, /%3A/);
  assert.match(title, /%2C/);
  assert.doesNotMatch(title, /[:,]/);
});

test("a multi-line detail is collapsed so the command stays on one line", () => {
  const [line] = toAnnotations([finding({ detail: "first\nsecond\tthird" })]);
  assert.equal(line.split("\n").length, 1);
  assert.match(line, /first second third/);
});

test("a percent sign in a message is encoded, not treated as an escape", () => {
  const [line] = toAnnotations([finding({ detail: "100% wrong" })]);
  assert.match(line, /100%25 wrong/);
});

test("annotation file paths are normalised to forward slashes", () => {
  const [line] = toAnnotations([finding({ file: "src\\A.sol" })]);
  assert.match(line, /file=src\/A\.sol,/);
});

test("summary reports a clean run and a dirty one differently", () => {
  assert.match(toSummary([], 9), /no Arc compatibility issues in 9 file\(s\)/);
  assert.match(
    toSummary([finding(), finding({ severity: "warning", file: "src/B.sol" })], 9),
    /1 error, 1 warning, 0 info across 2 of 9 file\(s\)/,
  );
});

test("step summary groups by rule, worst severity first", () => {
  const md = toStepSummary(
    [
      finding({ severity: "warning", rule: "arc/ether-unit-is-usdc" }),
      finding({ rule: "arc/no-prevrandao", file: "src/A.sol" }),
      finding({ rule: "arc/no-prevrandao", file: "src/B.sol" }),
    ],
    5,
  );
  assert.match(md, /^## arc-lint/);
  const errorAt = md.indexOf("arc/no-prevrandao");
  const warnAt = md.indexOf("arc/ether-unit-is-usdc");
  assert.ok(errorAt > 0 && errorAt < warnAt, "errors must be listed before warnings");
  assert.match(md, /\| error \| \[`arc\/no-prevrandao`\]\(https:.*\) \| 2 \|/);
  assert.match(md, /src\/B\.sol/);
});

test("step summary for a clean run says so", () => {
  assert.match(toStepSummary([], 12), /No Arc compatibility issues in \*\*12\*\*/);
});

// ---------- foundry.toml ----------

test("foundry.toml src/script/test/libs are read from the default profile", () => {
  const parsed = parseFoundryToml(
    [
      "[profile.default]",
      'src = "contracts"',
      'script = "scripts"',
      'test = "tests"',
      'libs = ["lib", "node_modules"]',
    ].join("\n"),
  );
  assert.deepEqual(parsed.sources, ["contracts", "scripts", "tests"]);
  assert.deepEqual(parsed.libs, ["lib", "node_modules"]);
});

test("missing keys fall back to Foundry's own defaults", () => {
  const parsed = parseFoundryToml("[profile.default]\nsolc = \"0.8.28\"\n");
  assert.deepEqual(parsed.sources, ["src", "script", "test"]);
  assert.deepEqual(parsed.libs, FOUNDRY_DEFAULTS.libs);
});

test("a named profile overrides the default, and inherits what it omits", () => {
  const toml = [
    "[profile.default]",
    'src = "contracts"',
    'script = "scripts"',
    "",
    "[profile.ci]",
    'src = "ci-contracts"',
  ].join("\n");
  const ci = parseFoundryToml(toml, "ci");
  assert.ok(ci.sources.includes("ci-contracts"), "profile src wins");
  assert.ok(ci.sources.includes("scripts"), "unset keys come from default");
  assert.ok(!ci.sources.includes("contracts"));
});

test("comments and blank lines are ignored, including trailing ones", () => {
  const parsed = parseFoundryToml(
    ["# top comment", "[profile.default]", 'src = "contracts"  # where they live', "", 'libs = ["lib"] # deps'].join("\n"),
  );
  assert.ok(parsed.sources.includes("contracts"));
  assert.deepEqual(parsed.libs, ["lib"]);
});

test("keys outside a profile section are not picked up", () => {
  const parsed = parseFoundryToml(['[rpc_endpoints]', 'src = "not-a-source"'].join("\n"));
  assert.deepEqual(parsed.sources, ["src", "script", "test"]);
});

test("a profile pointing several keys at one directory yields it once", () => {
  const parsed = parseFoundryToml('[profile.default]\nsrc = "all"\nscript = "all"\ntest = "all"\n');
  assert.deepEqual(parsed.sources, ["all"]);
});

test("single-quoted values and quoted section headers parse", () => {
  const parsed = parseFoundryToml("['profile.default']\nsrc = 'contracts'\n");
  assert.ok(parsed.sources.includes("contracts"));
});

// ---------- end-to-end shape ----------

test("real findings survive the round trip into SARIF and annotations", () => {
  const findings = lintSource(
    "contract C { function f() external view returns (uint256) { return block.prevrandao; } }",
    "src/C.sol",
    "solidity",
  );
  assert.equal(findings.length, 1);

  const sarif = toSarif(findings) as any;
  assert.equal(sarif.runs[0].results[0].ruleId, "arc/no-prevrandao");
  assert.match(toAnnotations(findings)[0], /^::error file=src\/C\.sol,line=1,col=/);
});
