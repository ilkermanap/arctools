/**
 * GitHub Actions workflow commands, so findings appear inline on the diff of a
 * pull request.
 *
 * https://docs.github.com/actions/reference/workflow-commands-for-github-actions
 */
import type { Finding, Severity } from "./rules.ts";

/** Workflow commands are line-oriented, so these characters must be encoded. */
function escapeData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Property values additionally cannot contain a comma or colon unencoded. */
function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

const COMMAND: Record<Severity, "error" | "warning" | "notice"> = {
  error: "error",
  warning: "warning",
  info: "notice",
};

export function toAnnotations(findings: Finding[]): string[] {
  return findings.map((f) => {
    const props = [
      `file=${escapeProperty(f.file.split("\\").join("/"))}`,
      `line=${f.line}`,
      `col=${f.column}`,
      `title=${escapeProperty(`${f.rule}: ${f.message}`)}`,
    ].join(",");
    // Keep the detail on one line: a raw newline would end the command early.
    const body = escapeData(`${f.detail.replace(/\s+/g, " ")} See ${f.doc}`);
    return `::${COMMAND[f.severity]} ${props}::${body}`;
  });
}

/** A one-line-per-severity summary for the job log's final lines. */
export function toSummary(findings: Finding[], scanned: number): string {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  if (findings.length === 0) {
    return `arc-lint: no Arc compatibility issues in ${scanned} file(s)`;
  }
  return (
    `arc-lint: ${counts.error} error, ${counts.warning} warning, ${counts.info} info ` +
    `across ${new Set(findings.map((f) => f.file)).size} of ${scanned} file(s)`
  );
}

/**
 * A GitHub step summary in Markdown, written to $GITHUB_STEP_SUMMARY. Grouped by
 * rule, because the same mistake usually repeats across files.
 */
export function toStepSummary(findings: Finding[], scanned: number): string {
  const lines = ["## arc-lint", ""];

  if (findings.length === 0) {
    lines.push(`No Arc compatibility issues in **${scanned}** file(s).`, "");
    return lines.join("\n");
  }

  const byRule = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byRule.get(f.rule);
    if (list) list.push(f);
    else byRule.set(f.rule, [f]);
  }

  const order: Severity[] = ["error", "warning", "info"];
  const sorted = [...byRule].sort(
    (a, b) =>
      order.indexOf(a[1][0].severity) - order.indexOf(b[1][0].severity) ||
      b[1].length - a[1].length,
  );

  lines.push(`| Severity | Rule | Count | What it means |`, `| :-- | :-- | --: | :-- |`);
  for (const [rule, items] of sorted) {
    const f = items[0];
    lines.push(`| ${f.severity} | [\`${rule}\`](${f.doc}) | ${items.length} | ${f.message} |`);
  }
  lines.push("", "<details><summary>All findings</summary>", "");
  for (const [rule, items] of sorted) {
    lines.push(`**${rule}**`, "");
    for (const f of items) lines.push(`- \`${f.file}:${f.line}:${f.column}\``);
    lines.push("");
  }
  lines.push("</details>", "");
  return lines.join("\n");
}
