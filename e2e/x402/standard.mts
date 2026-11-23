/**
 * Standard x402 compatibility: a merchant built with Coinbase's @x402/express and an agent using
 * @x402/fetch, both on the stock "exact" EVM scheme, pay and settle through the Tender facilitator.
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
import { createApp } from "../../packages/facilitator/src/server.ts";
import { loadConfig } from "../../packages/facilitator/src/config.ts";
import { tenderPaywall } from "../../packages/sdk/src/middleware.ts";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme as ExactEvmServer } from "@x402/evm/exact/server";
import { ExactEvmScheme as ExactEvmClient } from "@x402/evm/exact/client";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { TenderSwapClient, TenderSwapServer } from "../../packages/x402/src/index.ts";
import { ensurePermit2Approval, wrapFetchWithTender } from "../../packages/sdk/src/client.ts";
import { HEADER_RESPONSE, decodeHeader, type SettleResponse } from "../../packages/sdk/src/protocol.ts";
import { erc20Abi } from "../../packages/sdk/src/abi.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
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
  const node = spawn("npx", ["hardhat", "node", "--port", "8545"], { cwd: path.join(ROOT, "contracts"), stdio: "ignore" });
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
      DATA_DIR: fs.mkdtempSync("/tmp/tender-x402-"),
      EXACT_ENABLED: "true",
      EXACT_PER_PAYER_DAILY_MAX: "2",
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

    console.log("\n1. Tender's /supported in the standard shape");
    const sup = (await (await fetch(FAC + "/supported")).json()) as any;
    check("lists exact on this chain", sup.kinds.some((k: any) => k.scheme === "exact" && k.network === "eip155:31337"));
    check("has kinds, extensions and signers", Array.isArray(sup.kinds) && Array.isArray(sup.extensions) && typeof sup.signers === "object");

    console.log("\n2. A merchant built with @x402/express, using Tender as its facilitator");
    const shop = express();
    const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: FAC })).register("eip155:31337", new ExactEvmServer());
    const merchant2 = privateKeyToAccount(generatePrivateKey()).address;
    shop.use(
      paymentMiddleware(
        {
          "GET /weather": {
            accepts: [{ scheme: "exact", network: "eip155:31337", payTo: merchant2, price: { amount: "20000", asset: usdg, extra: { name: "Global Dollar", version: "1" } } }],
            description: "Weather report",
          },
        },
        resourceServer
      )
    );
    shop.get("/weather", (_req, res) => res.json({ forecast: "sunny", temperature: 21 }));
    servers.push(shop.listen(4031));
    await new Promise((r) => setTimeout(r, 300));
    const unpaid = await fetch("http://127.0.0.1:4031/weather");
    check("unpaid call gets 402 from the stock middleware", unpaid.status === 402);

    console.log("\n3. An agent using @x402/fetch pays in USDG, settled by Tender");
    const agent = privateKeyToAccount(generatePrivateKey());
    await call(usdg, "MockUSDG", "mint", [agent.address, 1_000_000n]);
    // a local test token isn't one of the SDK's default assets (mainnet USDG is), so allow it explicitly
    const pay = wrapFetchWithPaymentFromConfig(fetch, {
      schemes: [{ network: "eip155:31337", client: new ExactEvmClient(agent as any) }],
      spendControls: { allowedAssets: [{ network: "eip155:31337", asset: usdg, maxAmountPerPayment: "100000" }] },
    } as any);
    const r1 = await pay("http://127.0.0.1:4031/weather");
    const body1 = (await r1.json()) as any;
    check("paid and got the data", r1.status === 200 && body1.forecast === "sunny", JSON.stringify(body1));
    check("merchant got exactly $0.02 USDG", (await bal(usdg, merchant2)) === 20_000n);
    check("agent paid no fee, needed no ETH", (await bal(usdg, agent.address)) === 980_000n && (await pc.getBalance({ address: agent.address })) === 0n);
    const pr = r1.headers.get("payment-response");
    check("PAYMENT-RESPONSE header carries the tx", !!pr && JSON.parse(Buffer.from(pr!, "base64").toString()).transaction?.startsWith("0x"));
    const feed = (await (await fetch(FAC + "/feed")).json()) as any;
    check("payment shows in Tender's live feed", feed.recent[0]?.scheme === "exact" && feed.recent[0]?.usdg === "20000");

    console.log("\n4. Limits on gas Tender covers");
    const r2 = await pay("http://127.0.0.1:4031/weather");
    check("2nd payment fine (per-payer limit 2)", r2.status === 200);
    const r3 = await pay("http://127.0.0.1:4031/weather");
    check("3rd payment refused by the per-payer daily limit", r3.status !== 200, String(r3.status));
    check("merchant got exactly 2 payments, nothing extra moved", (await bal(usdg, merchant2)) === 40_000n);

    console.log("\n5. @paywithtender/x402: the same stock SDKs, now accepting ANY token");
    const shop2 = express();
    const rs2 = new x402ResourceServer(new HTTPFacilitatorClient({ url: FAC }))
      .register("eip155:31337", new ExactEvmServer())
      .register("eip155:31337", new TenderSwapServer({ facilitator: FAC, usdg: { "eip155:31337": usdg } }) as any);
    const merchant3 = privateKeyToAccount(generatePrivateKey()).address;
    shop2.use(
      paymentMiddleware(
        {
          "GET /premium": {
            accepts: [
              { scheme: "exact", network: "eip155:31337", payTo: merchant3, price: { amount: "50000", asset: usdg, extra: { name: "Global Dollar", version: "1" } } },
              { scheme: "tender-swap", network: "eip155:31337", payTo: merchant3, price: "$0.05" },
            ],
            description: "Premium data",
          },
        },
        rs2
      )
    );
    shop2.get("/premium", (_req, res) => res.json({ alpha: "buy low, sell high" }));
    servers.push(shop2.listen(4033));
    await new Promise((r) => setTimeout(r, 300));
    const offer = JSON.parse(Buffer.from((await fetch("http://127.0.0.1:4033/premium")).headers.get("payment-required") ?? "", "base64").toString() || "{}");
    const swapOpt = offer.accepts?.find((a: any) => a.scheme === "tender-swap");
    check("402 offers exact AND tender-swap", offer.accepts?.length === 2 && !!swapOpt);
    check("tender-swap option carries facilitator, settlement, permit2", swapOpt?.extra?.facilitator === FAC && !!swapOpt?.extra?.settlement && !!swapOpt?.extra?.permit2 && swapOpt?.amount === "50000");

    const degen = privateKeyToAccount(generatePrivateKey()); // holds only a memecoin, zero ETH
    await call(meme, "MockERC20", "mint", [degen.address, parseEther("1000")]);
    const pay2 = wrapFetchWithPaymentFromConfig(fetch, {
      // no spendControls override: the client's default USD caps must recognize tender-swap's USDG price on their own
      schemes: [{ network: "eip155:31337", client: new TenderSwapClient({ account: degen, payWith: meme, rpcUrl: RPC, chain: pc.chain!, usdg: { "eip155:31337": usdg } }) as any }],
    } as any);
    const memeBefore = await bal(meme, degen.address);
    const r5 = await pay2("http://127.0.0.1:4033/premium");
    const body5 = (await r5.json()) as any;
    check("stock @x402/fetch paid in a memecoin and got the data", r5.status === 200 && body5.alpha === "buy low, sell high", JSON.stringify(body5));
    check("merchant got exactly $0.05 USDG", (await bal(usdg, merchant3)) === 50_000n);
    check("agent spent memecoin, not USDG, and needed no ETH to start", (await bal(meme, degen.address)) < memeBefore && (await bal(usdg, degen.address)) === 0n);
    const st5 = JSON.parse(Buffer.from(r5.headers.get("payment-response") ?? "", "base64").toString() || "{}");
    check("settled on-chain through the Tender contract", st5.success === true && st5.transaction?.startsWith("0x"));
    const feed5 = (await (await fetch(FAC + "/feed")).json()) as any;
    check("swap payment in the live feed with Tender's fee", feed5.recent[0]?.symbol === "RHDOGE" && BigInt(feed5.recent[0]?.fee ?? 0) > 0n);
  } finally {
    servers.forEach((s) => s.close());
    node.kill();
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll standard x402 checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
