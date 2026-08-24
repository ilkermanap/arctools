import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { stripNonCode, positionAt, lineTextAt } from "./source.ts";
import { rulesFor, type Finding, type Lang, type RuleContext } from "./rules.ts";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "out", "cache", "artifacts", "typechain", "typechain-types",
  "coverage", "dist", "build", ".next", "broadcast", "forge-cache",
]);

// Dependency-managed Solidity: linting vendored OpenZeppelin adds noise, not signal.
const VENDOR_DIRS = new Set(["lib", "vendor"]);

/**
 * Patterns from a .arclintignore file. `*` matches any run of characters; every
 * other character is literal, and a pattern with no `*` matches as a substring
 * of the path. Paths are compared with forward slashes on every platform.
 */
export function parseIgnore(text: string): RegExp[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((pattern) => {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      const body = escaped.replace(/\*/g, ".*");
      return new RegExp(pattern.includes("*") ? `^${body}$` : body);
    });
}

export function loadIgnore(root: string): RegExp[] {
  const file = join(root, ".arclintignore");
  return existsSync(file) ? parseIgnore(readFileSync(file, "utf8")) : [];
}

export function isIgnored(relPath: string, patterns: RegExp[]): boolean {
  const normalised = relPath.split(sep).join("/");
  return patterns.some((re) => re.test(normalised));
}

const LANG_BY_EXT: Record<string, Lang> = {
  ".sol": "solidity",
  ".ts": "script",
  ".tsx": "script",
  ".js": "script",
  ".jsx": "script",
  ".mjs": "script",
  ".cjs": "script",
};

export function langOf(file: string): Lang | null {
  return LANG_BY_EXT[extname(file).toLowerCase()] ?? null;
}

export function collectFiles(target: string, includeVendor = false): string[] {
  const st = statSync(target);
  if (st.isFile()) return langOf(target) ? [target] : [];

  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (!includeVendor && VENDOR_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".") continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile() && langOf(entry.name)) {
        out.push(join(dir, entry.name));
      }
    }
  };
  walk(target);
  return out.sort();
}

/** `// arc-lint-disable-next-line [rule]` and `// arc-lint-disable-line [rule]`. */
function suppressions(raw: string): { line: number; rule: string | null }[] {
  const out: { line: number; rule: string | null }[] = [];
  raw.split("\n").forEach((text, idx) => {
    const m = /arc-lint-disable-(next-line|line)(?:\s+([\w/-]+))?/.exec(text);
    if (!m) return;
    const line = m[1] === "next-line" ? idx + 2 : idx + 1;
    out.push({ line, rule: m[2] ?? null });
  });
  return out;
}

export function lintSource(raw: string, file: string, lang: Lang): Finding[] {
  const code = stripNonCode(raw, true);
  const text = stripNonCode(raw, false);
  const ctx: RuleContext = { code, text, raw, file, lang };
  const muted = suppressions(raw);
  const findings: Finding[] = [];

  for (const rule of rulesFor(lang)) {
    for (const match of rule.find(ctx)) {
      const { line, column } = positionAt(raw, match.offset);
      if (muted.some((s) => s.line === line && (s.rule === null || s.rule === rule.id))) continue;
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        file,
        line,
        column,
        message: match.message ?? rule.title,
        detail: rule.detail,
        doc: rule.doc,
        snippet: lineTextAt(raw, match.offset).trim(),
      });
    }
  }

  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

export function lintFiles(
  files: string[],
  root = process.cwd(),
  ignore: RegExp[] = loadIgnore(root),
): Finding[] {
  const out: Finding[] = [];
  for (const file of files) {
    const lang = langOf(file);
    if (!lang) continue;
    const rel = relative(root, file) || file;
    if (isIgnored(rel, ignore)) continue;
    out.push(...lintSource(readFileSync(file, "utf8"), rel, lang));
  }
  return out;
}
