/**
 * Real mainnet proof that standard x402 works through Tender:
 *   a demo API built with Coinbase's @x402/express (stock "exact" scheme, facilitator = live Tender)
 *   + the test agent paying with Coinbase's @x402/fetch, in USDG  →  a real Robinhood Chain transaction.
 *
 * With PAY_WITH=0x<token>, the API also offers tender-swap (@paywithtender/x402) and the agent pays in that token.
 *
 * Run from the repo root:  [PAY_WITH=0x…] node --import tsx e2e/x402/mainnet.mts
 */
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createPublicClient, erc20Abi, formatUnits, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme as ExactEvmServer } from "@x402/evm/exact/server";
import { ExactEvmScheme as ExactEvmClient } from "@x402/evm/exact/client";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { TenderSwapClient, TenderSwapServer } from "../../packages/x402/src/index.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const FAC = "https://facilitator.paywithtender.com";
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const NETWORK = "eip155:4663";

async function main() {
  const wallets = JSON.parse(fs.readFileSync(path.join(ROOT, ".wallets/wallets.json"), "utf8")).wallets;
  const agent = privateKeyToAccount(JSON.parse(fs.readFileSync(path.join(ROOT, ".wallets/agent.json"), "utf8")).privateKey as Hex);
  const merchant = wallets.deployer.address as Address; // the deployer plays the demo merchant, as in the other tests
  const pc = createPublicClient({ transport: http(RPC) });
  const bal = (who: Address) => pc.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [who] });

  console.log("Standard x402 on Robinhood Chain, settled by Tender");
  console.log(`  API built with @x402/express, facilitator ${FAC}`);
  console.log(`  Agent using @x402/fetch: ${agent.address}\n`);

  const sup = (await (await fetch(FAC + "/supported")).json()) as any;
  if (!sup.kinds?.some((k: any) => k.scheme === "exact" && k.network === NETWORK)) {
    throw new Error("the live facilitator doesn't offer exact yet: run deploy-facilitator.bat first");
  }

  // a stock x402 API: nothing Tender-specific except the facilitator URL
  const payWith = process.env.PAY_WITH?.trim() as Address | undefined;
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: FAC }))
    .register(NETWORK, new ExactEvmServer())
    .register(NETWORK, new TenderSwapServer() as any);
  const api = express();
  api.use(
    paymentMiddleware(
      {
        "GET /gas": {
          accepts: [
            { scheme: "exact", price: "$0.01", network: NETWORK, payTo: merchant },
            { scheme: "tender-swap", price: "$0.01", network: NETWORK, payTo: merchant },
          ],
          description: "Robinhood Chain gas report",
        },
      },
      server
    )
  );
  api.get("/gas", async (_req, res) => {
    const [block, gasPrice] = await Promise.all([pc.getBlockNumber(), pc.getGasPrice()]);
    res.json({ chain: "Robinhood Chain", block: block.toString(), gasPriceGwei: Number(gasPrice) / 1e9 });
  });
  const srv = api.listen(4032);

  try {
    const before = await bal(merchant);
    console.log(`Agent holds ${formatUnits(await bal(agent.address), 6)} USDG`);
    const client = payWith ? (new TenderSwapClient({ account: agent, payWith }) as any) : new ExactEvmClient(agent as any);
    console.log(payWith ? `Paying with token ${payWith} via @paywithtender/x402 (tender-swap)` : "Paying in USDG via the stock exact scheme");
    const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: NETWORK, client }] });
    const res = await pay("http://127.0.0.1:4032/gas");
    const body = await res.json();
    if (res.status !== 200) throw new Error(`payment refused (${res.status}): ${JSON.stringify(body)}`);
    const settle = JSON.parse(Buffer.from(res.headers.get("payment-response") ?? "", "base64").toString() || "{}");
    const got = (await bal(merchant)) - before;
    console.log(`\nPAID with the standard x402 client. The API answered: ${JSON.stringify(body)}`);
    console.log(`Merchant received ${formatUnits(got, 6)} USDG${payWith ? "" : " (no Tender fee)"}`);
    console.log(`Transaction: https://robinhoodchain.blockscout.com/tx/${settle.transaction}`);
    console.log(`\nPASSED: a standard x402 API and client paid through Tender on mainnet${payWith ? ", in a non-USDG token" : ""}.`);
  } finally {
    srv.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFAILED:", e.shortMessage ?? e.message ?? e);
    process.exit(1);
  });
