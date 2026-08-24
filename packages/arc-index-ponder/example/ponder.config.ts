import { createConfig } from "ponder";
import { arcTestnetChain, arcUsdcContracts } from "arc-index-ponder";

export default createConfig({
  chains: {
    arcTestnet: arcTestnetChain({
      // Point at a dedicated endpoint for real workloads; the public RPC is
      // rate-limited and a backfill will hit 429.
      rpc: process.env.PONDER_RPC_URL_ARC ?? undefined,
    }),
  },
  contracts: arcUsdcContracts({
    chain: "arcTestnet",
    startBlock: Number(process.env.START_BLOCK ?? 58_500_000),
    // The ERC-20 stream only labels movements. Turn it off and you still get
    // every movement exactly once, just without the `via` distinction.
    includeErc20Markers: true,
  }),
});
