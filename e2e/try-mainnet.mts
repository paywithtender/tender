/**
 * Runs the paywithtender.com/try payment flow from this PC, with the test agent wallet instead of a browser wallet.
 * Same steps as the page: read the 402 price, one-time Permit2 approval (non-USDG), sign, settle, read the receipt.
 *
 *   PAY_WITH=0x<token> node --import tsx e2e/try-mainnet.mts     (no PAY_WITH = USDG)
 */
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, erc20Abi, formatUnits, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildPayment, ensurePermit2Approval } from "../packages/sdk/src/client.ts";
import { ROBINHOOD } from "../packages/sdk/src/protocol.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const FACILITATOR = "https://facilitator.paywithtender.com";
const API = FACILITATOR + "/api/gas";
const EXPLORER = "https://robinhoodchain.blockscout.com";
const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = <T,>(s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8")) as T;
const step = (n: number, s: string) => console.log(`\n[${n}] ${s}`);

async function main() {
  const key = JSON.parse(fs.readFileSync(path.join(ROOT, ".wallets/agent.json"), "utf8")).privateKey as Hex;
  const local = privateKeyToAccount(key);
  const token = (process.env.PAY_WITH || ROBINHOOD.usdg) as Address;
  const isUsdg = token.toLowerCase() === ROBINHOOD.usdg.toLowerCase();
  const pc = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;
  const wallet = createWalletClient({ account: local, chain, transport: http(RPC) });

  step(1, `Wallet ${local.address}`);
  const [symbol, decimals, balance, eth] = await Promise.all([
    pc.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    pc.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [local.address] }),
    pc.getBalance({ address: local.address }),
  ]);
  console.log(`    ${formatUnits(balance, decimals)} ${symbol}, ${formatUnits(eth, 18)} ETH`);

  step(2, `Paying with ${symbol}`);
  if (!isUsdg) {
    const q = await (await fetch(FACILITATOR + "/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenIn: token, amount: "10000" }) })).json();
    if (q.error) throw new Error(`${symbol} can't be routed right now: ${q.error}`);
    console.log(`    costs about ${formatUnits(BigInt(q.estimatedAmountIn), decimals)} ${symbol}, fee ${formatUnits(BigInt(q.fee), 6)} USDG incl. gas`);
    if (balance < BigInt(q.estimatedAmountIn)) throw new Error(`not enough ${symbol} in the agent wallet`);
  } else if (balance < 10_000n) throw new Error("not enough USDG in the agent wallet (needs 0.01)");

  step(3, "Paying $0.01");
  const first = await fetch(API);
  if (first.status !== 402) throw new Error(`API answered ${first.status}, expected 402`);
  const hdr = first.headers.get("PAYMENT-REQUIRED");
  const required = hdr ? unb64<any>(hdr) : await first.json();
  console.log(`    API asks ${required.accepts.map((a: any) => a.scheme).join(" or ")}`);

  if (!isUsdg) {
    const approved = await ensurePermit2Approval({ wallet: wallet as any, publicClient: pc, token, permit2: ROBINHOOD.permit2, facilitator: FACILITATOR });
    console.log(approved ? `    one-time Permit2 approval: ${EXPLORER}/tx/${approved}` : "    Permit2 already approved");
  }
  // same adapter the page uses: a wallet that only signs
  const account = { address: local.address, type: "local", signTypedData: (td: any) => wallet.signTypedData({ account: local, ...td }) } as any;
  const payload = await buildPayment(pc, { account, chain, payWith: isUsdg ? undefined : token, maxFeePerCall: 100_000n }, required, 1_000_000n);
  console.log(`    signed (${(payload as any).accepted.scheme})`);

  const paid = await fetch(API, { headers: { "PAYMENT-SIGNATURE": b64(payload) } });
  const body = await paid.text();
  if (!paid.ok) throw new Error(`payment failed (${paid.status}): ${body.slice(0, 400)}`);
  const resp = paid.headers.get("PAYMENT-RESPONSE");
  const receipt = resp ? unb64<any>(resp) : {};

  console.log("\n================ PASSED ================");
  console.log(`Paid with:  ${symbol}`);
  console.log(`API got:    0.01 USDG`);
  console.log(`Tx:         ${receipt.transaction ? `${EXPLORER}/tx/${receipt.transaction}` : "(no receipt header)"}`);
  console.log(`API said:   ${body.slice(0, 300)}`);
}

main().catch((e) => {
  console.error("\n================ FAILED ================");
  console.error(e?.shortMessage || e?.message || e);
  process.exitCode = 1;
});
