/**
 * Build for npm.
 *
 * The repo runs TypeScript directly with `node file.ts`, but Node refuses to
 * strip types inside node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING),
 * so a published package has to ship JavaScript. esbuild emits the JS, tsc emits
 * the declarations.
 *
 * Imports are written as `./x.ts` for the source-run path; esbuild rewrites them
 * to `./x.js` on the way out.
 */
import { build } from "esbuild";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const entries = readdirSync("src")
  .filter((f) => f.endsWith(".ts"))
  .map((f) => join("src", f));

rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints: entries,
  outdir: "dist",
  platform: "node",
  target: "node22",
  format: "esm",
  // Preserve the file layout so deep imports keep working, and keep the output
  // readable -- this is a lint tool, people will look at it.
  bundle: false,
  sourcemap: true,
  logLevel: "info",
});

// esbuild leaves relative specifiers alone, so ./rules.ts must become ./rules.js.
const { readFileSync, writeFileSync } = await import("node:fs");
for (const f of readdirSync("dist").filter((f) => f.endsWith(".js"))) {
  const p = join("dist", f);
  writeFileSync(p, readFileSync(p, "utf8").replace(/(from\s+["']\.\/[^"']+)\.ts(["'])/g, "$1.js$2"));
}
console.log(`rewrote .ts specifiers in ${entries.length} file(s)`);
