/**
 * In-memory index over the mirrored documentation trees.
 *
 * The mirror is a few hundred markdown files totalling a couple of megabytes, so
 * the whole corpus is held in memory and scanned per query. That keeps the server
 * dependency-free and the index always consistent with the files on disk.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface DocPage {
  /** Site key, e.g. "arc" or "circle". */
  site: string;
  /** Path within the site, e.g. "arc/references/gas-and-fees". */
  path: string;
  title: string;
  /** The page's own one-line summary, taken from its `>` blockquote lead. */
  summary: string;
  text: string;
  bytes: number;
}

export interface Hit {
  site: string;
  path: string;
  title: string;
  summary: string;
  score: number;
  /** Matching lines with the query highlighted by «» markers. */
  excerpts: string[];
}

/**
 * Mintlify pages open with a boilerplate index pointer and a `>` summary line.
 * Strip the pointer so it never dominates a search score, and keep the summary.
 */
function parse(raw: string): { title: string; summary: string; body: string } {
  const withoutPointer = raw.replace(
    /^>\s*##\s*Documentation Index[\s\S]*?further\.\s*/m,
    "",
  );
  const title = /^#\s+(.+)$/m.exec(withoutPointer)?.[1]?.trim() ?? "";
  const summary =
    /^#\s+.+\n+>\s*(.+(?:\n>\s*.+)*)/m
      .exec(withoutPointer)?.[1]
      ?.replace(/\n>\s*/g, " ")
      .trim() ?? "";
  return { title, summary, body: withoutPointer };
}

export function loadSite(site: string, dir: string): DocPage[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];

  const files: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
    }
  };
  walk(dir);

  return files
    .map((file) => {
      const raw = readFileSync(file, "utf8");
      const { title, summary, body } = parse(raw);
      const path = relative(dir, file).split(sep).join("/").replace(/\.md$/, "");
      return { site, path, title: title || path, summary, text: body, bytes: raw.length };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export class DocIndex {
  pages: DocPage[] = [];
  #bySite = new Map<string, Map<string, DocPage>>();

  add(pages: DocPage[]): this {
    for (const page of pages) {
      this.pages.push(page);
      if (!this.#bySite.has(page.site)) this.#bySite.set(page.site, new Map());
      this.#bySite.get(page.site)!.set(page.path, page);
    }
    return this;
  }

  get sites(): { site: string; pages: number; bytes: number }[] {
    return [...this.#bySite].map(([site, pages]) => ({
      site,
      pages: pages.size,
      bytes: [...pages.values()].reduce((a, p) => a + p.bytes, 0),
    }));
  }

  get(site: string, path: string): DocPage | undefined {
    return this.#bySite.get(site)?.get(path);
  }

  list(site?: string): DocPage[] {
    const pages = site ? [...(this.#bySite.get(site)?.values() ?? [])] : this.pages;
    return pages.map((p) => ({ ...p, text: "" }));
  }

  /**
   * Rank pages for a query. Title and summary matches outrank body matches,
   * because a phrase in a heading is what the reader is usually looking for.
   */
  search(query: string, limit = 20): Hit[] {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    if (terms.length === 0) return [];

    const hits: Hit[] = [];
    for (const page of this.pages) {
      const title = page.title.toLowerCase();
      const summary = page.summary.toLowerCase();
      const body = page.text.toLowerCase();

      let score = 0;
      let matchedAll = true;
      for (const term of terms) {
        const inTitle = title.includes(term);
        const inSummary = summary.includes(term);
        const bodyCount = body.split(term).length - 1;
        if (!inTitle && !inSummary && bodyCount === 0) {
          matchedAll = false;
          break;
        }
        if (inTitle) score += 40;
        if (inSummary) score += 12;
        score += Math.min(bodyCount, 12);
      }
      if (!matchedAll) continue;

      // An exact phrase match is a much stronger signal than scattered terms.
      if (terms.length > 1 && body.includes(query.toLowerCase())) score += 30;

      hits.push({
        site: page.site,
        path: page.path,
        title: page.title,
        summary: page.summary,
        score,
        excerpts: excerpt(page.text, terms),
      });
    }

    return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
  }
}

/** Up to three matching lines, with each term wrapped in «». */
function excerpt(text: string, terms: string[], max = 3): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length < 12 || trimmed.startsWith("export const")) continue;
    const lower = trimmed.toLowerCase();
    if (!terms.some((t) => lower.includes(t))) continue;

    let marked = trimmed.slice(0, 400);
    for (const term of terms) {
      marked = marked.replace(new RegExp(escapeRegExp(term), "gi"), (m) => `«${m}»`);
    }
    out.push(marked);
    if (out.length >= max) break;
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
