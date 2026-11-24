/**
 * End-to-end test on a local Hardhat chain:
 *   deploy Permit2 + mocks + TenderSettlement → start facilitator → start a paywalled merchant API →
 *   agent A pays in USDG (exact) → agent B (no ETH) gets gas sponsored, approves Permit2, pays in MEME (tender-swap)
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
      DATA_DIR: fs.mkdtempSync("/tmp/tender-e2e-"),
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

    // ---------------------------------------------------------------- 1. unpaid → 402
    console.log("\n1. Unpaid request");
    const r402 = await fetch(URL_);
    const body = (await r402.json()) as any;
    check("returns 402", r402.status === 402);
    check("offers tender-swap only (exact is off by default)", body.accepts.map((a: any) => a.scheme).join(",") === "tender-swap");
    check("free route untouched", (await fetch("http://127.0.0.1:4022/free")).status === 200);

    const settledEvent = async (hash: Hex) => {
      const receipt = await pc.getTransactionReceipt({ hash });
      return (parseEventLogs({ abi: artifact("TenderSettlement").abi, logs: receipt.logs, eventName: "Settled" }) as any[])[0].args;
    };

    // ---------------------------------------------------------------- 2. agent A pays USDG
    console.log("\n2. Agent A pays in USDG (Permit2, no swap, gas fee only), starting with zero ETH");
    const agentA = privateKeyToAccount(generatePrivateKey());
    await call(usdg, "MockUSDG", "mint", [agentA.address, 1_000_000n]);
    const wA = createWalletClient({ chain, transport: http(RPC), account: agentA });
    await ensurePermit2Approval({ wallet: wA, publicClient: pc as any, token: usdg, permit2, facilitator: FAC });
    const q = (await (await fetch(`${FAC}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenIn: usdg, amount: "50000" }) })).json()) as any;
    check("USDG quote has no protocol fee, only gas", q.feeBreakdown.protocol === "0" && BigInt(q.feeBreakdown.gas) > 0n, `gas fee ${Number(q.feeBreakdown.gas) / 1e6} USDG`);
    const fetchA = wrapFetchWithTender(fetch, { account: agentA, chain, rpcUrl: RPC });
    const rA = await fetchA(URL_);
    check("200 after paying", rA.status === 200, JSON.stringify(await rA.clone().json()));
    const sA = decodeHeader<SettleResponse>(rA.headers.get(HEADER_RESPONSE) ?? "e30=");
    check("settlement tx returned", !!sA.transaction && sA.success);
    const evA = await settledEvent(sA.transaction as Hex);
    check("merchant got exactly 0.05 USDG", (await bal(usdg, merchant)) === 50_000n);
    check("treasury got the gas fee", (await bal(usdg, treasury)) === evA.fee && evA.fee > 0n);
    check("agent A paid price + gas fee, nothing more", (await bal(usdg, agentA.address)) === 1_000_000n - 50_000n - evA.fee);

    // ---------------------------------------------------------------- 3. agent B pays a memecoin
    console.log("\n3. Agent B pays in RHDOGE (swap), starting with zero ETH");
    const agentB = privateKeyToAccount(generatePrivateKey());
    await call(meme, "MockERC20", "mint", [agentB.address, parseEther("1000")]);
    const wB = createWalletClient({ chain, transport: http(RPC), account: agentB });
    check("agent B has no ETH", (await pc.getBalance({ address: agentB.address })) === 0n);
    await ensurePermit2Approval({ wallet: wB, publicClient: pc as any, token: meme, permit2, facilitator: FAC });
    check("gas sponsored + Permit2 approved", (await pc.readContract({ address: meme, abi: erc20Abi, functionName: "allowance", args: [agentB.address, permit2] })) > 0n);

    const fetchB = wrapFetchWithTender(fetch, { account: agentB, chain, rpcUrl: RPC, payWith: meme });
    const memeBefore = await bal(meme, agentB.address);
    const rB = await fetchB(URL_);
    check("200 after paying", rB.status === 200, JSON.stringify(await rB.clone().json()));
    const sB = decodeHeader<SettleResponse>(rB.headers.get(HEADER_RESPONSE) ?? "e30=");
    const ev = await settledEvent(sB.transaction as Hex);
    check("merchant now has 0.10 USDG", (await bal(usdg, merchant)) === 100_000n);
    check("fee = 0.5% (250) + gas", ev.fee > 250n, `fee ${Number(ev.fee) / 1e6} USDG`);
    check("treasury holds both fees", (await bal(usdg, treasury)) === evA.fee + ev.fee);
    for (const [label, hash, fee] of [["USDG", sA.transaction, evA.fee], ["swap", sB.transaction, ev.fee]] as const) {
      const rc = await pc.getTransactionReceipt({ hash: hash as Hex });
      const costUsdg = (rc.gasUsed * rc.effectiveGasPrice * 10n * 1_000_000n) / 10n ** 18n; // ETH_USD_PRICE=10
      check(`${label} fee covers the relayer's real gas`, fee >= costUsdg, `gas ${Number(costUsdg) / 1e6} vs fee ${Number(fee) / 1e6} USDG, ${rc.gasUsed} gas`);
    }
    const spent = memeBefore - (await bal(meme, agentB.address));
    check("agent B spent exactly the swap input", spent === ev.amountIn, `${Number(spent) / 1e18} RHDOGE`);
    check("settlement contract holds nothing", (await bal(meme, settlement)) === 0n && (await bal(usdg, settlement)) === 0n);

    // ---------------------------------------------------------------- 4. abuse cases
    console.log("\n4. Abuse cases");
    let captured = "";
    const spy: typeof fetch = async (input, init) => {
      const h = new Headers(init?.headers).get("PAYMENT-SIGNATURE");
      if (h) captured = h;
      return fetch(input, init);
    };
    const fetchSpy = wrapFetchWithTender(spy, { account: agentB, chain, rpcUrl: RPC, payWith: meme });
    check("second memecoin payment works", (await fetchSpy(URL_)).status === 200);
    const replay = await fetch(URL_, { headers: { "PAYMENT-SIGNATURE": captured } });
    check("replayed payment refused", replay.status === 402, ((await replay.json()) as any).error);
    const cheap = wrapFetchWithTender(fetch, { account: agentA, chain, rpcUrl: RPC, maxUsdgPerCall: 10_000n });
    let capped = false;
    try {
      await cheap(URL_);
    } catch {
      capped = true;
    }
    check("client spend cap enforced", capped);
    const stingy = wrapFetchWithTender(fetch, { account: agentB, chain, rpcUrl: RPC, payWith: meme, maxFeePerCall: 1n });
    let feeCapped = false;
    try {
      await stingy(URL_);
    } catch {
      feeCapped = true;
    }
    check("client fee cap enforced", feeCapped);
    const resp = await fetch(`${FAC}/sponsor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payer: agentB.address, token: meme }),
    });
    check("second sponsorship refused", resp.status === 400);

    const feed = (await (await fetch(`${FAC}/feed`)).json()) as any;
    check("feed shows the swap", feed.recent[0]?.symbol === "RHDOGE" && feed.totals.payments === 3, JSON.stringify(feed.totals));
  } finally {
    servers.forEach((s) => s.close());
    node.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll end-to-end checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
