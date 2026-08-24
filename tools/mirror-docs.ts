#!/usr/bin/env node
/**
 * Mirror a Mintlify documentation site to a local markdown tree.
 *
 * Starts from the site's llms.txt, then follows internal links breadth-first.
 * Mintlify serves a markdown source for every page at `<path>.md`, so the mirror
 * is the real prose rather than scraped HTML.
 *
 * Usage:
 *   node tools/mirror-docs.ts                        # Arc docs -> ./docs
 *   node tools/mirror-docs.ts --site circle          # Circle platform -> ./docs-circle
 *   node tools/mirror-docs.ts --origin https://x.io --out docs-x
 *   node tools/mirror-docs.ts --dry-run --concurrency 2
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const SITES: Record<string, { origin: string; out: string; label: string }> = {
  arc: { origin: "https://docs.arc.io", out: "docs", label: "Arc" },
  circle: {
    origin: "https://developers.circle.com",
    out: "docs-circle",
    label: "Circle Developer Platform",
  },
};

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const site = SITES[arg("site", "arc")];
if (!site) {
  console.error(`unknown --site; choose one of: ${Object.keys(SITES).join(", ")}`);
  process.exit(2);
}

const ORIGIN = arg("origin", site.origin);
const LABEL = ORIGIN === site.origin ? site.label : ORIGIN;
const SEED = `${ORIGIN}/llms.txt`;
const OUT = arg("out", ORIGIN === site.origin ? site.out : "docs-mirror");
const CONCURRENCY = Number(arg("concurrency", "4"));
const DRY = argv.includes("--dry-run");
const FORCE = argv.includes("--force");

/** Paths that are assets or listings rather than prose pages. */
const SKIP = /\.(png|jpe?g|svg|gif|webp|ico|css|js|json|xml|txt|pdf|zip)$/i;

/** Normalise a link to a docs path like "arc/references/gas-and-fees". */
function toPath(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href, ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== ORIGIN) return null;

  let p = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!p) return null;
  // Mintlify serves the markdown source at <path>.md; store under the bare path.
  p = p.replace(/\.md$/, "");
  if (SKIP.test(p)) return null;
  return p;
}

/** Pull every internal link out of a markdown/MDX page. */
function extractLinks(markdown: string): string[] {
  const out = new Set<string>();

  // [text](/path) and [text](https://docs.arc.io/path)
  for (const m of markdown.matchAll(/\]\(\s*([^)\s]+)/g)) out.add(m[1]);
  // href="/path" in the JSX components Mintlify pages embed
  for (const m of markdown.matchAll(/href=["']([^"']+)["']/g)) out.add(m[1]);

  return [...out];
}

interface Stats {
  saved: number;
  skipped: number;
  failed: { path: string; reason: string }[];
  bytes: number;
}

async function fetchMarkdown(path: string): Promise<string | null> {
  const url = `${ORIGIN}/${path}.md`;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    try {
      const res = await fetch(url, {
        headers: { accept: "text/markdown, text/plain, */*" },
        signal: AbortSignal.timeout(30_000),
        redirect: "follow",
      });
      if (res.status === 404) return null;
      if (res.status === 429) continue;
      if (!res.ok) continue;
      const text = await res.text();
      // A markdown miss can come back as the SPA shell; reject that.
      if (/^\s*<(!doctype|html)/i.test(text)) return null;
      return text;
    } catch {
      // retry
    }
  }
  throw new Error("unreachable after 4 attempts");
}

async function main(): Promise<number> {
  const seen = new Set<string>();
  const queue: string[] = [];
  const stats: Stats = { saved: 0, skipped: 0, failed: [], bytes: 0 };
  const saved: { path: string; title: string; bytes: number }[] = [];

  console.log(`Seeding from ${SEED}`);
  const seedRes = await fetch(SEED, { signal: AbortSignal.timeout(30_000) });
  if (!seedRes.ok) throw new Error(`seed fetch failed: HTTP ${seedRes.status}`);
  const seedText = await seedRes.text();

  if (!DRY) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "llms.txt"), seedText);
  }

  for (const href of extractLinks(seedText)) {
    const p = toPath(href);
    if (p && !seen.has(p)) {
      seen.add(p);
      queue.push(p);
    }
  }
  console.log(`  ${queue.length} pages from the index\n`);

  let cursor = 0;
  let active = 0;
  let done = 0;

  await new Promise<void>((resolve) => {
    const pump = () => {
      while (active < CONCURRENCY && cursor < queue.length) {
        const path = queue[cursor++];
        active++;
        (async () => {
          try {
            const md = await fetchMarkdown(path);
            if (md === null) {
              stats.skipped++;
              return;
            }

            const title = (/^#\s+(.+)$/m.exec(md)?.[1] ?? path).trim();
            const file = join(OUT, `${path}.md`);
            if (!DRY && (FORCE || !existsSync(file))) {
              mkdirSync(dirname(file), { recursive: true });
              writeFileSync(file, md);
            }
            stats.saved++;
            stats.bytes += md.length;
            saved.push({ path, title, bytes: md.length });

            // Follow onward links, so pages absent from llms.txt still land.
            for (const href of extractLinks(md)) {
              const next = toPath(href);
              if (next && !seen.has(next)) {
                seen.add(next);
                queue.push(next);
              }
            }
          } catch (err) {
            stats.failed.push({ path, reason: (err as Error).message });
          } finally {
            active--;
            done++;
            if (done % 20 === 0) {
              process.stdout.write(`  ${done}/${queue.length} fetched (queue still growing)\r`);
            }
            if (cursor >= queue.length && active === 0) resolve();
            else pump();
          }
        })();
      }
    };
    pump();
  });

  saved.sort((a, b) => a.path.localeCompare(b.path));

  if (!DRY) {
    const index = [
      `# ${LABEL} documentation mirror`,
      "",
      `Mirrored from ${ORIGIN} with \`node tools/mirror-docs.ts --site ${arg("site", "arc")}\`.`,
      `${saved.length} pages, ${(stats.bytes / 1024).toFixed(0)} KB.`,
      "",
      "| Page | Title |",
      "| :--- | :---- |",
      ...saved.map((s) => `| [\`${s.path}\`](${s.path}.md) | ${s.title.replace(/\|/g, "\\|")} |`),
      "",
    ].join("\n");
    writeFileSync(join(OUT, "INDEX.md"), index);
  }

  console.log(`\n\nsaved    ${stats.saved} pages (${(stats.bytes / 1024).toFixed(0)} KB)`);
  console.log(`no .md   ${stats.skipped} links`);
  if (stats.failed.length) {
    console.log(`failed   ${stats.failed.length}`);
    for (const f of stats.failed.slice(0, 10)) console.log(`  ${f.path}: ${f.reason}`);
  }
  return stats.failed.length ? 1 : 0;
}

process.exitCode = await main();
