/** The dashboard, served as one self-contained page. No build step, no CDN. */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arc dev console</title>
<style>
:root{
  --bg:#fbfbfd; --panel:#fff; --line:#e3e5ea; --ink:#14161a; --dim:#63676f;
  --accent:#2f6fd0; --err:#c0392b; --warn:#b26a00; --info:#2f6fd0; --ok:#1a7f4b;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0e1116; --panel:#161a21; --line:#262b34; --ink:#e6e8ec; --dim:#9aa0aa;
  --accent:#6ea8fe; --err:#ff7b72; --warn:#e3b341; --info:#6ea8fe; --ok:#56d364;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;
  align-items:baseline;gap:14px;flex-wrap:wrap;background:var(--panel)}
h1{font-size:16px;margin:0;font-weight:650;letter-spacing:-.01em}
.sub{color:var(--dim);font-size:12.5px}
.chain{margin-left:auto;font-family:var(--mono);font-size:12px;color:var(--dim)}
nav{display:flex;gap:2px;padding:0 14px;border-bottom:1px solid var(--line);
  background:var(--panel);overflow-x:auto}
nav button{background:none;border:0;border-bottom:2px solid transparent;
  padding:11px 14px;color:var(--dim);cursor:pointer;font-size:13.5px;white-space:nowrap}
nav button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--accent);font-weight:600}
main{padding:22px;max-width:1120px;margin:0 auto}
section{display:none} section.on{display:block}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:16px}
input,select,textarea{background:var(--panel);border:1px solid var(--line);
  color:var(--ink);border-radius:7px;padding:8px 11px;font-size:13.5px;font-family:inherit}
textarea{width:100%;min-height:230px;font-family:var(--mono);font-size:12.5px;line-height:1.5}
button.go{background:var(--accent);color:#fff;border:0;border-radius:7px;
  padding:8px 15px;cursor:pointer;font-size:13.5px;font-weight:550}
button.go:disabled{opacity:.5;cursor:default}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(185px,1fr));gap:12px;margin-bottom:18px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card .k{color:var(--dim);font-size:11.5px;text-transform:uppercase;letter-spacing:.05em}
.card .v{font-size:21px;font-weight:600;margin-top:5px;font-variant-numeric:tabular-nums;
  word-break:break-all;line-height:1.2}
.card .n{color:var(--dim);font-size:12px;margin-top:3px}
table{width:100%;border-collapse:collapse;font-size:13px;background:var(--panel);
  border:1px solid var(--line);border-radius:10px;overflow:hidden}
th{text-align:left;color:var(--dim);font-weight:550;font-size:11.5px;text-transform:uppercase;
  letter-spacing:.04em;padding:9px 12px;border-bottom:1px solid var(--line)}
td{padding:8px 12px;border-bottom:1px solid var(--line);font-family:var(--mono);font-size:12px}
tr:last-child td{border-bottom:0}
.wrap{overflow-x:auto;margin-bottom:16px}
.error{color:var(--err)} .warning{color:var(--warn)} .info{color:var(--info)} .ok{color:var(--ok)}
.pill{display:inline-block;padding:1px 7px;border-radius:11px;font-size:11px;
  border:1px solid currentColor;font-family:var(--mono)}
.hit{background:var(--panel);border:1px solid var(--line);border-radius:10px;
  padding:13px 16px;margin-bottom:9px}
.hit a{color:var(--accent);text-decoration:none;font-weight:600}
.hit .p{color:var(--dim);font-family:var(--mono);font-size:11.5px;margin:3px 0 7px}
.hit .e{font-family:var(--mono);font-size:11.5px;color:var(--dim);
  border-left:2px solid var(--line);padding-left:9px;margin-top:5px;white-space:pre-wrap;word-break:break-word}
mark{background:rgba(110,168,254,.28);color:inherit;border-radius:2px;padding:0 1px}
pre{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;
  overflow:auto;font-family:var(--mono);font-size:12px;max-height:70vh;white-space:pre-wrap;word-break:break-word}
.note{color:var(--dim);font-size:12.5px;margin:10px 0}
.f{background:var(--panel);border:1px solid var(--line);border-left-width:3px;
  border-radius:8px;padding:11px 14px;margin-bottom:8px}
.f.error{border-left-color:var(--err)} .f.warning{border-left-color:var(--warn)}
.f.info{border-left-color:var(--info)}
.f .h{display:flex;gap:9px;align-items:baseline;flex-wrap:wrap}
.f .loc{font-family:var(--mono);font-size:11.5px;color:var(--dim)}
.f .msg{font-weight:550;color:var(--ink)}
.f .rid{font-family:var(--mono);font-size:11px;color:var(--dim)}
.f .d{color:var(--dim);font-size:12.5px;margin-top:5px}
.f .snip{font-family:var(--mono);font-size:11.5px;color:var(--dim);margin-top:5px;
  border-left:2px solid var(--line);padding-left:9px;white-space:pre-wrap}
.spin{color:var(--dim);font-size:13px}
</style>
</head>
<body>
<header>
  <h1>Arc dev console</h1>
  <span class="sub">stablecoin-native L1 &middot; USDC is gas</span>
  <span class="chain" id="chain">connecting&hellip;</span>
</header>
<nav id="tabs"></nav>
<main>
  <section id="s-chain">
    <div class="cards" id="chain-cards"></div>
    <p class="note">Live from the RPC, cached 4 s. Arc enforces a 20 Gwei base-fee floor;
      transactions below it may stay pending indefinitely.</p>
  </section>

  <section id="s-index">
    <div class="row">
      <label class="sub">window</label>
      <select id="ix-blocks">
        <option value="60">60 blocks</option>
        <option value="150" selected>150 blocks</option>
        <option value="400">400 blocks</option>
        <option value="1000">1000 blocks</option>
      </select>
      <button class="go" id="ix-go">Scan</button>
      <span class="spin" id="ix-status"></span>
    </div>
    <div class="cards" id="ix-cards"></div>
    <div id="ix-warn"></div>
    <div class="wrap" id="ix-table"></div>
    <div class="row">
      <input id="rec-addr" placeholder="0x… address to reconcile" size="46">
      <button class="go" id="rec-go">Reconcile</button>
      <span class="spin" id="rec-status"></span>
    </div>
    <div id="rec-out"></div>
  </section>

  <section id="s-agents">
    <div class="cards" id="ag-cards"></div>
    <div class="row">
      <input id="ag-from" type="number" value="0" min="0" size="9">
      <label class="sub">first id</label>
      <input id="ag-limit" type="number" value="20" min="1" max="100" size="6">
      <label class="sub">count</label>
      <button class="go" id="ag-go">List</button>
      <input id="ag-id" type="number" placeholder="agent id" min="0" size="9">
      <button class="go" id="ag-show">Show</button>
      <span class="spin" id="ag-status"></span>
    </div>
    <div class="wrap" id="ag-table"></div>
    <div id="ag-detail"></div>
  </section>

  <section id="s-lint">
    <div class="row">
      <select id="lint-lang">
        <option value="solidity">Solidity</option>
        <option value="script">Script (ts/js)</option>
      </select>
      <button class="go" id="lint-go">Lint</button>
      <button class="go" id="lint-sample" style="background:transparent;color:var(--accent);border:1px solid var(--line)">Load sample</button>
      <span class="spin" id="lint-status"></span>
    </div>
    <textarea id="lint-src" spellcheck="false" placeholder="Paste Solidity or a deploy script…"></textarea>
    <div id="lint-out"></div>
  </section>

  <section id="s-docs">
    <div class="row">
      <input id="dq" placeholder="search 636 mirrored pages…" size="42">
      <select id="dsite"><option value="">all sites</option></select>
      <button class="go" id="dgo">Search</button>
      <span class="spin" id="dstatus"></span>
    </div>
    <div id="dout"></div>
    <pre id="dpage" hidden></pre>
  </section>
</main>
<script>
const TABS = [
  ["chain", "Chain"], ["index", "USDC index"], ["agents", "Agents"],
  ["lint", "Lint"], ["docs", "Docs"],
];
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(path) {
  const res = await fetch(path);
  const json = await res.json().catch(() => ({ error: "bad JSON" }));
  if (!res.ok) throw new Error(json.error || ("HTTP " + res.status));
  return json;
}
async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({ error: "bad JSON" }));
  if (!res.ok) throw new Error(json.error || ("HTTP " + res.status));
  return json;
}
const card = (k, v, n) => '<div class="card"><div class="k">' + esc(k) + '</div><div class="v">' +
  esc(v) + '</div>' + (n ? '<div class="n">' + esc(n) + '</div>' : '') + '</div>';

// ---- tabs ----
let current = location.hash.slice(1) || "chain";
$("tabs").innerHTML = TABS.map(([id, label]) =>
  '<button data-t="' + id + '">' + label + '</button>').join("");
function select(id) {
  if (!TABS.some(([t]) => t === id)) id = "chain";
  current = id;
  location.hash = id;
  for (const b of $("tabs").children) b.setAttribute("aria-selected", b.dataset.t === id);
  for (const [t] of TABS) $("s-" + t).classList.toggle("on", t === id);
  if (id === "chain") loadChain();
  if (id === "agents" && !$("ag-cards").innerHTML) loadAgentCount();
}
$("tabs").onclick = (e) => { if (e.target.dataset.t) select(e.target.dataset.t); };

// ---- chain ----
async function loadChain() {
  try {
    const c = await api("/api/chain");
    const match = Number(c.chainId) === Number(c.expectedChainId);
    $("chain").textContent = "chain " + c.chainId + " · block " + c.head + " · " + c.gasPriceGwei + " Gwei";
    $("chain-cards").innerHTML =
      card("chain id", c.chainId, match ? "matches Arc Testnet" : "UNEXPECTED CHAIN") +
      card("head block", c.head) +
      card("gas price", c.gasPriceGwei + " Gwei", "floor " + c.minBaseFeeGwei + " Gwei") +
      card("gas token", "USDC", "18 dec native · 6 dec ERC-20") +
      card("rpc", c.rpcUrl.replace(/^https:\/\//, ""));
  } catch (e) { $("chain").textContent = "rpc error: " + e.message; }
}

// ---- index ----
$("ix-go").onclick = async () => {
  const n = $("ix-blocks").value;
  $("ix-status").textContent = "scanning…"; $("ix-go").disabled = true;
  try {
    const r = await api("/api/index/scan?blocks=" + n);
    const s = r.stats, real = Number(r.movementsTotal);
    const phantom = real ? ((Number(s.naiveRecords) / real - 1) * 100).toFixed(1) : "0";
    const volPct = Number(s.canonicalVolume) ? ((Number(s.doubleCountedVolume) / Number(s.canonicalVolume) - 1) * 100).toFixed(1) : "0";
    $("ix-cards").innerHTML =
      card("real movements", real, r.fromBlock + "–" + r.toBlock) +
      card("native logs", s.nativeLogs, "18 decimals, every movement") +
      card("erc-20 logs", s.erc20Logs, "6 decimals, token calls only") +
      card("phantom rows", "+" + phantom + "%", s.naiveRecords + " rows if you index by topic") +
      card("volume inflation", "+" + volPct + "%", "if decimals are right but dedup is missing") +
      card("dust movements", s.dustMovements, "below 6 decimals, invisible to balanceOf") +
      card("self-transfers", s.selfTransferLogs, "erc-20 log only, moves nothing");
    $("ix-warn").innerHTML = r.anomalies.length
      ? '<div class="f error"><div class="h"><span class="msg">' + r.anomalies.length +
        ' anomalies</span></div><div class="d">' + esc(r.anomalies[0].reason) + '</div></div>'
      : '<p class="note ok">✓ every value-moving ERC-20 log paired with its native log</p>';
    $("ix-table").innerHTML = '<table><tr><th>block</th><th>from</th><th>to</th>' +
      '<th>USDC</th><th>via</th><th>kind</th></tr>' +
      r.movements.map((m) => '<tr><td>' + m.blockNumber + '</td><td>' + m.from.slice(0, 12) +
        '…</td><td>' + m.to.slice(0, 12) + '…</td><td>' + (Number(m.value6) / 1e6).toFixed(6) +
        '</td><td><span class="pill">' + m.via + '</span></td><td>' + m.kind +
        (m.dust ? ' <span class="pill">dust</span>' : '') + '</td></tr>').join("") + '</table>';
    $("ix-status").textContent = "showing the latest " + r.movements.length + " of " + real;
  } catch (e) { $("ix-status").innerHTML = '<span class="error">' + esc(e.message) + '</span>'; }
  $("ix-go").disabled = false;
};
$("rec-go").onclick = async () => {
  const a = $("rec-addr").value.trim();
  $("rec-status").textContent = "reconciling…";
  try {
    const r = await api("/api/index/reconcile?address=" + encodeURIComponent(a) + "&blocks=" + $("ix-blocks").value);
    const u = (v) => (Number(v) / 1e18).toFixed(6) + " USDC";
    const cls = r.verdict === "mismatch" ? "error" : "ok";
    $("rec-out").innerHTML = '<div class="cards">' +
      card("actual delta", u(r.actualDelta), "eth_getBalance") +
      card("indexed delta", u(r.indexedDelta), r.movementCount + " movements") +
      card("residual", u(r.residual), r.verdict === "fees-only" ? "consistent with gas fees" : "") +
      card("verdict", r.verdict) + '</div>' +
      '<p class="note ' + cls + '">' + (r.verdict === "exact"
        ? "✓ every wei of movement is explained by logs"
        : r.verdict === "fees-only"
        ? "✓ the only unexplained outflow is gas, which EIP-7708 does not log"
        : "✗ value arrived that no log explains — the index is incomplete") + '</p>';
    $("rec-status").textContent = "";
  } catch (e) { $("rec-status").innerHTML = '<span class="error">' + esc(e.message) + '</span>'; $("rec-out").innerHTML = ""; }
};

// ---- agents ----
async function loadAgentCount() {
  try {
    const c = await api("/api/agents/count");
    $("ag-cards").innerHTML = card("registered agents", Number(c.total).toLocaleString()) +
      card("highest token id", c.highestId) +
      card("probe cost", c.ethCalls + " eth_calls", "vs ~590 eth_getLogs calls");
  } catch (e) { $("ag-cards").innerHTML = '<p class="note error">' + esc(e.message) + '</p>'; }
}
$("ag-go").onclick = async () => {
  $("ag-status").textContent = "reading…";
  try {
    const rows = await api("/api/agents/list?from=" + $("ag-from").value + "&limit=" + $("ag-limit").value);
    $("ag-table").innerHTML = '<table><tr><th>id</th><th>owner</th><th>metadata uri</th></tr>' +
      rows.map((a) => '<tr><td>#' + a.id + '</td><td>' + a.owner + '</td><td>' +
        (a.metadataURI ? esc(a.metadataURI) : '<span class="pill">none</span>') + '</td></tr>').join("") + '</table>';
    $("ag-status").textContent = rows.length + " minted";
  } catch (e) { $("ag-status").innerHTML = '<span class="error">' + esc(e.message) + '</span>'; }
};
$("ag-show").onclick = async () => {
  $("ag-status").textContent = "reading…";
  try {
    const a = await api("/api/agents/show?id=" + $("ag-id").value);
    const r = a.reputation;
    $("ag-detail").innerHTML = '<div class="cards">' +
      card("agent", "#" + a.id) + card("owner", a.owner) +
      card("attesters", r.clients.length) +
      card("attestations", r.attestations + (r.partial ? "+" : ""),
        r.partial ? "counted " + r.clientsQueried + " of " + r.clients.length : "") + '</div>' +
      (r.topClients.length ? '<div class="wrap"><table><tr><th>attestations</th><th>client</th></tr>' +
        r.topClients.slice(0, 10).map((c) => '<tr><td>' + c.count + '</td><td>' + c.client + '</td></tr>').join("") +
        '</table></div>' : '<p class="note">no attestations recorded</p>') +
      '<p class="note">Per-attestation scores need the canonical ERC-8004 ReputationRegistry ABI, which Arc\'s docs do not publish.</p>';
    $("ag-status").textContent = "";
  } catch (e) { $("ag-status").innerHTML = '<span class="error">' + esc(e.message) + '</span>'; $("ag-detail").innerHTML = ""; }
};

// ---- lint ----
const SAMPLES = {
  solidity: 'pragma solidity ^0.8.28;\n\nimport {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";\n\ncontract Raffle {\n    IERC20 public usdc;\n    uint256 public constant TICKET = 1e18;\n\n    function winner(address[] calldata players) external view returns (address) {\n        uint256 seed = uint256(keccak256(abi.encodePacked(block.prevrandao)));\n        return players[seed % players.length];\n    }\n\n    function burn(uint256 amount) external {\n        payable(address(0)).transfer(amount);\n    }\n\n    function isEmpty(address who) external view returns (bool) {\n        return usdc.balanceOf(who) == 0;\n    }\n}\n',
  script: 'import { parseEther, parseGwei, http } from "viem";\n\nconst rpc = http("http://127.0.0.1:8545");\n\nexport async function pay(token, to) {\n  await token.write.transfer([to, parseEther("100")]);\n}\n\nexport const fees = { maxFeePerGas: parseGwei("5") };\n',
};
$("lint-sample").onclick = () => { $("lint-src").value = SAMPLES[$("lint-lang").value]; };
$("lint-go").onclick = async () => {
  const lang = $("lint-lang").value;
  $("lint-status").textContent = "linting…";
  try {
    const r = await post("/api/lint", { source: $("lint-src").value, lang, filename: lang === "solidity" ? "Input.sol" : "input.ts" });
    $("lint-out").innerHTML = r.findings.length
      ? r.findings.map((f) => '<div class="f ' + f.severity + '"><div class="h">' +
          '<span class="loc">' + f.line + ':' + f.column + '</span>' +
          '<span class="msg">' + esc(f.message) + '</span>' +
          '<span class="rid">' + f.rule + '</span></div>' +
          (f.snippet ? '<div class="snip">' + esc(f.snippet) + '</div>' : '') +
          '<div class="d">' + esc(f.detail) + ' <a href="' + f.doc + '" target="_blank" rel="noreferrer">docs</a></div></div>').join("")
      : '<p class="note ok">✓ no Arc compatibility issues</p>';
    $("lint-status").textContent = r.counts.error + " error · " + r.counts.warning + " warning · " + r.counts.info + " info";
  } catch (e) { $("lint-status").innerHTML = '<span class="error">' + esc(e.message) + '</span>'; }
};

// ---- docs ----
api("/api/docs/sites").then((sites) => {
  $("dsite").innerHTML = '<option value="">all sites</option>' +
    sites.map((s) => '<option value="' + s.site + '">' + s.site + " (" + s.pages + ")</option>").join("");
  const total = sites.reduce((a, s) => a + s.pages, 0);
  $("dq").placeholder = "search " + total + " mirrored pages…";
}).catch(() => {});

async function doSearch() {
  const q = $("dq").value.trim();
  if (q.length < 2) return;
  $("dstatus").textContent = "searching…"; $("dpage").hidden = true;
  try {
    const r = await api("/api/docs/search?q=" + encodeURIComponent(q) + "&limit=30");
    const site = $("dsite").value;
    const hits = site ? r.hits.filter((h) => h.site === site) : r.hits;
    $("dout").innerHTML = hits.length ? hits.map((h) =>
      '<div class="hit"><a href="#" data-site="' + h.site + '" data-path="' + h.path + '">' +
      esc(h.title) + '</a><div class="p">' + h.site + " / " + h.path + '</div>' +
      (h.summary ? '<div>' + esc(h.summary) + '</div>' : '') +
      h.excerpts.map((e) => '<div class="e">' + esc(e).replace(/«/g, "<mark>").replace(/»/g, "</mark>") + '</div>').join("") +
      '</div>').join("") : '<p class="note">no matches</p>';
    $("dstatus").textContent = hits.length + " pages";
  } catch (e) { $("dstatus").innerHTML = '<span class="error">' + esc(e.message) + '</span>'; }
}
$("dgo").onclick = doSearch;
$("dq").onkeydown = (e) => { if (e.key === "Enter") doSearch(); };
$("dout").onclick = async (e) => {
  const a = e.target.closest("a[data-path]");
  if (!a) return;
  e.preventDefault();
  const p = await api("/api/docs/page?site=" + a.dataset.site + "&path=" + encodeURIComponent(a.dataset.path));
  $("dpage").textContent = p.text;
  $("dpage").hidden = false;
  $("dpage").scrollIntoView({ behavior: "smooth" });
};

select(current);
setInterval(() => { if (current === "chain") loadChain(); }, 12000);
</script>
</body>
</html>`;
