# hardhat-arc-lint

Hardhat 3 task that flags Arc-incompatible Solidity and script patterns.

```bash
npm install --save-dev hardhat-arc-lint
```

```ts
// hardhat.config.ts
import arcLint from "hardhat-arc-lint";

export default {
  plugins: [arcLint],
};
```

```bash
npx hardhat arc-lint
npx hardhat arc-lint --format sarif --out arc-lint.sarif
npx hardhat arc-lint --fail-on warning
npx hardhat arc-lint -- contracts/vault      # explicit paths
```

```
arc-lint: Hardhat has no configured script path; also linting scripts
arc-lint: hardhat → contracts, scripts

contracts/Raffle.sol
  ✖ 11:59  block.prevrandao is always 0 on Arc  (arc/no-prevrandao)
      Arc has no beacon-chain RANDAO mix, so block.prevrandao is hardcoded to 0.
      Any contract deriving randomness from it is fully predictable.
      https://docs.arc.io/arc/references/evm-differences

scripts/deploy.ts
  ✖ 2:23  maxFeePerGas is 5 Gwei, below the 20 Gwei floor  (arc/gas-fee-floor)

arc-lint: 4 error, 0 warning, 0 info across 2 of 2 file(s)
Error in community plugin arc-lint: found 4 error-or-worse finding(s).
```

## Options

| Option | Default | |
|---|---|---|
| `[paths...]` | Hardhat's own paths | Positional; explicit paths skip all inference |
| `--format` | `text` | `text`, `json`, `sarif`, or `github` |
| `--out` | stdout | File for `json`/`sarif` output |
| `--fail-on` | `error` | `error`, `warning`, or `never` |
| `--foundry` | off | Also read `src`/`script`/`test` from `foundry.toml` |
| `--include-vendor` | off | Also lint `lib/` and `vendor/` |

## What gets linted

Hardhat's config, not a guess:

- `config.paths.sources.solidity` — an array, since a project can declare several roots
- `config.paths.tests` — the per-runner record (`solidity`, `nodejs`, …)

Hardhat 3's `paths` has **no entry for deploy scripts**, and the script-language
rules — the 20 Gwei fee floor, `parseEther` on a 6-decimal token — fire almost
exclusively there. So `scripts/`, `script/`, `ignition/modules/`, and `deploy/`
are added when they exist, and the task says when it did that.

If Hardhat reports no sources at all, the task falls back to `contracts/` and
`src/` rather than passing silently on zero files. That fallback is judged on
Hardhat's config alone: finding `scripts/` never counts as having found the
sources, or the contracts would be quietly skipped.

`.arclintignore` in the project root is honoured, as are
`// arc-lint-disable-next-line arc/rule-id` comments.

## Failing the build

A lint failure throws `HardhatPluginError`, so it prints as

```
Error in community plugin arc-lint: found 4 error-or-worse finding(s).
```

rather than as a Hardhat crash with a stack trace and a bug-report link.

## Notes

- Requires Hardhat 3 (`peerDependencies: hardhat ^3.0.0`) and Node 22.6+.
- The task action is registered lazily, so importing the plugin costs nothing
  until `arc-lint` actually runs.
- The rules themselves live in [`arc-lint`](../arc-lint). Anything that package
  learns, this task gets.

## Tests

```bash
node --test 'test/*.test.ts'
```

13 tests covering path resolution, with no Hardhat runtime needed — the resolver
takes the config shape structurally.
