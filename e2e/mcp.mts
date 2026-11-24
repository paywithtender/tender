/**
 * MCP server test on a local Hardhat chain: same stack as run.ts, then an MCP client drives
 * check_coin / quote / wallet / pay against it (agent starts with zero ETH, pays in a memecoin).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  parseEventLogs,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../packages/facilitator/src/server.ts";
import { loadConfig } from "../packages/facilitator/src/config.ts";
import { tenderPaywall } from "../packages/sdk/src/middleware.ts";
import { Client } from "../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import { createTenderMcp, configFromEnv } from "../packages/mcp/src/server.ts";
import { ensurePermit2Approval, wrapFetchWithTender } from "../packages/sdk/src/client.ts";
import { HEADER_RESPONSE, decodeHeader, type SettleResponse } from "../packages/sdk/src/protocol.ts";
import { erc20Abi } from "../packages/sdk/src/abi.ts";
import os from "node:os";

const STATE = path.join(os.tmpdir(), `tender-mcp-test-${process.pid}.json`);

const ROOT = path.resolve(import.meta.dirname, "..");
const RPC = "http://127.0.0.1:8545";
const chain = defineChain({
  id: 31337,
  name: "hardhat",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
// Hardhat's well-known dev keys
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
] as Hex[];

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "  ✔" : "  ✘"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

function artifact(name: string) {
  const dir = path.join(ROOT, "contracts/artifacts/contracts");
  const find = (d: string): string | undefined => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) {
        const r = find(p);
        if (r) return r;
      } else if (f.name === `${name}.json`) return p;
    }
  };
  const p = find(dir);
  if (!p) throw new Error(`artifact ${name} not found, run hardhat compile`);
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode as Hex };
}

async function main() {
  const node = spawn(process.execPath, [path.join(ROOT, "contracts/node_modules/hardhat/internal/cli/bootstrap.js"), "node", "--port", "8545"], { cwd: path.join(ROOT, "contracts"), stdio: "ignore" });
  const servers: { close(): void }[] = [];
  try {
    const pc = createPublicClient({ chain, transport: http(RPC) });
    for (let i = 0; i < 60; i++) {
      try {
        await pc.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    const owner = privateKeyToAccount(KEYS[0]);
    const relayer = privateKeyToAccount(KEYS[1]);
    const merchant = privateKeyToAccount(KEYS[2]).address;
    const treasury = privateKeyToAccount(generatePrivateKey()).address;
    const wOwner = createWalletClient({ chain, transport: http(RPC), account: owner });

    async function deploy(name: string, args: unknown[] = []) {
      const a = artifact(name);
      const hash = await wOwner.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
      const r = await pc.waitForTransactionReceipt({ hash });
      return r.contractAddress as Address;
    }
    async function call(address: Address, name: string, fn: string, args: unknown[]) {
      const hash = await wOwner.writeContract({ address, abi: artifact(name).abi, functionName: fn, args });
      await pc.waitForTransactionReceipt({ hash });
    }

    console.log("Deploying…");
    const permit2 = await deploy("Permit2");
    const usdg = await deploy("MockUSDG");
    const meme = await deploy("MockERC20", ["Doge on Robinhood", "RHDOGE", 18]);
    const router = await deploy("MockRouter", [usdg, permit2]);
    await call(router, "MockRouter", "setPrice", [10n ** 21n, 10n ** 6n]); // 1 USDG = 1000 RHDOGE
    const settlement = await deploy("TenderSettlement", [owner.address, permit2, usdg, treasury]);
    await call(settlement, "TenderSettlement", "setRelayer", [relayer.address, true]);
    await call(settlement, "TenderSettlement", "setRouter", [router, true, false]);

    // Facilitator
    Object.assign(process.env, {
      CHAIN_ID: "31337",
      RPC_URL: RPC,
      RELAYER_PRIVATE_KEY: KEYS[1],
      USDG_ADDRESS: usdg,
      PERMIT2_ADDRESS: permit2,
      SETTLEMENT_ADDRESS: settlement,
      SWAP_ADAPTER: "mock",
      MOCK_ROUTER: router,
      SPONSOR_ENABLED: "true",
      SPONSOR_MAX_WEI: "1000000000000000",
      ETH_USD_PRICE: "10", // Hardhat gas is ~100x Robinhood Chain's, so a low ETH price keeps fees realistic
      DATA_DIR: fs.mkdtempSync("/tmp/tender-mcp-"),
      PORT: "4021",
    });
    const cfg = loadConfig();
    servers.push(createApp(cfg).listen(4021));
    const FAC = "http://127.0.0.1:4021";

    // Merchant API
    const api = express();
    api.use(
      tenderPaywall({
        payTo: merchant,
        facilitator: FAC,
        chainId: 31337,
        usdg,
        baseUrl: "http://127.0.0.1:4022",
        routes: { "GET /premium": { price: "$0.05", description: "Premium alpha" } },
      })
    );
    api.get("/premium", (_req, res) => res.json({ alpha: "buy low, sell high" }));
    api.get("/free", (_req, res) => res.json({ ok: true }));
    servers.push(api.listen(4022));
    const URL_ = "http://127.0.0.1:4022/premium";

    const bal = (token: Address, who: Address) =>
      pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
    api.get("/cheap", (_req, res) => res.json({ ok: true }));

    // agent: memecoin only, zero ETH
    const agentKey = generatePrivateKey();
    const agent = privateKeyToAccount(agentKey);
    await call(meme, "MockERC20", "mint", [agent.address, parseEther("1000")]);
    const noRoute = await deploy("MockERC20", ["No Pool", "NOPOOL", 18]);

    const cfgM = configFromEnv({
      TENDER_PRIVATE_KEY: agentKey,
      TENDER_PAY_WITH: meme,
      TENDER_CHAIN_ID: "31337",
      TENDER_RPC_URL: RPC,
      TENDER_FACILITATOR: FAC,
      TENDER_USDG: usdg,
      TENDER_PERMIT2: permit2,
      TENDER_MAX_PER_CALL_USD: "0.10",
      TENDER_DAILY_LIMIT_USD: "0.12",
      TENDER_ALLOW_HTTP: "true",
      TENDER_STATE_FILE: STATE,
    } as any);
    const { server } = createTenderMcp(cfgM);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(ct);
    const T = async (name: string, args: Record<string, unknown> = {}) => {
      const r: any = await client.callTool({ name, arguments: args });
      return { text: r.content.map((c: any) => c.text).join("\n"), s: r.structuredContent ?? {}, err: !!r.isError };
    };

    console.log("\n1. Tools are listed");
    const tools = (await client.listTools()).tools.map((t) => t.name).sort().join(",");
    check("check_coin, pay, quote, wallet", tools === "check_coin,pay,quote,wallet", tools);

    console.log("\n2. check_coin");
    const c1 = await T("check_coin", { token: meme });
    check("memecoin is spendable", c1.s.spendable === true, c1.text);
    // the mock router prices any token, so replay the live facilitator's real no-route answer
    const stub = express();
    stub.use(express.json());
    stub.post("/quote", (_req, res) => res.status(400).json({ error: 'uniswap quote 404: {"errorCode":"NoRouteFoundError","detail":"No route with sufficient liquidity was found for this pair."}' }));
    servers.push(stub.listen(4023));
    const { server: s2 } = createTenderMcp({ ...cfgM, facilitator: "http://127.0.0.1:4023" });
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await s2.connect(st2);
    const client2 = new Client({ name: "test2", version: "1" });
    await client2.connect(ct2);
    const r2: any = await client2.callTool({ name: "check_coin", arguments: { token: noRoute } });
    check("token with no pool is 'not yet'", r2.structuredContent?.spendable === false && !r2.isError, r2.content[0].text);
    const c3 = await T("check_coin", { token: "0x000000000000000000000000000000000000dEaD" });
    check("non-token is an error", c3.err, c3.text);
    const c4 = await T("check_coin", { token: usdg });
    check("USDG has no Tender fee", c4.s.spendable === true && c4.s.tenderFeeUsd === "0", c4.text);

    console.log("\n3. quote + wallet");
    const q1 = await T("quote", { usd: "0.05" });
    check("quote in default token", !q1.err && q1.s.symbol === "RHDOGE", q1.text);
    const w1 = await T("wallet");
    check("wallet shows address, balance and limits", w1.text.includes(agent.address) && w1.text.includes("RHDOGE: 1,000") && w1.text.includes("one-time approval"), w1.text.replace(/\n/g, " | "));

    console.log("\n4. pay");
    const f = await T("pay", { url: "http://127.0.0.1:4022/free" });
    check("free endpoint is just fetched", !f.err && f.s.paid === undefined && f.text.includes("HTTP 200"));
    const p1 = await T("pay", { url: URL_ });
    check("paid $0.05 in memecoin, got the data", !p1.err && p1.s.paid === true && p1.text.includes("buy low, sell high"), p1.text.split("\n").slice(0, 2).join(" | "));
    check("gas was sponsored, Permit2 approved on first payment", (await pc.readContract({ address: meme, abi: erc20Abi, functionName: "allowance", args: [agent.address, permit2] })) > 0n);
    check("merchant got exactly $0.05 USDG", (await bal(usdg, merchant)) === 50_000n);
    const capped = await T("pay", { url: URL_, max_usd: "0.01" });
    check("per-call max_usd refuses", capped.err && capped.text.includes("Nothing was paid"), capped.text);
    const daily = await T("pay", { url: URL_ });
    check("2nd $0.05 payment fits under the $0.12 daily limit", !daily.err && daily.s.paid === true, daily.text.split("\n")[1]);
    const daily2 = await T("pay", { url: URL_ });
    check("3rd payment blocked by $0.12 daily limit", daily2.err && daily2.text.includes("today's limit"), daily2.text);
    // a restart (a fresh server process) must not hand out a new day's budget
    const { server: s3 } = createTenderMcp(configFromEnv({
      TENDER_PRIVATE_KEY: agentKey, TENDER_PAY_WITH: meme, TENDER_CHAIN_ID: "31337", TENDER_RPC_URL: RPC, TENDER_FACILITATOR: FAC,
      TENDER_USDG: usdg, TENDER_PERMIT2: permit2, TENDER_MAX_PER_CALL_USD: "0.10", TENDER_DAILY_LIMIT_USD: "0.12",
      TENDER_ALLOW_HTTP: "true", TENDER_STATE_FILE: STATE,
    } as any));
    const [ct3, st3] = InMemoryTransport.createLinkedPair();
    await s3.connect(st3);
    const client3 = new Client({ name: "after-restart", version: "1" });
    await client3.connect(ct3);
    const r3: any = await client3.callTool({ name: "pay", arguments: { url: URL_ } });
    const r3t = r3.content.map((c: any) => c.text).join(" ");
    check("after a restart the daily limit still holds", !!r3.isError && r3t.includes("today's limit"), r3t);
    check("spending is saved to disk", JSON.parse(fs.readFileSync(STATE, "utf8"))[`31337:${agent.address.toLowerCase()}`]?.spent === "100000");
    check("merchant has exactly $0.10, nothing extra paid", (await bal(usdg, merchant)) === 100_000n);
    const bad = await T("pay", { url: "ftp://example.com" });
    check("non-http URL refused", bad.err);
    const w2 = await T("wallet");
    check("wallet shows $0.10 spent", w2.s.spentTodayUsd === "0.1", String(w2.s.spentTodayUsd));
  } finally {
    servers.forEach((s) => s.close());
    node.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll MCP checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
