/**
 * SARIF 2.1.0 output, so findings land in GitHub's Security tab as code
 * scanning alerts rather than scrolling past in a log.
 *
 * https://docs.github.com/code-security/code-scanning/integrating-with-code-scanning/sarif-support-for-code-scanning
 */
import { RULES, type Finding, type Severity } from "./rules.ts";

export const VERSION = "0.1.0";
const INFORMATION_URI = "https://docs.arc.io/arc/references/evm-differences";

/** SARIF has no "info" level; the nearest is "note". */
const LEVEL: Record<Severity, "error" | "warning" | "note"> = {
  error: "error",
  warning: "warning",
  info: "note",
};

export function toSarif(findings: Finding[]): unknown {
  // Only rules that actually fired need to be declared, but declaring all of
  // them keeps ruleIndex stable across runs, which GitHub prefers for alert
  // continuity.
  const ruleIndex = new Map(RULES.map((rule, i) => [rule.id, i]));

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "arc-lint",
            version: VERSION,
            informationUri: INFORMATION_URI,
            rules: RULES.map((rule) => ({
              id: rule.id,
              name: rule.id.replace(/[^A-Za-z0-9]+(.)/g, (_m, c: string) => c.toUpperCase()),
              shortDescription: { text: rule.title },
              fullDescription: { text: rule.detail },
              helpUri: rule.doc,
              help: { text: `${rule.detail}\n\n${rule.doc}` },
              defaultConfiguration: { level: LEVEL[rule.severity] },
              properties: {
                tags: ["arc", "evm-compatibility", ...rule.langs],
                problem: { severity: LEVEL[rule.severity] },
              },
            })),
          },
        },
        results: findings.map((f) => ({
          ruleId: f.rule,
          ruleIndex: ruleIndex.get(f.rule) ?? 0,
          level: LEVEL[f.severity],
          message: { text: `${f.message} — ${f.detail}` },
          locations: [
            {
              physicalLocation: {
                // SARIF wants a relative URI with forward slashes on every platform.
                artifactLocation: { uri: f.file.split("\\").join("/") },
                region: {
                  startLine: f.line,
                  startColumn: f.column,
                  ...(f.snippet ? { snippet: { text: f.snippet } } : {}),
                },
              },
            },
          ],
        })),
      },
    ],
  };
}
