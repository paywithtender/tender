/**
 * Real payments on Robinhood Chain, all from this PC:
 *   facilitator (local) + demo paid API (local) + test agent wallet  →  real mainnet transactions.
 *
 * Run from packages/facilitator so its .env loads:
 *   node --env-file=.env --import tsx ../../e2e/mainnet-pay.ts            (pays in USDG)
 *   PAY_WITH=0x<token> node --env-file=.env --import tsx ../../e2e/mainnet-pay.ts   (pays in a token)
 */
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createPublicClient, createWalletClient, defineChain, formatEther, formatUnits, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../packages/facilitator/src/server.ts";
import { loadConfig } from "../packages/facilitator/src/config.ts";
import { tenderPaywall } from "../packages/sdk/src/middleware.ts";
import { ensurePermit2Approval, wrapFetchWithTender } from "../packages/sdk/src/client.ts";
import { HEADER_RESPONSE, ROBINHOOD, decodeHeader, type SettleResponse } from "../packages/sdk/src/protocol.ts";
import { erc20Abi } from "../packages/sdk/src/abi.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const EXPLORER = "https://robinhoodchain.blockscout.com";
const PRICE = process.env.PRICE ?? "$0.01";

async function main() {
  const wallets = JSON.parse(fs.readFileSync(path.join(ROOT, ".wallets/wallets.json"), "utf8")).wallets;
  const agentFile = JSON.parse(fs.readFileSync(path.join(ROOT, ".wallets/agent.json"), "utf8"));
  const agent = privateKeyToAccount(agentFile.privateKey as Hex);
  const merchant = wallets.deployer.address as Address; // the deployer's job is done; it plays the demo merchant
  const payWith = (process.env.PAY_WITH || ROBINHOOD.usdg) as Address;

  const cfg = loadConfig();
  const chain = defineChain({ ...cfg.chain, id: cfg.chain.id });
  const pc = createPublicClient({ chain, transport: http(process.env.RPC_URL) });

  const sym = await pc.readContract({ address: payWith, abi: erc20Abi, functionName: "symbol" }).catch(() => "?");
  const dec = await pc.readContract({ address: payWith, abi: erc20Abi, functionName: "decimals" }).catch(() => 18);
  const bal = (t: Address, who: Address) => pc.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [who] });

  console.log("Tender — real payment on Robinhood Chain");
  console.log(`  contract  ${cfg.settlement}`);
  console.log(`  agent     ${agent.address}`);
  console.log(`  merchant  ${merchant} (demo API)`);
  console.log(`  paying    ${PRICE} with ${sym}\n`);

  const tokenBal = await bal(payWith, agent.address);
  console.log(`Agent holds ${formatUnits(tokenBal, Number(dec))} ${sym}, ${formatEther(await pc.getBalance({ address: agent.address }))} ETH`);
  if (tokenBal === 0n) throw new Error(`Agent has no ${sym}. Send some to ${agent.address} on Robinhood Chain first.`);

  // Facilitator + demo API on this PC
  const fac = createApp(cfg).listen(cfg.port);
  const FAC = `http://127.0.0.1:${cfg.port}`;
  const api = express();
  api.use(
    tenderPaywall({
      payTo: merchant,
      facilitator: FAC,
      baseUrl: "http://127.0.0.1:4022",
      routes: { "GET /gas": { price: PRICE, description: "Robinhood Chain gas report" } },
    })
  );
  api.get("/gas", async (_req, res) => {
    const [block, gasPrice] = await Promise.all([pc.getBlockNumber(), pc.getGasPrice()]);
    res.json({ chain: "Robinhood Chain", block: block.toString(), gasPriceGwei: Number(gasPrice) / 1e9 });
  });
  const srv = api.listen(4022);

  try {
    // One-time Permit2 approval (gas sponsored by the facilitator if the agent has no ETH)
    const wallet = createWalletClient({ chain, transport: http(process.env.RPC_URL), account: agent });
    const approval = await ensurePermit2Approval({ wallet, publicClient: pc as any, token: payWith, permit2: cfg.permit2, facilitator: FAC });
    console.log(approval ? `Approved Permit2 for ${sym}: ${EXPLORER}/tx/${approval}` : `Permit2 already approved for ${sym}`);

    // Quote first so you can see the fee before paying
    const q = (await (
      await fetch(`${FAC}/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tokenIn: payWith, amount: String(Math.round(Number(PRICE.replace("$", "")) * 1e6)) }),
      })
    ).json()) as any;
    if (q.error) throw new Error(`quote failed: ${q.error}`);
    console.log(
      `Quote: up to ${formatUnits(BigInt(q.maxAmountIn), Number(dec))} ${sym}; fee ${Number(q.fee) / 1e6} USDG ` +
        `(protocol ${Number(q.feeBreakdown.protocol) / 1e6}, gas ${Number(q.feeBreakdown.gas) / 1e6})`
    );

    const pay = wrapFetchWithTender(fetch, {
      account: agent,
      chain,
      rpcUrl: process.env.RPC_URL,
      payWith,
      maxUsdgPerCall: 100_000n, // never more than $0.10 per call in this test
      maxFeePerCall: 100_000n, // never more than $0.10 in fees
    });
    const merchantBefore = await bal(ROBINHOOD.usdg, merchant);
    const res = await pay("http://127.0.0.1:4022/gas");
    const body = await res.json();
    if (res.status !== 200) throw new Error(`payment refused: ${JSON.stringify(body)}`);
    const s = decodeHeader<SettleResponse>(res.headers.get(HEADER_RESPONSE)!);
    const got = (await bal(ROBINHOOD.usdg, merchant)) - merchantBefore;

    console.log(`\nPAID. The API answered: ${JSON.stringify(body)}`);
    console.log(`Merchant received ${formatUnits(got, 6)} USDG`);
    console.log(`Transaction: ${EXPLORER}/tx/${s.transaction}`);
  } finally {
    srv.close();
    fac.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFAILED:", e.shortMessage ?? e.message ?? e);
    process.exit(1);
  });
