/**
 * Real mainnet test of the Tender MCP server, from this PC:
 *   demo paid API (local, $0.01, settles through the LIVE facilitator) + MCP server with the test agent wallet
 *   → an MCP client calls check_coin, wallet, then pay → a real Robinhood Chain transaction.
 *
 * Run from packages/facilitator:  PAY_WITH=0x<token> node --import tsx ../../e2e/mcp-mainnet.mts
 */
import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { tenderPaywall } from "../packages/sdk/src/middleware.ts";
import { ROBINHOOD } from "../packages/sdk/src/protocol.ts";
import { Client } from "../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import { configFromEnv, createTenderMcp } from "../packages/mcp/src/server.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FAC = "https://facilitator.paywithtender.com";
const RPC = "https://rpc.mainnet.chain.robinhood.com";

async function main() {
  const wallets = JSON.parse(fs.readFileSync(path.join(ROOT, ".wallets/wallets.json"), "utf8")).wallets;
  const agentKey = JSON.parse(fs.readFileSync(path.join(ROOT, ".wallets/agent.json"), "utf8")).privateKey as Hex;
  const merchant = wallets.deployer.address as Address;
  const payWith = (process.env.PAY_WITH || ROBINHOOD.usdg) as Address;

  // Demo paid API on this PC; payments settle through the live facilitator, so they land in the site's feed
  const pc = createPublicClient({ transport: http(RPC) });
  const api = express();
  api.use(
    tenderPaywall({
      payTo: merchant,
      facilitator: FAC,
      baseUrl: "http://127.0.0.1:4022",
      routes: { "GET /gas": { price: "$0.01", description: "Robinhood Chain gas report" } },
    })
  );
  api.get("/gas", async (_req, res) => {
    const [block, gasPrice] = await Promise.all([pc.getBlockNumber(), pc.getGasPrice()]);
    res.json({ chain: "Robinhood Chain", block: block.toString(), gasPriceGwei: Number(gasPrice) / 1e9 });
  });
  const srv = api.listen(4022);

  const { server } = createTenderMcp(
    configFromEnv({
      TENDER_PRIVATE_KEY: agentKey,
      TENDER_PAY_WITH: payWith,
      TENDER_FACILITATOR: FAC,
      TENDER_RPC_URL: RPC,
      TENDER_MAX_PER_CALL_USD: "0.05",
      TENDER_MAX_FEE_USD: "0.10",
      TENDER_DAILY_LIMIT_USD: "0.05",
      TENDER_ALLOW_HTTP: "true", // the demo API runs on this PC
    } as NodeJS.ProcessEnv)
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "tender-mainnet-test", version: "1" });
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    const t = r.content.map((c: any) => c.text).join("\n");
    console.log(`\n> ${name} ${JSON.stringify(args)}\n${t}`);
    if (r.isError) throw new Error(`${name} failed`);
    return r;
  };

  try {
    console.log("Tender MCP server: real payment on Robinhood Chain");
    await call("check_coin", { token: payWith });
    await call("wallet");
    const paid = await call("pay", { url: "http://127.0.0.1:4022/gas" });
    if (!paid.structuredContent?.paid) throw new Error("the API answered but nothing was paid");
    console.log("\nPASSED: an AI agent paid a real API through the Tender MCP server.");
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
