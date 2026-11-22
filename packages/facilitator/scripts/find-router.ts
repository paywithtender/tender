/**
 * Asks the Uniswap Trading API which proxy router it uses on Robinhood Chain in no-Permit2 mode,
 * so you can allowlist it on the settlement contract.
 *   UNISWAP_API_KEY=... SETTLEMENT_ADDRESS=0x... TOKEN=0x<any liquid memecoin> npx tsx scripts/find-router.ts
 */
import fs from "node:fs";
import { decodeFunctionData, parseAbi, type Hex } from "viem";

const key = process.env.UNISWAP_API_KEY;
const settlement = process.env.SETTLEMENT_ADDRESS;
const token = process.env.TOKEN;
if (!key || !settlement || !token) throw new Error("Set UNISWAP_API_KEY, SETTLEMENT_ADDRESS and TOKEN");

const res = await fetch("https://trade-api.gateway.uniswap.org/v1/check_approval", {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": key, "x-permit2-disabled": "true" },
  body: JSON.stringify({ walletAddress: settlement, token, amount: "1000000000000000000", chainId: 4663 }),
});
const body: any = await res.json();
const data = body?.approval?.data as Hex | undefined;
if (!data) {
  console.log(JSON.stringify(body, null, 2));
  console.log("\nNo approval returned. Run one /verify through the facilitator: the error names the router to allowlist.");
} else {
  const { args } = decodeFunctionData({ abi: parseAbi(["function approve(address spender, uint256 amount)"]), data });
  console.log(`Proxy router: ${args[0]}`);
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/router.txt", String(args[0]));
  console.log(`Allowlist it:\n  ACTION=set-router ROUTER=${args[0]} PERMIT2_MODE=false npx hardhat run scripts/admin.js --network robinhood`);
}
