# Five gaps in the Arc documentation, with reproduction

Found while building [arctools](https://github.com/ilkermanap/arctools), a set of
developer tools for Arc (linter, USDC indexer, ERC-8004 registry reader). Every
claim below was checked against `https://rpc.testnet.arc.io` on 2026-08-24, and
absence from the docs was checked against a full mirror of `docs.arc.io`
(108 pages, crawled from `llms.txt`).

Each item is a small, concrete addition — nothing here is a bug report about the
chain itself.

---

## 1. `eth_getLogs` range caps are undocumented, differ per endpoint, and one endpoint reports a limit it does not enforce

[Connect to Arc](https://docs.arc.io/arc/references/connect-to-arc) lists four
RPC endpoints without distinguishing them. They enforce three different
`eth_getLogs` range limits, none documented:

| Endpoint | Largest accepted range | Error beyond it |
| :-- | --: | :-- |
| `rpc.testnet.arc.io` | **30 000** | `-32012 requested range too large` |
| `rpc.blockdaemon.testnet.arc.io` | 50 000+ | — |
| `rpc.drpc.testnet.arc.io` | **10 000** | `-35 ranges over 10000 blocks are not supported` |

The default endpoint is not even internally consistent: queries reaching further
back return a *third* message with a *third* number —

```
-32614  eth_getLogs is limited to a 10,000 range
```

— so the same endpoint enforces 30 000 near the head and 10 000 for deeper
ranges, with no way to know which applies before trying.

Separately, it has a validator that reports a limit it never applies. A
genesis-to-latest query returns:

```
-32602  request exceeded max allowed range: query exceeds max block range 100000
```

while a 30 001-block query already fails. An integrator who reads that message
and configures 100 000-block pages — which is exactly what indexing frameworks
ask you to declare — has every request fail.

**Reproduce** (30 000 succeeds, 30 001 does not):

```bash
RPC=https://rpc.testnet.arc.io
HEAD=$(curl -s -X POST $RPC -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
  | python3 -c 'import sys,json;print(int(json.load(sys.stdin)["result"],16))')

for span in 30000 30001; do
  from=$((HEAD - span + 1))
  printf "%6s: " "$span"
  curl -s -X POST $RPC -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getLogs\",\"params\":[{
        \"fromBlock\":\"0x$(printf %x $from)\",\"toBlock\":\"0x$(printf %x $HEAD)\",
        \"address\":\"0x8004A818BFB912233c491871b3d84c89A494BD9e\"}]}"
  echo
done
```

**Suggested fix:** state the per-endpoint cap in *Connect to Arc*, and align the
`-32602` message with the enforced value.

---

## 2. Public RPC rate limiting is not described

`rpc.testnet.arc.io` sits behind Cloudflare and answers bursts with HTTP 429 at
modest concurrency — four parallel `eth_call`s was enough to trip it while
reading agent reputation. Individual requests succeed immediately afterwards, so
it reads as a burst limit rather than a quota.

The docs come close but never say it. [Running a
node](https://docs.arc.io/arc/concepts/running-a-node) lists "**No rate limits.**
You control your own RPC endpoint" as a benefit, which implies the public
endpoint has them, and [App Kit adapter
setups](https://docs.arc.io/app-kit/tutorials/adapter-setups) warns that default
RPC URLs "may be rate-limited". Neither states the behaviour for the Arc RPC, a
safe request rate, or whether `Retry-After` is sent.

**Suggested fix:** one line in *Connect to Arc* — that the public endpoint is
rate-limited, roughly at what rate, and that production integrations should use a
dedicated provider.

---

## 3. The ERC-8004 registry read ABI is missing

[Register your first AI
agent](https://docs.arc.io/arc/tutorials/register-your-first-ai-agent) documents
the write path thoroughly — `register`, `giveFeedback`, `validationRequest`,
`validationResponse`, plus `ownerOf`, `tokenURI`, and `getValidationStatus`.

The `ReputationRegistry` read functions appear nowhere. Grepping the full doc
mirror:

| Symbol | Pages mentioning it |
| :-- | --: |
| `register` | 24 |
| `giveFeedback` | 1 |
| `validationRequest` | 1 |
| `getClients` | **0** |
| `getLastIndex` | **0** |
| `readFeedback` | **0** |
| `getSummary` | **0** |

These exist and work — found by probing the deployed contract at
`0x8004B663056A597Dffe9eCcC1965A193B7388713`:

```bash
# getClients(uint256) -> address[] : who has attested about agent 4
curl -s -X POST https://rpc.testnet.arc.io -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{
      "to":"0x8004B663056A597Dffe9eCcC1965A193B7388713",
      "data":"0x42dd519c0000000000000000000000000000000000000000000000000000000000000004"},"latest"]}'
```

Any application that reads reputation — which is the point of the registry —
has to reverse-engineer this today.

**Suggested fix:** document the read side alongside the write side, or link the
canonical ERC-8004 ABI.

---

## 4. `readFeedback`'s return tuple has no published layout

Following from #3: `readFeedback(uint256,address,uint64)` returns data whose
shape can be observed but not confirmed. For agent 0 it returns eight words
including an empty string and the tag `"marketplace"`, but which word holds the
score, and whether it is the `int128` from `giveFeedback`, is not stated
anywhere.

We chose **not** to decode it rather than guess, because a wrong guess produces
plausible, silently incorrect scores. That leaves reputation *volume* readable
but reputation *values* unreadable.

**Suggested fix:** publish the tuple layout, or the registry ABI JSON.

---

## 5. `AgentIdentity` is not enumerable, and nothing documents how to list agents

`AgentIdentity` (`0x8004A818BFB912233c491871b3d84c89A494BD9e`) reports
`supportsInterface(0x80ac58cd)` = true (ERC-721) but
`supportsInterface(0x780e9d63)` = false (ERC721Enumerable), and `totalSupply()`
reverts. `totalSupply`, `ERC721Enumerable`, and "enumerate" appear on zero pages
of the docs.

So there is no documented way to answer "which agents exist?" — and the log route
is expensive. The registries are active (~268 000 logs across the last 1.17M
blocks, mostly reputation attestations), but the agents accumulated over the
chain's entire ~58M-block history, so a complete count means backfilling all of
it: roughly 2 000–5 900 requests depending on which cap the endpoint applies.

What does work, and is worth documenting: ids are minted sequentially from 0 and
`ownerOf` reverts past the end, so an exponential probe plus binary search finds
the registry size in ~41 `eth_call`s — O(log n) in the number of agents rather
than O(n) in blocks. As of 2026-08-24 that gives **885 424 registered agents**.

```bash
# ownerOf reverts past the highest minted id
curl -s -X POST https://rpc.testnet.arc.io -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{
      "to":"0x8004A818BFB912233c491871b3d84c89A494BD9e",
      "data":"0x6352211e00000000000000000000000000000000000000000000000000000000000f0000"},"latest"]}'
```

**Suggested fix:** a short "listing registered agents" section, and a note that
the registry is not ERC721Enumerable.

---

## Context

These came out of building three tools against Arc:
[`arc-lint`](https://arctools.mynodes.xyz/arc-lint.html) (compatibility rules for
the EVM divergences), [`arc-index`](https://arctools.mynodes.xyz/arc-index.html)
(dual-emitter-safe USDC indexing), and
[`arc-agents`](https://arctools.mynodes.xyz/arc-agents.html) (the registry reader
that surfaced #3–#5). Source: <https://github.com/ilkermanap/arctools>

Happy to open individual issues, or PRs against the docs if they are open to
contribution.
