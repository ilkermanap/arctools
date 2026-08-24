#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { collectFiles, lintFiles, loadIgnore, parseIgnore } from "./engine.ts";
import { RULES, type Finding, type Severity } from "./rules.ts";
import { toSarif } from "./sarif.ts";
import { toAnnotations, toStepSummary, toSummary } from "./github.ts";
import { discoverFoundry } from "./foundry.ts";

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? {
      red: (s: string) => `\x1b[31m${s}\x1b[0m`,
      yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
      blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
      dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
      bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
    }
  : {
      red: (s: string) => s, yellow: (s: string) => s, blue: (s: string) => s,
      dim: (s: string) => s, bold: (s: string) => s,
    };

const PAINT: Record<Severity, (s: string) => string> = {
  error: C.red,
  warning: C.yellow,
  info: C.blue,
};

const USAGE = `arc-lint -- flag Arc-incompatible patterns before you deploy

Usage:
  arc-lint [paths...] [options]

Options:
  --json            Machine-readable output
  --sarif           SARIF 2.1.0, for GitHub code scanning
  --github          GitHub Actions annotations + step summary
  --foundry         Read src/script/test/libs from foundry.toml
  --no-info         Hide info-severity findings
  --quiet           Errors only
  --include-vendor  Also lint lib/ and vendor/
  --ignore PATTERN  Skip paths matching PATTERN (repeatable; * is a wildcard)
  --no-ignore-file  Ignore .arclintignore
  --fail-on LEVEL   Exit 1 on error (default), warning, or never
  --out FILE        Write the report to FILE instead of stdout
  --rules           List all rules and exit
  -h, --help        Show this help

Exit code is 1 when any error-severity finding remains (see --fail-on).
Suppress a line with:  // arc-lint-disable-next-line arc/rule-id
Skip whole paths with a .arclintignore file in the working directory.

Rules are derived from https://docs.arc.io/arc/references/evm-differences`;

function listRules(): void {
  console.log(C.bold("\narc-lint rules\n"));
  for (const r of RULES) {
    console.log(`${PAINT[r.severity](r.severity.padEnd(7))} ${C.bold(r.id)}  ${C.dim(`[${r.langs.join(", ")}]`)}`);
    console.log(`        ${r.title}`);
    console.log(`        ${C.dim(r.doc)}\n`);
  }
}

function report(findings: Finding[], scanned: number, showInfo: boolean): void {
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!showInfo && f.severity === "info") continue;
    (byFile.get(f.file) ?? byFile.set(f.file, []).get(f.file)!).push(f);
  }

  for (const [file, items] of byFile) {
    console.log(`\n${C.bold(file)}`);
    for (const f of items) {
      const loc = `${f.line}:${f.column}`.padEnd(8);
      console.log(`  ${C.dim(loc)}${PAINT[f.severity](f.severity.padEnd(8))}${f.message}  ${C.dim(f.rule)}`);
      if (f.snippet) console.log(`  ${C.dim("        │ " + f.snippet.slice(0, 100))}`);
      console.log(`  ${C.dim("        → " + f.detail.replace(/\s+/g, " "))}`);
      console.log(`  ${C.dim("        " + f.doc)}`);
    }
  }

  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const total = counts.error + counts.warning + (showInfo ? counts.info : 0);

  console.log("");
  if (total === 0) {
    console.log(`${C.bold("✓")} No Arc compatibility issues in ${scanned} file(s).`);
  } else {
    const parts = [
      counts.error ? PAINT.error(`${counts.error} error`) : null,
      counts.warning ? PAINT.warning(`${counts.warning} warning`) : null,
      showInfo && counts.info ? PAINT.info(`${counts.info} info`) : null,
    ].filter(Boolean);
    console.log(`${parts.join(C.dim(" · "))} ${C.dim(`across ${byFile.size} of ${scanned} file(s)`)}`);
  }
}

function main(argv: string[]): number {
  const flags = new Set(argv.filter((a) => a.startsWith("-")));
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const VALUE_FLAGS = new Set(["--ignore", "--fail-on", "--out"]);
  const paths = argv.filter((a, i) => !a.startsWith("-") && !VALUE_FLAGS.has(argv[i - 1] ?? ""));

  if (flags.has("-h") || flags.has("--help")) {
    console.log(USAGE);
    return 0;
  }
  if (flags.has("--rules")) {
    listRules();
    return 0;
  }

  // Foundry has no plugin API, so integration means reading the same config
  // forge reads and linting exactly what it compiles.
  let targets = paths.length ? paths : ["."];
  let foundryNote = "";
  if (flags.has("--foundry")) {
    const project = discoverFoundry(process.cwd());
    if (!project) {
      console.error("arc-lint --foundry: no foundry.toml in the working directory");
      return 2;
    }
    if (project.sources.length === 0) {
      console.error(`arc-lint --foundry: ${project.configPath} names no existing source directories`);
      return 2;
    }
    targets = project.sources;
    foundryNote = `foundry.toml [profile.${project.profile}] → ${project.sources.join(", ")}`;
  }

  const files = targets.flatMap((t) => {
    try {
      return collectFiles(t, flags.has("--include-vendor"));
    } catch (err) {
      console.error(`arc-lint: cannot read ${t}: ${(err as Error).message}`);
      return [];
    }
  });

  if (files.length === 0) {
    console.error("arc-lint: no .sol/.ts/.js files found in " + targets.join(", "));
    return 2;
  }

  const patterns = [
    ...(flags.has("--no-ignore-file") ? [] : loadIgnore(process.cwd())),
    ...parseIgnore(
      argv.reduce<string[]>((acc, a, i) => (argv[i - 1] === "--ignore" ? [...acc, a] : acc), []).join("\n"),
    ),
  ];

  let findings = lintFiles(files, process.cwd(), patterns);
  if (flags.has("--quiet")) findings = findings.filter((f) => f.severity === "error");

  const outPath = arg("--out");
  const emit = (text: string) => {
    if (!outPath) {
      console.log(text);
      return;
    }
    // A report written for a later step (SARIF upload, artifact) must not also
    // be swallowed silently, so say where it went.
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, text.endsWith("\n") ? text : text + "\n");
    console.error(`arc-lint: wrote ${outPath}`);
  };

  if (flags.has("--sarif")) {
    emit(JSON.stringify(toSarif(findings), null, 2));
  } else if (flags.has("--json")) {
    emit(JSON.stringify({ scanned: files.length, findings }, null, 2));
  } else if (flags.has("--github")) {
    for (const line of toAnnotations(findings)) console.log(line);
    console.log(toSummary(findings, files.length));

    // GITHUB_STEP_SUMMARY is where a run's human-readable result belongs; a
    // missing or unwritable path must not fail the lint itself.
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
      try {
        appendFileSync(summaryPath, toStepSummary(findings, files.length));
      } catch (err) {
        console.error(`arc-lint: could not write step summary: ${(err as Error).message}`);
      }
    }
  } else {
    if (foundryNote) console.log(C.dim(`\n${foundryNote}`));
    report(findings, files.length, !flags.has("--no-info") && !flags.has("--quiet"));
  }

  const failOn = arg("--fail-on") ?? "error";
  if (!["error", "warning", "never"].includes(failOn)) {
    console.error(`arc-lint: --fail-on must be error, warning, or never (got "${failOn}")`);
    return 2;
  }
  if (failOn === "never") return 0;
  const blocking: Severity[] = failOn === "warning" ? ["error", "warning"] : ["error"];
  return findings.some((f) => blocking.includes(f.severity)) ? 1 : 0;
}

// Never process.exit() here: it tears down the process before a large --json
// write to a pipe has flushed, silently truncating the output.
process.exitCode = main(process.argv.slice(2));
