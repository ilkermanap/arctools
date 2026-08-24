# arc-server

Local dev console for Arc: the mirrored documentation plus live chain data, in
one dependency-free HTTP server.

```bash
npm run serve                  # http://127.0.0.1:8787
npm run serve -- --port 9000 --rpc https://rpc.testnet.arc.io
```

Five tabs, all reading the same packages the CLIs use:

| Tab | What it shows |
|---|---|
| **Chain** | chain id, head block, gas price against the 20 Gwei floor |
| **USDC index** | dual-emitter scan with the phantom-row and volume-inflation numbers, plus per-address reconciliation |
| **Agents** | registry size, agent listing, owner and attestation detail |
| **Lint** | paste Solidity or a deploy script, get findings with doc links |
| **Docs** | full-text search across all 636 mirrored pages, with the page body inline |

## API

Every tab is a thin client over these routes. They are just as usable from
`curl`, an editor extension, or CI.

| Route | |
|---|---|
| `GET /api/health` | page count, cache size |
| `GET /api/chain` | chain id, head, gas price (cached 4 s) |
| `GET /api/index/scan?blocks=N` | canonical movements + dedup stats (cached 12 s) |
| `GET /api/index/reconcile?address=&blocks=` | indexed delta vs `eth_getBalance` |
| `GET /api/agents/count` | registry size via binary search (cached 5 min) |
| `GET /api/agents/list?from=&limit=` | owner and metadata URI per token id |
| `GET /api/agents/show?id=` | one agent with its attestation summary |
| `GET /api/lint/rules` | all 14 rules with severities and doc links |
| `POST /api/lint` | `{source, lang, filename}` → findings |
| `GET /api/docs/sites` | mirrored sites with page counts |
| `GET /api/docs/list?site=` | page listing without bodies |
| `GET /api/docs/search?q=&limit=` | ranked hits with marked excerpts |
| `GET /api/docs/page?site=&path=` | one page, full markdown |

```bash
curl -s localhost:8787/api/docs/search?q=usdc+decimals | jq '.hits[0]'
curl -s -X POST localhost:8787/api/lint \
  -H 'content-type: application/json' \
  -d '{"lang":"solidity","source":"contract C { function f() external view returns (uint256) { return block.prevrandao; } }"}'
```

## Docs mirror

The Docs tab reads whatever `tools/mirror-docs.ts` has written. Nothing is
fetched at request time, so search works offline.

```bash
npm run mirror-docs                        # Arc docs      -> ./docs
npm run mirror-docs -- --site circle       # Circle platform -> ./docs-circle
```

The crawler starts from each site's `llms.txt` and follows internal links
breadth-first. Mintlify serves markdown source at `<path>.md`, so the mirror is
real prose rather than scraped HTML — which is also why pages absent from
`llms.txt` still land.

Search ranks title matches above summary matches above body frequency, and
requires every term to appear. The boilerplate "Documentation Index" banner
Mintlify prepends to every page is stripped, or it would match everything.

## Caching

Arc's public RPC sits behind Cloudflare and answers bursts with 429. Every RPC-backed
route goes through a TTL cache that also collapses concurrent misses, so a page
load with four widgets makes one RPC pass rather than four.

## Notes

- Binds to `127.0.0.1` by default. There is no auth, so do not expose it.
- The scan route caps what crosses the wire at the 50 most recent movements; the
  full count is in `movementsTotal`. Use the CLI's `--json` for the whole set.
- Agent token ids start at **0**, and the API takes them as-is.

## Tests

```bash
node --test 'test/*.test.ts'
```

14 tests, no network: the doc loader and ranking, the cache's TTL/coalescing/
failure behaviour, bigint serialisation, and request validation on the routes.
