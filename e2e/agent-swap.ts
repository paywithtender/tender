/**
 * The test agent swaps a little native ETH for exactly AMOUNT_USDG (default 2) USDG on Robinhood Chain via Uniswap.
 * Run from packages/facilitator:  node --env-file=.env --import tsx ../../e2e/agent-swap.ts
 * Optional: TOKEN_OUT=0x<token> AMOUNT_ETH=0.0005 buys that token with a fixed amount of ETH instead.
 */
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatEther, formatUnits, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(import.meta.dirname, "..");
const RPC = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const ETH = "0x0000000000000000000000000000000000000000";
const API = "https://trade-api.gateway.uniswap.org/v1";
const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });

async function main() {
  const key = process.env.UNISWAP_API_KEY;
  if (!key) throw new Error("UNISWAP_API_KEY missing in packages/facilitator/.env");
  const agentFile = JSON.parse(fs.readFileSync(path.join(ROOT, ".wallets/agent.json"), "utf8"));
  const agent = privateKeyToAccount(agentFile.privateKey as Hex);
  const pc = createPublicClient({ chain, transport: http(RPC) });
  const wc = createWalletClient({ chain, transport: http(RPC), account: agent });

  const eth = await pc.getBalance({ address: agent.address });
  console.log(`Agent ${agent.address} holds ${formatEther(eth)} ETH`);
  if (eth === 0n) throw new Error("Agent has no ETH on Robinhood Chain yet.");

  const tokenOut = process.env.TOKEN_OUT || USDG;
  const exactOut = tokenOut === USDG; // used only for the final balance printout
  const ethIn = process.env.AMOUNT_ETH || (exactOut ? "0.0013" : "0.0005");
  const body = {
    type: "EXACT_INPUT",
    amount: parseEther(ethIn).toString(),
    tokenIn: ETH,
    tokenOut,
    tokenInChainId: 4663,
    tokenOutChainId: 4663,
    swapper: agent.address,
    slippageTolerance: Number(process.env.SWAP_SLIPPAGE || "5"), // some Robinhood v4 pools take a gas-price fee the quote misses
    routingPreference: "BEST_PRICE",
    protocols: ["V2", "V3", "V4"],
  };
  // Native ETH in needs no approval, so use Uniswap's standard route.
  const headers = { "content-type": "application/json", "x-api-key": key };
  const qr = await fetch(`${API}/quote`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!qr.ok) throw new Error(`quote ${qr.status}: ${await qr.text()}`);
  const q: any = await qr.json();
  console.log(`Quote: ${formatEther(BigInt(q.quote.input.amount))} ETH -> ${q.quote.output.amount} (raw units of output token)`);

  const swapBody: any = { ...q };
  delete swapBody.permitData;
  delete swapBody.permitTransaction;
  const sr = await fetch(`${API}/swap`, { method: "POST", headers, body: JSON.stringify(swapBody) });
  if (!sr.ok) throw new Error(`swap ${sr.status}: ${await sr.text()}`);
  const { swap } = (await sr.json()) as any;
  const tx = { account: agent, to: swap.to as Hex, data: swap.data as Hex, value: BigInt(swap.value ?? 0) };
  console.log(`Router ${swap.to}, sending ${formatEther(tx.value)} ETH`);
  try {
    await pc.call(tx); // dry run: surfaces the revert reason without spending gas
  } catch (e: any) {
    throw new Error(`dry run reverted: ${e.shortMessage ?? e.message}\n${e.data ?? e.cause?.data ?? ""}`);
  }
  const hash = await wc.sendTransaction(tx);
  console.log("Sent:", `https://robinhoodchain.blockscout.com/tx/${hash}`);
  const r = await pc.waitForTransactionReceipt({ hash });
  console.log(r.status === "success" ? "Swap done." : "Swap REVERTED.");
  if (exactOut && r.status === "success") {
    const bal = await pc.readContract({
      address: USDG,
      abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }],
      functionName: "balanceOf",
      args: [agent.address],
    });
    console.log(`Agent now holds ${formatUnits(bal, 6)} USDG and ${formatEther(await pc.getBalance({ address: agent.address }))} ETH`);
  }
}

main().catch((e) => {
  console.error("FAILED:", e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
