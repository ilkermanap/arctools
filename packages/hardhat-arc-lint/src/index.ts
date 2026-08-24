/**
 * Hardhat 3 plugin: `npx hardhat arc-lint`.
 *
 * Lints exactly what Hardhat compiles, by reading `config.paths` rather than
 * guessing directory names.
 *
 *   // hardhat.config.ts
 *   import arcLint from "hardhat-arc-lint";
 *   export default { plugins: [arcLint] };
 *
 * The action is registered lazily, so importing this plugin costs nothing until
 * the task runs.
 */
import { ArgumentType } from "hardhat/types/arguments";
import { task } from "hardhat/config";
import { definePlugin } from "hardhat/plugins";

const plugin = definePlugin({
  id: "arc-lint",
  npmPackage: "hardhat-arc-lint",
  tasks: [
    task("arc-lint", "Flag Arc-incompatible Solidity and script patterns")
      .addVariadicArgument({
        name: "paths",
        description: "Paths to lint. Defaults to Hardhat's configured sources and tests.",
        defaultValue: [],
      })
      .addFlag({
        name: "foundry",
        description: "Also read src/script/test from foundry.toml, for a hybrid repo",
      })
      .addFlag({
        name: "includeVendor",
        description: "Also lint lib/ and vendor/ dependency directories",
      })
      .addOption({
        name: "failOn",
        description: 'Fail on "error" (default), "warning", or "never"',
        type: ArgumentType.STRING,
        defaultValue: "error",
      })
      .addOption({
        name: "format",
        description: "text (default), json, sarif, or github",
        type: ArgumentType.STRING,
        defaultValue: "text",
      })
      .addOption({
        name: "out",
        description: "Write json/sarif output to this file instead of stdout",
        type: ArgumentType.STRING,
        defaultValue: "",
      })
      // The lazy form is what Hardhat requires for a published plugin.
      .setAction(() => import("./task.ts"))
      .build(),
  ],
});

export default plugin;
