# arc-lint

Flag Arc-incompatible Solidity and script patterns before you deploy.

Arc is EVM-compatible, so existing contracts *compile and deploy* unchanged.
That is the problem: the places where Arc's semantics differ from Ethereum's are
invisible to the compiler and to `anvil`, which runs a stock EVM. `arc-lint`
catches them by reading source.

```bash
node src/cli.ts contracts/ scripts/
node src/cli.ts --rules
node src/cli.ts . --json --quiet
node src/cli.ts --foundry                       # read foundry.toml
node src/cli.ts --sarif --out arc-lint.sarif    # GitHub code scanning
node src/cli.ts --github                        # PR annotations
```

Exit code is 1 when any error-severity finding remains, so it drops into CI as-is.
Use `--fail-on warning` to tighten that, or `--fail-on never` to report without
blocking.

## Integrations

| | |
|---|---|
| **Foundry** | `--foundry` reads `src`/`script`/`test`/`libs` from `foundry.toml`, honouring `FOUNDRY_PROFILE`, so it lints exactly what `forge` compiles and skips the dependency tree |
| **Hardhat 3** | [`hardhat-arc-lint`](../hardhat-arc-lint) adds `npx hardhat arc-lint`, reading Hardhat's own `config.paths` |
| **GitHub Actions** | [`action.yml`](action.yml) in this package — annotates the diff, writes a step summary, or emits SARIF for the Security tab |

```yaml
- uses: your-org/arcio-tools/packages/arc-lint@main
  with:
    foundry: "true"
    format: sarif        # or github (default) / text
    fail-on: error
```

The action exposes `errors`, `warnings`, `findings`, and `sarif-file` as step
outputs. See [`.github/workflows/arc-lint.yml`](../../.github/workflows/arc-lint.yml)
for a working two-job setup: inline annotations on the PR, and a SARIF upload to
code scanning.

## Rules

| Rule | Severity | Catches |
|---|---|---|
| `arc/decimals-mix` | error | An 18-decimal literal in a file that also uses the 6-decimal ERC-20 USDC interface |
| `arc/no-prevrandao` | error | `block.prevrandao` / `block.difficulty`, both hardcoded to `0` |
| `arc/no-assembly-prevrandao` | error | The same read from inline assembly |
| `arc/no-blob-opcodes` | error | `blobhash`, `blobbasefee` — blob txs are rejected |
| `arc/no-beacon-roots` | error | EIP-4788 beacon roots; the contract is not deployed |
| `arc/burn-to-zero-address` | error | Native value to `address(0)`, which reverts |
| `arc/gas-fee-floor` | error | `maxFeePerGas` below Arc's 20 Gwei floor |
| `arc/wrong-usdc-decimals` | error | `parseEther` / `parseUnits(x, 18)` on an ERC-20 call |
| `arc/selfdestruct-value-rules` | warning | `SELFDESTRUCT` under Arc's extra native-value rules |
| `arc/balanceof-zero-is-not-empty` | warning | `balanceOf(x) == 0`, which truncation makes unreliable |
| `arc/ether-unit-is-usdc` | warning | The `ether` unit, which denominates USDC here |
| `arc/hardcoded-eth-rpc` | warning | localhost RPCs that cannot reproduce Arc semantics |
| `arc/unnecessary-weth-wrapper` | info | A wrapper Arc does not need |
| `arc/prefer-multicall3from` | info | `Multicall3`, where Arc's `Multicall3From` keeps `msg.sender` |

## Suppression

```solidity
// arc-lint-disable-next-line arc/decimals-mix
uint256 amount = 1e18;
```

Omit the rule id to mute every rule on that line, or use `arc-lint-disable-line`
for the current one. Whole paths go in `.arclintignore`:

```
packages/arc-lint/src/rules.ts
test/fixtures/
*.generated.sol
```

A pattern containing `*` is anchored and matches the whole path; a pattern
without one matches as a substring.

## How it works

Comments and string literals are blanked in place — preserving byte offsets, so
line and column stay exact — and rules match against that. Solidity rules see
strings blanked, which keeps revert messages from tripping them. Script rules see
strings intact, because the values they check (`parseGwei("5")`, RPC URLs) live
inside strings. String literals are always *parsed*, even when kept, so a URL
containing `//` does not read as a comment.

Rules are regex-based over that stripped source rather than AST-based. That keeps
`arc-lint` compiler-free and instant, at the cost of precision: `arc/decimals-mix`
flags every `1e18` in a file that touches `IERC20` rather than following a single
value through assignments. AST rules via `solc --standard-json` are the next step.

## Tests

```bash
node --test 'test/*.test.ts'
```

33 tests, fully offline. `test/fixtures/Bad.sol` is expected to trip ten rules
exactly once each; `Good.sol` must stay clean. The rest pin the SARIF and
annotation encodings and the `foundry.toml` reader.
