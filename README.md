# arctools

Developer tooling for [Arc](https://arc.io), Circle's stablecoin-native Layer-1
where **USDC is the native gas token**.

**→ [arctools.mynodes.xyz](https://arctools.mynodes.xyz)**

Four CLIs, a Hardhat plugin, two indexer adapters, and a GitHub Action — no
dependencies, no build step. Node ≥ 22.6 runs the TypeScript directly.

```bash
npm run arc-lint   -- contracts/          # catch Arc-incompatible code pre-deploy
npm run arc-index  -- scan --blocks 200   # index USDC without double-counting
npm run arc-agents -- count               # read the ERC-8004 agent registry
npm run serve                             # dev console at localhost:8787
npm run mirror-docs                       # mirror the docs for offline search
npm test                                  # 106 tests, all offline
```

## Why these three

Circle already ships nine sample apps covering commerce, P2P payments, escrow,
nanopayments, multichain wallets, treasury, stablecoin FX, lend/borrow, and
prediction markets. Building a tenth app is not where the gap is.

The gap is that Arc diverges from Ethereum in ways that make *correct* code look
wrong and *wrong* code look fine, and the standard toolchain says nothing:

| Hazard | What breaks | Tool |
|---|---|---|
| Native USDC is 18 decimals, the ERC-20 view is 6 — same balance | A `1e18` amount passed to `transfer()` is 10¹² too large | `arc-lint` |
| `block.prevrandao` is hardcoded to `0` | Lotteries and shuffles become fully predictable | `arc-lint` |
| Native transfer to `address(0)` reverts | Burn-by-sending patterns fail at runtime | `arc-lint` |
| One `transfer()` emits **two** `Transfer` logs, from two emitters | Indexers double-count; **+67.5% phantom rows** measured live | `arc-index` |
| Self-transfers log on the ERC-20 side only | Indexers invent balance changes that never happened | `arc-index` |
| `AgentIdentity` has no `totalSupply()`, and its logs predate any cheap window | No way to enumerate 885 423 registered agents | `arc-agents` |

Every rule and every claim above traces to a specific line in Arc's docs or to a
live RPC observation. See [ARC-NOTES.md](ARC-NOTES.md) for the full research
trail, including five gaps in Arc's own documentation.

### Prior art

[`arc-lint` by Egor Galkin](https://github.com/Ega741/arc-lint) (npm `arc-lint`,
first published 2026-08-07) covers the same ground for Solidity, and does it with
**solc AST analysis** rather than the pattern matching here — which is more precise,
and includes a contract-level rule that reasons across functions and inheritance.
If you only need Solidity checks, look at it first.

The two overlap on five hazards (prevrandao, the decimal mix, selfdestruct, WETH
wrappers, zero-address sends) and diverge either side of that:

| | this repo | Ega741/arc-lint |
|---|---|---|
| Analysis | pattern matching over stripped source | solc AST, with a degraded parse-only mode |
| Deploy scripts (`.ts`/`.js`) | yes — the fee floor and `parseEther` rules live there | no |
| Foundry / Hardhat / SARIF | yes | GitHub annotations, JSON, markdown |
| Sub-second timestamp deltas | **no** — a real hazard, covered there as ARC002 | yes |
| Blob opcodes, beacon roots, `balanceOf() == 0`, `ether` unit, Multicall3From | yes | no |

`arc-index` and `arc-agents` have no equivalent I could find on npm.

---

## arc-lint

Static analysis for Arc's protocol-level divergences from Ethereum. Reads
Solidity and deploy/test scripts, needs no compiler, and every finding cites the
doc page that justifies it.

```bash
npm run arc-lint -- contracts/ scripts/
npm run arc-lint -- --rules          # list all 14 rules
npm run arc-lint -- . --json         # CI-friendly
```

```
Bad.sol
  17:59   error   block.prevrandao is always 0 on Arc  arc/no-prevrandao
          │ uint256 seed = uint256(keccak256(abi.encodePacked(block.prevrandao, …)));
          → Arc has no beacon-chain RANDAO mix, so block.prevrandao is hardcoded
            to 0. Any contract deriving randomness from it is fully predictable.
          https://docs.arc.io/arc/references/evm-differences
```

14 rules across two languages: the decimal trap, `PREVRANDAO` (expression and
assembly), blob opcodes, EIP-4788 beacon roots, `SELFDESTRUCT` value rules,
zero-address burns, `balanceOf() == 0`, the `ether` unit, redundant WETH
wrappers, `Multicall3` vs Arc's `Multicall3From`, the 20 Gwei fee floor,
`parseEther` on a 6-decimal token, and localhost RPCs that cannot reproduce Arc.

Exit code is 1 on any error-severity finding (`--fail-on warning|never` to
change that). Suppress a line with `// arc-lint-disable-next-line arc/rule-id`,
or whole paths with `.arclintignore`.

**It plugs into what you already run:**

```bash
npx hardhat arc-lint                       # Hardhat 3 task
node src/cli.ts --foundry                  # reads foundry.toml
node src/cli.ts --sarif --out arc.sarif    # GitHub code scanning
```

| Integration | |
|---|---|
| [`hardhat-arc-lint`](packages/hardhat-arc-lint) | A Hardhat 3 plugin that lints `config.paths` — plus the deploy-script directories Hardhat has no config entry for, where the gas-floor and decimal rules actually fire |
| `--foundry` | Reads `src`/`script`/`test`/`libs` from `foundry.toml`, honouring `FOUNDRY_PROFILE`. Foundry has no plugin API, so integration means reading the same config `forge` does |
| [`action.yml`](packages/arc-lint/action.yml) | A composite GitHub Action: inline PR annotations, a step summary, or SARIF for the Security tab |

[→ packages/arc-lint](packages/arc-lint)

## arc-index

Arc logs every USDC movement from a native system emitter (18 decimals,
EIP-7708) and *additionally* from the ERC-20 contract (6 decimals) when the
movement went through the token interface. Both use the same `Transfer` topic.

`arc-index` treats the native emitter as the single source of truth and uses the
ERC-20 stream only to label how each movement was initiated.

```bash
npm run arc-index -- scan --blocks 150
npm run arc-index -- reconcile --address 0x… --blocks 60
npm run arc-index -- top --blocks 60 --limit 5
```

```
  raw logs
    native emitter (18 dec)   1589
    ERC-20 emitter (6 dec)    1073

  canonical movements         1589
    initiated via ERC-20      1066  (logged twice by the chain)
    plain native sends        523   (logged once)
    sub-6-decimal dust        57    (invisible to balanceOf)

  ERC-20 logs the native emitter deliberately omits
    self-transfers            7  (from == to, no balance change)

  what a naive indexer gets wrong
    transfer rows             2662 vs 1589 real  (+67.5% phantom rows)
    volume, no dedup          11507.064102 USDC  (+83.1%)
    volume, canonical         6284.280334 USDC
```

`reconcile` proves an index rather than trusting it: replay the movements for an
address and compare against `eth_getBalance`. A zero residual means every wei is
accounted for; a negative residual is gas, which EIP-7708 does not log.

**The dedup rule ships where people already build indexers.** It lives as a pure
function over normalised logs in
[`arc-index/src/core.ts`](packages/arc-index/src/core.ts), with no RPC or
framework dependency, so all three consumers agree on what a movement is:

| Adapter | Shape |
|---|---|
| [`arc-index-subsquid`](packages/arc-index-subsquid) | SQD hands you whole blocks, so both streams for a transaction are in one batch — `movementsFromBatch(ctx.blocks)` and you are done. Note SQD publishes **no gateway for Arc**, so ingestion is RPC-only |
| [`arc-index-ponder`](packages/arc-index-ponder) | Ponder is event-at-a-time, so there is no batch to pair in. Instead: the native emitter's events create every row, and ERC-20 events *update* the row they duplicate — which is safe only because Arc emits the native log first |

Each ships a complete example project, and neither depends on the framework it
adapts: events and batches are accepted structurally, so both are testable
offline.

[→ packages/arc-index](packages/arc-index)

## arc-agents

Reads the ERC-8004 identity and reputation registries — the substrate for Arc's
agentic economy, and Circle's stated top grant priority.

```bash
npm run arc-agents -- count
npm run arc-agents -- list --from 0 --limit 20 --resolve
npm run arc-agents -- show 1
npm run arc-agents -- reputation 4
```

```
  registered agents   885423
  highest token id    885422
  cost                41 eth_calls
```

`AgentIdentity` is a plain ERC-721 with no `totalSupply()`, and there are zero
registry logs in the last 6M blocks, so a log backfill would burn ~590
`eth_getLogs` calls before finding anything. Ids are sequential, so an
exponential probe plus binary search over `ownerOf` answers the same question in
41 calls.

[→ packages/arc-agents](packages/arc-agents)

## arc-server

A local dev console over the same three packages, plus full-text search across
**636 mirrored documentation pages** (108 from Arc, 528 from the Circle
Developer Platform).

```bash
npm run serve            # http://127.0.0.1:8787
```

Five tabs — chain status, the USDC index with its dedup numbers, the agent
registry, a paste-and-lint box, and offline doc search. Every tab is a thin
client over a JSON API that is equally usable from `curl`, an editor extension,
or CI:

```bash
curl -s localhost:8787/api/index/scan?blocks=150 | jq .stats
curl -s -X POST localhost:8787/api/lint -H 'content-type: application/json' \
  -d '{"lang":"solidity","source":"…"}'
```

Docs are mirrored ahead of time by `tools/mirror-docs.ts`, which starts from each
site's `llms.txt` and follows internal links — so pages missing from the index
still land, and search works with no network at all.

[→ packages/arc-server](packages/arc-server)

---

## Where this fits the grants program

The [Circle Developer Grants Program](https://circle.com/grant) relaunched in
May 2026 with milestone-based USDC funding, and names six priority areas:
agentic economic activity, stablecoin FX, P2P payments, treasury management,
prediction markets, and lending/borrowing.

These three tools are deliberately *underneath* those areas rather than inside
one of them. Anyone building stablecoin FX or a lending market on Arc hits the
decimal trap and the dual-emitter problem on day one, and `arc-agents` reads the
registry every agentic application has to read. Shared infrastructure with no
existing equivalent argues ecosystem impact more cleanly than a tenth sample app.

Delivered so far: the rules run in Foundry, Hardhat, and CI; the dedup rule runs
in Ponder and Subsquid; and the docs are mirrored for offline search.

What would add the most next:

1. **Solidity AST rules via `solc --standard-json`** — the current rules are
   regex-based over comment-stripped source, which is honest but coarse. AST
   analysis would let `arc/decimals-mix` follow a value across assignments
   instead of flagging every `1e18` in a file that touches `IERC20`.
2. **Publish to npm and the GitHub Marketplace** — right now the action is used
   by path, and the packages by workspace reference.
3. **An ERC-8004 agent directory** on top of `arc-agents`: searchable
   capabilities, reputation ranking, and metadata pinning.
4. **Decode `readFeedback`** once the canonical ERC-8004 ABI is available, and
   contribute the five documentation gaps back to Circle.

## Repo layout

```
packages/
  arc-common/           keccak256, ABI codec, rate-limited JSON-RPC client — zero deps
  arc-lint/             rules, engine, CLI, SARIF, annotations, action.yml — 33 tests
  hardhat-arc-lint/     Hardhat 3 plugin — 13 tests
  arc-index/            core dedup rule + RPC scanner + reconciler — 10 tests
  arc-index-ponder/     Ponder adapter + example project — 9 tests
  arc-index-subsquid/   Subsquid adapter + example project — 10 tests
  arc-agents/           ERC-8004 identity + reputation reader — 17 tests
  arc-server/           dev console + JSON API + doc search — 14 tests
site/                   the public site: landing plus a page per tool
tools/
  mirror-docs.ts        Mintlify site mirror (Arc and Circle)
  deploy.sh             push to vm-webserver and publish site/
.github/workflows/      arc-lint (annotate + code scanning), test (Node 22 & 24)
docs/                   108 mirrored Arc pages          (generated, not committed)
docs-circle/            528 mirrored Circle pages         (generated, not committed)
ARC-NOTES.md            research trail: verified chain facts, hazards, doc gaps
```

`arc-common` deliberately has no dependencies — not even for keccak256, which
Node's `crypto` cannot provide (it ships FIPS SHA3, a different padding). Every
class declares its fields explicitly, because Node's strip-only TypeScript mode
rejects parameter properties and enums. That constraint is what keeps
`node file.ts` working with no install step.

## Documentation mirrors are generated, not vendored

`docs/` and `docs-circle/` are Circle's documentation, mirrored locally so the
dev console can search it offline. They are deliberately kept out of version
control — redistributing someone else's docs is not this repo's business. Run
`npm run mirror-docs` (and `-- --site circle`) to build them.

## Status

Everything here runs against Arc Testnet (chain `5042002`) and was verified on
2026-08-24. Mainnet is announced for 16 September 2026; the addresses in
`arc-common/rpc.ts` are testnet-only and will need a mainnet set.

`arc-lint` runs fully offline, and every test in the repo does too — there is
nothing to install to run `npm test`. `arc-index` and `arc-agents` need RPC
access; both respect `ARC_RPC_RPS` (default 12) because Arc's public RPC sits
behind Cloudflare and answers bursts with 429.

The one dependency anywhere is `hardhat` itself, a dev dependency of the Hardhat
plugin so its peer dependency can be exercised. The plugin was verified against a
real Hardhat 3.14 project, not just unit-tested.
