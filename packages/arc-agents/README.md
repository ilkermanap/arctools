# arc-agents

Read the ERC-8004 agent identity and reputation registries on Arc.

Agent identity and job settlement are the substrate for Arc's agentic economy —
Circle's stated top grant priority — and every application in that space has to
read these registries.

## Usage

```bash
node src/cli.ts count
node src/cli.ts list --from 0 --limit 20 --resolve
node src/cli.ts show 1 --resolve
node src/cli.ts reputation 4 --max-clients 500
```

## Why enumeration, not logs

`AgentIdentity` (`AGENT`) is a plain ERC-721: `supportsInterface(0x80ac58cd)` is
true, but it does **not** implement ERC721Enumerable, so there is no
`totalSupply()` to ask.

The log route is worse. Arc's RPC caps `eth_getLogs` at 100 000 blocks, so
covering ~58M blocks costs ~590 requests — and a 6M-block sweep (~35 days) finds
**zero** registry logs, because registration all predates any cheap window.

Token ids are minted sequentially from 0, so an exponential probe plus a binary
search over `ownerOf` finds the boundary in ~41 `eth_call`s:

```
registered agents  885 423
highest token id   885 422
cost               41 eth_calls
```

## Reputation

The ReputationRegistry read surface is not in Arc's docs; these were found by
probing:

- `getClients(uint256) → address[]` — who attested about an agent
- `getLastIndex(uint256, address) → uint64` — attestation count from one client
- `readFeedback(uint256, address, uint64)` — returns a tuple with no published
  layout. **Not decoded here**, because guessing a score's position is worse than
  admitting the gap.
- `getSummary(uint256, address[], string, string)` — aggregate

So `reputation` reports attestation volume and the most active attesters, not
scores. Popular agents have thousands of attesters — agent #1 has 1315 — and one
`eth_call` each trips the rate limit, so the fan-out is capped at 100 clients by
default. A partial result is marked with `+` and says how to widen it.

## Metadata

`tokenURI` points at an application-defined JSON document, usually on IPFS. The
example shape from Arc's docs:

```json
{
  "name": "DeFi Arbitrage Agent v1.0",
  "description": "Autonomous trading agent for cross-DEX arbitrage on Arc",
  "agent_type": "trading",
  "capabilities": ["arbitrage_detection", "liquidity_monitoring"],
  "version": "1.0.0"
}
```

`--resolve` fetches it. Resolution failure never fails a listing — one
unreachable gateway must not take down twenty rows. Many public gateways redirect
to a per-CID subdomain, which sandboxed and corporate networks refuse, so set
`ARC_IPFS_GATEWAY` or pass `--gateway` when the defaults are blocked.

## Note

`getClients` returning an empty array means no attestations, not an error. A
`show` on an unregistered id exits 1.
