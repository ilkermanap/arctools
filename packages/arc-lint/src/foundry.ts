/**
 * Discover a Foundry project's source directories from foundry.toml.
 *
 * Foundry has no plugin system, so integration means being a well-behaved CLI:
 * read the same config forge reads, lint exactly what forge compiles, and skip
 * the dependency tree in `libs`.
 *
 * This is not a general TOML parser. It reads the handful of string and
 * string-array keys under a profile that decide which paths matter, which keeps
 * the package dependency-free.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface FoundryPaths {
  /** Directories to lint, relative to the project root. */
  sources: string[];
  /** Dependency directories to skip. */
  libs: string[];
  /** Which profile was read. */
  profile: string;
  configPath: string;
}

export const FOUNDRY_DEFAULTS: Omit<FoundryPaths, "profile" | "configPath"> = {
  sources: ["src", "script", "test"],
  libs: ["lib"],
};

/** Strip comments and surrounding quotes from a TOML scalar. */
function scalar(raw: string): string {
  return raw.replace(/\s*#.*$/, "").trim().replace(/^['"]|['"]$/g, "");
}

function parseValue(raw: string): string[] {
  const value = raw.replace(/\s*#(?=(?:[^'"]*['"][^'"]*['"])*[^'"]*$).*$/, "").trim();
  if (value.startsWith("[")) {
    const inner = value.slice(1, value.lastIndexOf("]"));
    return inner
      .split(",")
      .map((part) => scalar(part))
      .filter((part) => part.length > 0);
  }
  const one = scalar(value);
  return one ? [one] : [];
}

/**
 * Read `src`, `script`, `test`, and `libs` from the given profile, falling back
 * to `profile.default` and then to Foundry's own defaults.
 */
export function parseFoundryToml(text: string, profile = "default"): {
  sources: string[];
  libs: string[];
} {
  const wanted = [`profile.${profile}`, `profile.default`];
  const found = new Map<string, Map<string, string[]>>();
  let section = "";

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(trimmed);
    if (header) {
      section = header[1].replace(/['"]/g, "");
      continue;
    }
    if (!wanted.includes(section)) continue;

    const kv = /^([A-Za-z_][\w-]*)\s*=\s*(.+)$/.exec(trimmed);
    if (!kv) continue;
    if (!found.has(section)) found.set(section, new Map());
    // First occurrence wins, matching how a profile reads top-to-bottom.
    const bucket = found.get(section)!;
    if (!bucket.has(kv[1])) bucket.set(kv[1], parseValue(kv[2]));
  }

  const read = (key: string): string[] | undefined => {
    for (const s of wanted) {
      const v = found.get(s)?.get(key);
      if (v && v.length > 0) return v;
    }
    return undefined;
  };

  const sources = [
    ...(read("src") ?? ["src"]),
    ...(read("script") ?? ["script"]),
    ...(read("test") ?? ["test"]),
  ];

  return {
    // A profile can point several keys at the same directory.
    sources: [...new Set(sources)],
    libs: read("libs") ?? FOUNDRY_DEFAULTS.libs,
  };
}

/**
 * Resolve the paths to lint for a Foundry project, keeping only directories that
 * exist. Returns null when the directory is not a Foundry project.
 */
export function discoverFoundry(root: string, profile = process.env.FOUNDRY_PROFILE ?? "default"): FoundryPaths | null {
  const configPath = join(root, "foundry.toml");
  if (!existsSync(configPath)) return null;

  const parsed = parseFoundryToml(readFileSync(configPath, "utf8"), profile);
  return {
    profile,
    configPath,
    sources: parsed.sources.filter((dir) => existsSync(join(root, dir))),
    libs: parsed.libs,
  };
}
