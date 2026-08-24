/**
 * Arc compatibility rules.
 *
 * Every rule maps to a documented protocol-level divergence between Arc and
 * Ethereum at the Osaka hard fork. Doc references are kept on each rule so a
 * finding can always be traced back to the spec that justifies it.
 *
 * https://docs.arc.io/arc/references/evm-differences
 */

export type Severity = "error" | "warning" | "info";
export type Lang = "solidity" | "script";

export interface Finding {
  rule: string;
  severity: Severity;
  file: string;
  line: number;
  column: number;
  message: string;
  detail: string;
  doc: string;
  snippet: string;
}

export interface RuleContext {
  /** Source with comments AND string literals blanked out. */
  code: string;
  /** Source with only comments blanked out; string contents are intact. */
  text: string;
  /** Original source, for snippets. */
  raw: string;
  file: string;
  lang: Lang;
}

export interface Match {
  offset: number;
  /** Overrides the rule's default message when a rule wants to be specific. */
  message?: string;
}

export interface Rule {
  id: string;
  severity: Severity;
  langs: Lang[];
  title: string;
  detail: string;
  doc: string;
  find(ctx: RuleContext): Match[];
}

const DOCS = {
  evm: "https://docs.arc.io/arc/references/evm-differences",
  gas: "https://docs.arc.io/arc/references/gas-and-fees",
  addresses: "https://docs.arc.io/arc/references/contract-addresses",
  native: "https://docs.arc.io/arc/concepts/stablecoin-native-model",
  porting: "https://docs.arc.io/arc/tutorials/porting-contracts-to-arc",
};

/** Collect every match of a global regex as offsets. */
function scan(code: string, re: RegExp, message?: (m: RegExpExecArray) => string): Match[] {
  const out: Match[] = [];
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = rx.exec(code)) !== null) {
    out.push({ offset: m.index, message: message?.(m) });
    if (m[0].length === 0) rx.lastIndex++;
  }
  return out;
}

export const RULES: Rule[] = [
  {
    id: "arc/no-prevrandao",
    severity: "error",
    langs: ["solidity"],
    title: "PREVRANDAO always returns 0 on Arc",
    detail:
      "Arc has no beacon-chain RANDAO mix, so block.prevrandao (and the legacy " +
      "block.difficulty alias) is hardcoded to 0. Any contract deriving randomness " +
      "from it is fully predictable. Use an oracle or VRF instead.",
    doc: DOCS.evm,
    find: (ctx) =>
      scan(ctx.code, /\bblock\s*\.\s*(prevrandao|difficulty)\b/g, (m) =>
        `block.${m[1]} is always 0 on Arc`),
  },
  {
    id: "arc/no-assembly-prevrandao",
    severity: "error",
    langs: ["solidity"],
    title: "PREVRANDAO/DIFFICULTY opcode in assembly always returns 0",
    detail:
      "Inline assembly reads of prevrandao() or difficulty() return 0 on Arc for the " +
      "same reason as block.prevrandao. Randomness must come from offchain.",
    doc: DOCS.evm,
    find: (ctx) => scan(ctx.code, /\b(prevrandao|difficulty)\s*\(\s*\)/g),
  },
  {
    id: "arc/no-blob-opcodes",
    severity: "error",
    langs: ["solidity"],
    title: "Blob transactions are not supported on Arc",
    detail:
      "Arc's mempool rejects EIP-4844 type-3 transactions. BLOBHASH returns 0 and " +
      "BLOBBASEFEE returns 1, so blob-dependent logic silently misbehaves rather " +
      "than reverting.",
    doc: DOCS.evm,
    find: (ctx) =>
      scan(ctx.code, /\b(blobhash\s*\(|block\s*\.\s*blobbasefee|blobbasefee\s*\(\s*\))/gi),
  },
  {
    id: "arc/no-beacon-roots",
    severity: "error",
    langs: ["solidity", "script"],
    title: "EIP-4788 beacon-roots contract is not deployed on Arc",
    detail:
      "Arc omits the beacon-roots contract, so reads return empty (0x), and " +
      "parentBeaconBlockRoot is set to the parent execution block hash instead of a " +
      "beacon root. Do not treat it as an oracle or randomness source. Note that " +
      "the EIP-2935 historical block-hash contract IS deployed and does work.",
    doc: DOCS.evm,
    find: (ctx) =>
      scan(ctx.text, /0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02/gi).concat(
        scan(ctx.text, /\bparentBeaconBlockRoot\b/g),
      ),
  },
  {
    id: "arc/selfdestruct-value-rules",
    severity: "warning",
    langs: ["solidity"],
    title: "SELFDESTRUCT carries extra native-value rules on Arc",
    detail:
      "Arc applies EIP-6780 plus its own native-value rules: the beneficiary transfer " +
      "can revert (zero address, blocklisted address, or any transfer that would burn " +
      "value), and a successful destruct emits a Transfer log. Patterns that succeed " +
      "on mainnet can revert here.",
    doc: DOCS.evm,
    find: (ctx) => scan(ctx.code, /\bselfdestruct\s*\(/g),
  },
  {
    id: "arc/burn-to-zero-address",
    severity: "error",
    langs: ["solidity"],
    title: "Native value transfer to the zero address reverts on Arc",
    detail:
      "USDC is the native asset, and Arc forbids burning it. Sending native value to " +
      "address(0) reverts at runtime even when the balance is sufficient, so " +
      "burn-by-sending patterns must be replaced with an explicit sink address.",
    doc: DOCS.evm,
    find: (ctx) =>
      scan(
        ctx.code,
        /\b(?:payable\s*\(\s*)?address\s*\(\s*0(?:x0+)?\s*\)\s*\)?\s*\.\s*(transfer|send|call)\b/g,
      ).concat(scan(ctx.code, /\bselfdestruct\s*\(\s*payable\s*\(\s*address\s*\(\s*0/g)),
  },
  {
    id: "arc/decimals-mix",
    severity: "error",
    langs: ["solidity"],
    title: "18-decimal literal in a file that also uses the 6-decimal USDC interface",
    detail:
      "On Arc the native USDC balance uses 18 decimals (msg.value, address.balance, " +
      ".transfer) while the ERC-20 interface at 0x3600...0000 uses 6. They are two " +
      "views of ONE balance, so a raw 1e18 amount passed to an ERC-20 call is 1e12x " +
      "too large. Convert explicitly at every boundary.",
    doc: DOCS.native,
    find: (ctx) => {
      const usesErc20 =
        /\b(IERC20|SafeERC20|transferFrom\s*\(|allowance\s*\(|safeTransfer)/.test(ctx.code) ||
        /0x3600000000000000000000000000000000000000/i.test(ctx.text);
      if (!usesErc20) return [];
      return scan(ctx.code, /\b(1e18|10\s*\*\*\s*18|1_000_000_000_000_000_000)\b/g);
    },
  },
  {
    id: "arc/ether-unit-is-usdc",
    severity: "warning",
    langs: ["solidity"],
    title: "The `ether` unit denominates USDC on Arc",
    detail:
      "Solidity's `ether` unit is just 1e18. Because Arc's native asset is USDC with " +
      "18-decimal native accounting, `1 ether` means 1 USDC -- not one ETH and not " +
      "1e18 USDC. Prefer a named constant such as `uint256 constant ONE_USDC = 1e18` " +
      "so reviewers are not misled.",
    doc: DOCS.native,
    find: (ctx) => scan(ctx.code, /\b\d[\d_.]*\s+(ether|finney|szabo)\b/g),
  },
  {
    id: "arc/balanceof-zero-is-not-empty",
    severity: "warning",
    langs: ["solidity"],
    title: "balanceOf() == 0 does not mean the account is empty",
    detail:
      "The 6-decimal ERC-20 view truncates: a native balance of 0.0000001 USDC reads " +
      "as 0 through balanceOf. Use address.balance (18 decimals) when you need to " +
      "know whether an account truly holds nothing.",
    doc: DOCS.evm,
    find: (ctx) => scan(ctx.code, /balanceOf\s*\([^;{}]*\)\s*(==|!=|<=)\s*0\b/g),
  },
  {
    id: "arc/unnecessary-weth-wrapper",
    severity: "info",
    langs: ["solidity"],
    title: "No WETH-style wrapper is needed on Arc",
    detail:
      "Native USDC already satisfies IERC20 at 0x3600...0000, so the usual " +
      "wrap/unwrap layer is dead weight. Point the pool or router at the native " +
      "ERC-20 interface instead of deploying a wrapper.",
    doc: DOCS.addresses,
    find: (ctx) => scan(ctx.code, /\b(IWETH9?|WETH9?|WrappedNative|wrapped(?:Native|Token))\b/g),
  },
  {
    id: "arc/prefer-multicall3from",
    severity: "info",
    langs: ["solidity", "script"],
    title: "Multicall3 loses msg.sender; Arc ships Multicall3From",
    detail:
      "Arc predeploys Multicall3From at 0x522fAf9A91c41c443c66765030741e4AaCe147D0, " +
      "which batches calls while preserving the original msg.sender in each subcall. " +
      "Plain Multicall3 (0xcA11bde0...) still works for read aggregation.",
    doc: DOCS.addresses,
    find: (ctx) => scan(ctx.code, /0xcA11bde05977b3631167028862bE2a173976CA11/gi),
  },
  {
    id: "arc/gas-fee-floor",
    severity: "error",
    langs: ["script"],
    title: "maxFeePerGas below Arc's 20 Gwei base-fee floor",
    detail:
      "Arc enforces a 20 Gwei minimum base fee on testnet. Transactions below it may " +
      "stay pending indefinitely or fail with `transaction underpriced`.",
    doc: DOCS.gas,
    find: (ctx) => {
      const out: Match[] = [];
      // parseUnits("N", "gwei") / parseGwei("N") assigned to a fee field
      const re =
        /\b(maxFeePerGas|gasPrice)\b\s*[:=]\s*[^,;\n]*?(?:parseUnits\s*\(\s*["'](\d+(?:\.\d+)?)["']\s*,\s*["']?(?:9|gwei)["']?\s*\)|parseGwei\s*\(\s*["']?(\d+(?:\.\d+)?)["']?\s*\))/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(ctx.text)) !== null) {
        const gwei = Number(m[2] ?? m[3]);
        if (Number.isFinite(gwei) && gwei < 20) {
          out.push({ offset: m.index, message: `${m[1]} is ${gwei} Gwei, below the 20 Gwei floor` });
        }
      }
      return out;
    },
  },
  {
    id: "arc/hardcoded-eth-rpc",
    severity: "warning",
    langs: ["script"],
    title: "Local EVM simulators cannot reproduce Arc semantics",
    detail:
      "anvil, hardhat node, and ganache run a standard EVM. The native-coin " +
      "precompiles, EIP-7708 Transfer events, and USDC blocklist enforcement only " +
      "surface against a real Arc RPC endpoint, so tests that rely on them must run " +
      "against https://rpc.testnet.arc.io.",
    doc: DOCS.evm,
    find: (ctx) => scan(ctx.text, /\b(?:http:\/\/)?(?:127\.0\.0\.1|localhost):8545\b/g),
  },
  {
    id: "arc/wrong-usdc-decimals",
    severity: "error",
    langs: ["script"],
    title: "USDC amount encoded with 18 decimals for an ERC-20 call",
    detail:
      "The ERC-20 interface on Arc uses 6 decimals. parseEther / parseUnits(x, 18) " +
      "produces a native-precision amount; passing it to transfer/approve inflates " +
      "the value by 1e12.",
    doc: DOCS.native,
    find: (ctx) =>
      scan(
        ctx.text,
        /\b(?:transfer|approve|transferFrom|allowance)\b[^;\n]*\b(parseEther\s*\(|parseUnits\s*\([^,]+,\s*18\s*\))/g,
      ),
  },
];

export function rulesFor(lang: Lang): Rule[] {
  return RULES.filter((r) => r.langs.includes(lang));
}
