# Arc research notes

Everything here was read from Arc's own docs and then checked against
`https://rpc.testnet.arc.io` on 2026-08-24. Where the docs and the chain
disagreed, the chain wins and the note says so.

## What Arc is

Circle's open Layer-1 for programmable money. **USDC is the native gas token.**
Sub-second deterministic finality, EVM-compatible (Osaka baseline), opt-in
privacy, and direct integration with Circle's platform (CCTP, Gateway, Wallets).

`arc.io` and `docs.arc.network` both redirect to the `docs.arc.io` docs.
Mainnet is announced for **16 September 2026**; today only testnet exists.

## Network facts (verified live)

| | |
|---|---|
| Chain ID | `5042002` (`eth_chainId` → `0x4cef52`) |
| RPC | `https://rpc.testnet.arc.io` (also blockdaemon / drpc / quicknode subdomains) |
| WebSocket | `wss://rpc.testnet.arc.io` |
| Explorer | https://testnet.arcscan.app |
| Faucet | https://faucet.circle.com |
| Gas price observed | 21 Gwei (protocol floor 20, ceiling 20 000) |
| Base fee target | ~$0.01 per transaction, EIP-1559 + EWMA smoothing |
| Throughput | 30M gas/block, ~0.5 s blocks |
| `eth_getLogs` range cap | **Differs per endpoint and none are documented.** `rpc.testnet.arc.io` enforces **30 000** (`-32012`), the dRPC mirror **10 000** (`-35`), Blockdaemon 50 000+. The default endpoint's other validator reports `query exceeds max block range 100000` — a limit it does not enforce. |
| Rate limiting | Cloudflare fronts the RPC and returns **429 on bursts**, even at concurrency 4 |

## The decimal trap

This is the single most dangerous thing about building on Arc.

Native USDC and the ERC-20 USDC interface are **one balance with two views**:

| Interface | Address | Decimals | Used for |
|---|---|---|---|
| Native | — | **18** | gas accounting, native sends, `msg.value`, `address.balance` |
| ERC-20 | `0x3600000000000000000000000000000000000000` | **6** | `transfer`, `approve`, `allowance`, `balanceOf` |

Verified: `decimals()` → `6`, `symbol()` → `USDC`, code size 1798 B.

Consequences:

- `USDC.balanceOf(a)` and `a.balance` describe the same money at different scales.
  Mixing them raw is a 10¹² error.
- The 6-decimal view **truncates**. A native balance of `0.0000001` USDC reads as
  `0`, so `balanceOf(x) == 0` does not mean the account is empty.
- No WETH-style wrapper is needed: native USDC already satisfies `IERC20`.
- Solidity's `ether` unit is just `1e18`, which on Arc means **1 USDC**.

## Protocol divergences from Ethereum (Osaka)

| Behaviour | Ethereum | Arc |
|---|---|---|
| `PREVRANDAO` / `block.difficulty` | RANDAO mix | always `0` — no onchain randomness |
| `SELFDESTRUCT` | EIP-6780 | EIP-6780 + native value rules; emits a `Transfer` log |
| Value `CALL` to a destructed account | succeeds | **reverts** (forbidden burn) |
| Native transfer to `address(0)` | succeeds | **reverts** — USDC cannot be burned this way |
| EIP-4788 beacon roots | functional | contract omitted; reads return `0x` |
| Blob txs (EIP-4844) | supported | rejected; `BLOBHASH`→0, `BLOBBASEFEE`→1 |
| EIP-2935 block-hash history | functional | **functional** (unlike 4788) |
| EIP-7708 native `Transfer` logs | not yet | **shipped ahead of upstream** |

`anvil` and `hardhat node` run a stock EVM, so none of the Arc-specific
behaviour above reproduces locally. Those paths need a real Arc RPC.

## Two event streams for one movement

| Source | Emitter | Decimals | Covers |
|---|---|---|---|
| Native system (EIP-7708) | `0xfffffffffffffffffffffffffffffffffffffffe` | 18 | every real movement |
| ERC-20 `NativeFiatToken` | `0x3600000000000000000000000000000000000000` | 6 | ERC-20 calls only |

Both use the standard topic0
`0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`, so
filtering by topic alone picks up both.

One `transfer()` emits **two** logs. Measured over 150 recent blocks:

```
native emitter   1589 logs
ERC-20 emitter   1073 logs
real movements   1589   (1066 via ERC-20, 523 plain native sends)
```

A topic-only indexer creates 2662 rows for 1589 movements (**+67.5% phantom
rows**) and, if it normalises decimals correctly but never deduplicates,
overstates volume by **+83.1%**.

Rules the native emitter follows, all confirmed on chain:

- The native log is emitted **first**, before other logs in the transaction.
- **Zero-value transfers emit no log.**
- **Self-transfers (`from == to`) emit no log** — but the ERC-20 contract still
  emits one, per the token standard. 7 of these appeared in a 150-block window.
  An indexer trusting the ERC-20 stream alone invents balance changes for them.
- Mint is `Transfer(0x0, to, v)`; burn is `Transfer(from, 0x0, v)`.
- Gas fees are **not** logged, so replaying logs under-counts a fee payer's
  outflow. That residual is the expected signature of a correct index.

Before the Zero5 hard fork, testnet emitted `NativeCoin*` events from
`0x1800000000000000000000000000000000000000` instead. Backfills crossing that
boundary need both shapes.

## Contract addresses (Arc Testnet, all verified deployed)

| Contract | Address | Code |
|---|---|---|
| USDC (ERC-20 view) | `0x3600000000000000000000000000000000000000` | 1798 B |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` | |
| USYC | `0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C` | |
| CCTP TokenMessengerV2 (domain 26) | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` | |
| Gateway Wallet | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` | |
| StableFX FxEscrow | `0xd68256f4D69C6BbEcB873D8588AE0Dc6B8E22E10` | proxy |
| Memo | `0x5294E9927c3306DcBaDb03fe70b92e01cCede505` | 1228 B |
| Multicall3From | `0x522fAf9A91c41c443c66765030741e4AaCe147D0` | 3180 B |
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | proxy |
| ERC-8004 ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | proxy |
| ERC-8004 ValidationRegistry | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | proxy |
| ERC-8183 AgenticCommerce | `0x0747EEf0706327138c69792bF28Cd525089e4583` | proxy |

`Multicall3From` is Arc-specific: it batches like Multicall3 but **preserves the
original `msg.sender`** in each subcall. Memo and Multicall3From must be in the
call path for Circle's compliance screening to see the memo.

## The agent registries

`AgentIdentity` (`AGENT`) is a plain ERC-721 — `supportsInterface(0x80ac58cd)`
is true, but there is **no `totalSupply()`**, so it is not enumerable.

Token ids are sequential from **0**. Exponential probe + binary search over
`ownerOf` found the boundary in **41 `eth_call`s**:

```
registered agents  885 423
highest token id   885 422
```

The registries are active — ~268 000 logs across the last 1.17M blocks, mostly
reputation attestations — but the 885k agents accumulated over the chain's whole
~58M-block history, so counting by log replay means backfilling all of it: roughly
2 000–5 900 `eth_getLogs` calls depending on which cap the endpoint applies.

ReputationRegistry read surface, discovered by probing (not documented):

- `getClients(uint256) → address[]` — who attested
- `getLastIndex(uint256, address) → uint64` — attestation count from that client
- `readFeedback(uint256, address, uint64)` — returns a tuple whose layout is not
  published; **not decoded here rather than guessed**
- `getSummary(uint256, address[], string, string)` — aggregate

Write side, from the docs:
`giveFeedback(uint256, int128, uint8, string, string, string, string, bytes32)`.

Live sample: agent #1 has **1315 distinct attesters**; the first 100 account for
79 617 attestations. Agent metadata is an application-defined JSON document at
an IPFS URI.

## Doc gaps found

1. The `eth_getLogs` range caps are undocumented, differ across the four endpoints
   the docs present as interchangeable, and the default endpoint's error message
   quotes a limit (100 000) that is more than 3x what it actually enforces (30 000).
2. Cloudflare rate limiting on the public RPC is not mentioned.
3. The ERC-8004 registry **read** ABI is absent — the tutorials only cover writes.
4. `readFeedback`'s return tuple has no published layout.
5. `AgentIdentity` has no `totalSupply()`, and nothing documents how to enumerate.

## Developer incentives

The **Circle Developer Grants Program** relaunched in May 2026. Applications at
`circle.com/grant`; milestone-based USDC payments (reported $5k–$100k), plus
technical guidance, co-marketing, and ecosystem introductions. Per the ARC
whitepaper (May 2026), 60% of ARC supply is earmarked for developers, active
participants, and ecosystem grants.

Stated priority areas:

- Agentic economic activity
- Stablecoin FX
- Peer-to-peer payments
- Treasury management
- Prediction markets
- Lending and borrowing

What Circle says it screens for: platform alignment, proven shipping ability,
clear technical ownership, and traction or a credible path to it — with
meaningful integration of Arc and Circle products.

## Sources

- https://docs.arc.io/llms.txt — full doc index
- https://docs.arc.io/arc/references/evm-differences
- https://docs.arc.io/arc/references/usdc-system-events
- https://docs.arc.io/arc/references/gas-and-fees
- https://docs.arc.io/arc/references/contract-addresses
- https://docs.arc.io/build/agentic-economy
- https://docs.arc.io/arc/references/sample-applications
- https://community.arc.io/public/blogs/circle-developer-grants-program-relaunches-2026-05-14
