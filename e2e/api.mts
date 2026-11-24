/**
 * Paid API test (/api/*) on a local Hardhat chain: same stack as run.ts, then an MCP client drives
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
      DATA_DIR: fs.mkdtempSync("/tmp/tender-api-"),
      PORT: "4021",
      PUBLIC_URL: "http://127.0.0.1:4021",
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

    const agentKey = generatePrivateKey();
    const agent = privateKeyToAccount(agentKey);
    await call(meme, "MockERC20", "mint", [agent.address, parseEther("1000")]);
    const { server } = createTenderMcp(configFromEnv({
      TENDER_PRIVATE_KEY: agentKey, TENDER_PAY_WITH: meme, TENDER_CHAIN_ID: "31337", TENDER_RPC_URL: RPC,
      TENDER_FACILITATOR: FAC, TENDER_USDG: usdg, TENDER_PERMIT2: permit2, TENDER_ALLOW_HTTP: "true",
      TENDER_STATE_FILE: "none",
    } as any));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(ct);
    const pay = async (url: string) => {
      const r: any = await client.callTool({ name: "pay", arguments: { url } });
      return { text: r.content.map((c: any) => c.text).join("\n"), s: r.structuredContent ?? {}, err: !!r.isError };
    };
    const API = FAC + "/api";

    console.log("\n1. Free index");
    const idx = await (await fetch(API)).json() as any;
    check("lists 2 paid endpoints", idx.endpoints?.length === 2, idx.endpoints?.map((e: any) => e.path).join(", "));

    console.log("\n2. Unpaid calls");
    const g = await fetch(API + "/gas");
    const g402 = await g.json() as any;
    check("/api/gas answers 402", g.status === 402);
    check("asks for $0.01 to the treasury", g402.accepts?.[0]?.amount === "10000" && g402.accepts[0].payTo.toLowerCase() === treasury.toLowerCase());
    check("offers the facilitator for quotes", g402.accepts?.[0]?.extra?.facilitator === FAC);
    check("CORS exposes payment headers", (g.headers.get("access-control-expose-headers") ?? "").includes("PAYMENT-REQUIRED"));
    check("bad address refused before payment (400)", (await fetch(API + "/token?address=nope")).status === 400);
    check("non-token refused before payment (400)", (await fetch(API + "/token?address=0x000000000000000000000000000000000000dEaD")).status === 400);

    console.log("\n3. Paid calls through the MCP server, paying in a memecoin");
    const before = await bal(usdg, treasury);
    const p1 = await pay(API + "/gas");
    const gas = JSON.parse(p1.s.body ?? "{}");
    check("/api/gas paid and answered", p1.s.paid === true && gas.chainId === 31337 && typeof gas.gasPriceGwei === "number", p1.text.split("\n")[1]);
    check("gas body has costs", gas.costUsd && gas.costUsd.tenderPayment > 0, JSON.stringify(gas.costUsd));
    const p2 = await pay(API + "/token?address=" + meme);
    const tok = JSON.parse(p2.s.body ?? "{}");
    check("/api/token paid and answered", p2.s.paid === true && tok.symbol === "RHDOGE" && tok.spendable === true, `price $${tok.priceUsd}, mcap $${tok.marketCapUsd}`);
    const got = (await bal(usdg, treasury)) - before;
    check("treasury got $0.02 + both fees", got > 20_000n, `${Number(got) / 1e6} USDG`);
    const feed = (await (await fetch(FAC + "/feed")).json()) as any;
    check("both calls in the feed", feed.totals.payments === 2, JSON.stringify(feed.totals));
    console.log("\n4. Spendable badge");
    const b1 = await fetch(FAC + "/badge/" + meme + ".svg");
    const svg1 = await b1.text();
    check("badge for a routable coin says Spendable on Tender", b1.status === 200 && svg1.includes("Spendable on Tender") && svg1.includes("$RHDOGE"), b1.headers.get("content-type") ?? "");
    check("badge is cached for 5 minutes", (b1.headers.get("cache-control") ?? "").includes("max-age=300"));
    const b2 = await fetch(FAC + "/badge/0x000000000000000000000000000000000000dEaD.svg");
    check("badge for a non-token says Not a token", (await b2.text()).includes("Not a token"));
    check("badge for a bad address is 404", (await fetch(FAC + "/badge/nope.svg")).status === 404);
    check("health still fine", (await (await fetch(FAC + "/healthz")).json() as any).ok === true);
  } finally {
    servers.forEach((s) => s.close());
    node.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll paid API checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
