/**
 * Deciding what to lint in a Hardhat project.
 *
 * Kept separate from the task action so it can be unit-tested without a
 * Hardhat runtime: the action is a thin wrapper around this.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { discoverFoundry } from "../../arc-lint/src/foundry.ts";

/** The slice of the Hardhat runtime environment this plugin reads. */
export interface HreLike {
  config: {
    paths: {
      root: string;
      sources: { solidity?: string[] } & Record<string, unknown>;
      tests?: Record<string, unknown>;
    };
  };
}

export interface ResolveOptions {
  /** Explicit paths from the CLI. When present, nothing is inferred. */
  paths?: string[];
  /** Also read src/script/test from foundry.toml, for a hybrid repo. */
  foundry?: boolean;
  /** Skip paths that do not exist. Off in tests that assert on intent. */
  requireExisting?: boolean;
}

export interface ResolvedPaths {
  /** Absolute paths to hand to arc-lint. */
  targets: string[];
  /** Where each target came from, for the task's log line. */
  origin: "explicit" | "hardhat" | "hardhat+foundry" | "fallback";
  notes: string[];
}

/**
 * Conventional deploy-script locations.
 *
 * Hardhat 3's `paths` covers sources, tests, cache, and artifacts — there is no
 * configured path for deploy scripts. The script-language rules (the 20 Gwei
 * floor, parseEther on a 6-decimal token) fire almost exclusively there, so
 * skipping them would miss the findings that matter most. These are added only
 * when the directory exists, and the task logs that it did so.
 */
const CONVENTIONAL_SCRIPT_DIRS = ["scripts", "script", "ignition/modules", "deploy"];

/**
 * Where contracts live when Hardhat's config tells us nothing. Kept separate
 * from the script directories: finding `scripts/` must not be mistaken for
 * having found the sources, or the contracts would be silently skipped.
 */
const CONVENTIONAL_SOURCE_DIRS = ["contracts", "src"];

/**
 * Resolve lint targets from Hardhat's own config, so the plugin lints exactly
 * what Hardhat compiles rather than guessing directory names.
 *
 * Hardhat 3 exposes `paths.sources.solidity` as an array of absolute paths,
 * because a project can declare several source roots. `paths.tests` is a record
 * of per-runner directories. Neither covers deploy scripts, so see
 * CONVENTIONAL_SCRIPT_DIRS.
 */
export function resolveLintPaths(hre: HreLike, options: ResolveOptions = {}): ResolvedPaths {
  const { root } = hre.config.paths;
  const { paths, foundry = false, requireExisting = true } = options;
  const notes: string[] = [];

  const absolute = (p: string) => (isAbsolute(p) ? p : join(root, p));
  const keep = (list: string[]) =>
    requireExisting ? list.filter((p) => existsSync(p)) : list;

  if (paths && paths.length > 0) {
    return { targets: keep(paths.map(absolute)), origin: "explicit", notes };
  }

  // What Hardhat itself declares. Judged on its own, so a conventional
  // directory found later cannot mask an empty Hardhat config.
  const fromHardhat = new Set<string>();
  for (const dir of hre.config.paths.sources.solidity ?? []) fromHardhat.add(absolute(dir));

  // `paths.tests` is a record of per-runner directories (solidity, mocha, …).
  for (const value of Object.values(hre.config.paths.tests ?? {})) {
    if (typeof value === "string") fromHardhat.add(absolute(value));
    else if (Array.isArray(value)) {
      for (const v of value) if (typeof v === "string") fromHardhat.add(absolute(v));
    }
  }

  const collected = new Set<string>(fromHardhat);
  let origin: ResolvedPaths["origin"] = "hardhat";

  if (fromHardhat.size === 0) {
    // Linting nothing at all would be a silent pass, which is worse than a guess.
    origin = "fallback";
    const guessed = CONVENTIONAL_SOURCE_DIRS.map(absolute).filter((p) => existsSync(p));
    for (const dir of guessed) collected.add(dir);
    notes.push(
      guessed.length > 0
        ? `Hardhat reported no source paths; falling back to ` +
          `${guessed.map((d) => relative(root, d)).join(", ")}`
        : "Hardhat reported no source paths, and no conventional source directory exists",
    );
  }

  const scriptDirs = CONVENTIONAL_SCRIPT_DIRS.map(absolute).filter((p) => existsSync(p));
  for (const dir of scriptDirs) collected.add(dir);
  if (scriptDirs.length > 0) {
    notes.push(
      `Hardhat has no configured script path; also linting ` +
        `${scriptDirs.map((d) => relative(root, d)).join(", ")}`,
    );
  }

  if (foundry) {
    const project = discoverFoundry(root);
    if (project) {
      for (const dir of project.sources) collected.add(absolute(dir));
      origin = "hardhat+foundry";
      notes.push(`foundry.toml [profile.${project.profile}] → ${project.sources.join(", ")}`);
    } else {
      notes.push("--foundry was passed but no foundry.toml is present");
    }
  }

  return { targets: keep([...collected]), origin, notes };
}

/** Render a target list relative to the project root, for logging. */
export function describeTargets(root: string, targets: string[]): string {
  return targets.map((t) => relative(root, t) || ".").join(", ");
}
