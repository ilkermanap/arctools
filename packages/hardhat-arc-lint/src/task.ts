/**
 * The `hardhat arc-lint` task action.
 *
 * Hardhat loads this lazily (see index.ts), so nothing here runs — and none of
 * arc-lint is imported — unless the task is actually invoked.
 */
import { appendFileSync } from "node:fs";
import { HardhatPluginError } from "hardhat/plugins";
import { collectFiles, lintFiles, loadIgnore } from "../../arc-lint/src/engine.ts";
import type { Finding, Severity } from "../../arc-lint/src/rules.ts";
import { toSarif } from "../../arc-lint/src/sarif.ts";
import { toAnnotations, toStepSummary, toSummary } from "../../arc-lint/src/github.ts";
import { describeTargets, resolveLintPaths, type HreLike } from "./paths.ts";

export interface ArcLintTaskArguments {
  paths: string[];
  foundry: boolean;
  failOn: string;
  format: string;
  out: string;
  includeVendor: boolean;
}

export const PLUGIN_ID = "arc-lint";

const FORMATS = new Set(["text", "json", "sarif", "github"]);
const FAIL_LEVELS = new Set(["error", "warning", "never"]);

const PAINT: Record<Severity, string> = { error: "✖", warning: "▲", info: "•" };

function reportText(findings: Finding[], scanned: number): void {
  if (findings.length === 0) {
    console.log(`\narc-lint: no Arc compatibility issues in ${scanned} file(s).`);
    return;
  }

  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byFile.get(f.file);
    if (list) list.push(f);
    else byFile.set(f.file, [f]);
  }

  for (const [file, items] of byFile) {
    console.log(`\n${file}`);
    for (const f of items) {
      console.log(`  ${PAINT[f.severity]} ${f.line}:${f.column}  ${f.message}  (${f.rule})`);
      console.log(`      ${f.detail.replace(/\s+/g, " ")}`);
      console.log(`      ${f.doc}`);
    }
  }
  console.log(`\n${toSummary(findings, scanned)}`);
}

/**
 * `hre` is typed structurally rather than as HardhatRuntimeEnvironment so this
 * file has no compile-time dependency on hardhat's types.
 */
export default async function arcLintAction(
  args: ArcLintTaskArguments,
  hre: HreLike,
): Promise<void> {
  if (!FORMATS.has(args.format)) {
    throw new HardhatPluginError(PLUGIN_ID, `--format must be one of ${[...FORMATS].join(", ")}`);
  }
  if (!FAIL_LEVELS.has(args.failOn)) {
    throw new HardhatPluginError(PLUGIN_ID, `--fail-on must be one of ${[...FAIL_LEVELS].join(", ")}`);
  }

  const root = hre.config.paths.root;
  const resolved = resolveLintPaths(hre, { paths: args.paths, foundry: args.foundry });

  for (const note of resolved.notes) console.log(`arc-lint: ${note}`);

  if (resolved.targets.length === 0) {
    console.log("arc-lint: nothing to lint (no source directories found)");
    return;
  }
  if (args.format === "text") {
    console.log(`arc-lint: ${resolved.origin} → ${describeTargets(root, resolved.targets)}`);
  }

  const files = resolved.targets.flatMap((t) => collectFiles(t, args.includeVendor));
  const findings = lintFiles(files, root, loadIgnore(root));

  switch (args.format) {
    case "sarif":
      await write(args.out, JSON.stringify(toSarif(findings), null, 2));
      break;
    case "json":
      await write(args.out, JSON.stringify({ scanned: files.length, findings }, null, 2));
      break;
    case "github": {
      for (const line of toAnnotations(findings)) console.log(line);
      console.log(toSummary(findings, files.length));
      const summaryPath = process.env.GITHUB_STEP_SUMMARY;
      if (summaryPath) {
        try {
          appendFileSync(summaryPath, toStepSummary(findings, files.length));
        } catch (err) {
          console.error(`arc-lint: could not write step summary: ${(err as Error).message}`);
        }
      }
      break;
    }
    default:
      reportText(findings, files.length);
  }

  if (args.failOn === "never") return;
  const blocking: Severity[] = args.failOn === "warning" ? ["error", "warning"] : ["error"];
  const blockingCount = findings.filter((f) => blocking.includes(f.severity)).length;

  if (blockingCount > 0) {
    // A lint failure is an expected outcome, so it must not surface as a
    // Hardhat bug report. HardhatPluginError prints the message on its own.
    throw new HardhatPluginError(
      PLUGIN_ID,
      `found ${blockingCount} ${args.failOn}-or-worse finding(s). ` +
        `Fix them, suppress a line with "// arc-lint-disable-next-line <rule>", ` +
        `or pass --fail-on never.`,
    );
  }
}

async function write(path: string, text: string): Promise<void> {
  if (!path) {
    console.log(text);
    return;
  }
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text + "\n");
  console.log(`arc-lint: wrote ${path}`);
}
