/**
 * Diagnose why a token's swap fails inside Tender. Builds the same Uniswap route the facilitator would,
 * then replays just the router call as if from the settlement contract (balances faked with state overrides),
 * and prints the router's real revert reason. Read-only: sends no transactions.
 *
 * Run from packages/facilitator:  TOKEN=0x… node --env-file=.env --import tsx ../../e2e/diag-swap.mts
 */
import { decodeErrorResult, encodeAbiParameters, formatUnits, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { loadConfig } from "../packages/facilitator/src/config.ts";
import { UniswapAdapter } from "../packages/facilitator/src/adapters/uniswap.ts";
import { erc20Abi } from "../packages/sdk/src/abi.ts";

const KNOWN = parseAbi([
  "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)",
  "error V4TooMuchRequested(uint256 maxAmountInRequested, uint256 amountRequested)",
  "error V3TooLittleReceived()",
  "error V3TooMuchRequested()",
  "error V2TooLittleReceived()",
  "error V2TooMuchRequested()",
  "error TransactionDeadlinePassed()",
  "error ExecutionFailed(uint256 commandIndex, bytes message)",
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
  "error HookCallFailed()",
  "error Error(string)",
]);

function describe(data: Hex | undefined, depth = 0): string {
  if (!data || data === "0x") return "(no revert data)";
  try {
    const d = decodeErrorResult({ abi: KNOWN, data });
    const args = (d.args ?? []).map((a: any) => (typeof a === "string" && a.startsWith("0x") && a.length > 10 && depth < 3 ? describe(a as Hex, depth + 1) : String(a)));
    return `${d.errorName}(${args.join(", ")})`;
  } catch {
    return `unknown error ${data.slice(0, 10)} ${data.length > 10 ? "+data" : ""}`;
  }
}

const balanceSlotKey = (holder: Address, slot: bigint) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, slot]));
const allowanceSlotKey = (owner: Address, spender: Address, slot: bigint) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, balanceSlotKey(owner, slot)]));

async function main() {
  const token = process.env.TOKEN as Address;
  if (!token) throw new Error("set TOKEN=0x…");
  process.env.TENDER_DEBUG = "1";
  const cfg = loadConfig();
  const pc = cfg.publicClient;
  const adapter = new UniswapAdapter(cfg);
  const settlement = cfg.settlement;
  const out = 30_000n; // $0.01 + about $0.02 of fees, like a real payment
  const [symbol, decimals] = await Promise.all([
    pc.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    pc.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ]);
  console.log(`Token ${symbol} ${token}\n`);

  const q = await adapter.quote(token, out);
  const maxIn = (q.amountIn * BigInt(10_000 + cfg.slippageBps)) / 10_000n;
  console.log(`Quote: ${formatUnits(q.amountIn, Number(decimals))} ${symbol} for $${Number(out) / 1e6}, impact ${q.priceImpact}`);
  const swap = await adapter.build(token, out, maxIn);
  console.log(`\nRouter: ${swap.router}  (calldata ${swap.data.length / 2 - 1} bytes)`);

  // find the token's balance / allowance storage slots so we can fake them for the settlement contract
  let found: bigint | null = null;
  for (let s = 0n; s < 12n && found === null; s++) {
    const fake = toHex(123456789n, { size: 32 });
    const bal = await pc
      .readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [settlement],
        stateOverride: [{ address: token, stateDiff: [{ slot: balanceSlotKey(settlement, s), value: fake }] }],
      })
      .catch(() => 0n);
    if (bal === 123456789n) found = s;
  }
  if (found === null) throw new Error("couldn't find the token's balance storage slot; can't replay");
  const big = toHex(maxIn * 10n, { size: 32 });
  const overrides = [
    {
      address: token,
      stateDiff: [
        { slot: balanceSlotKey(settlement, found), value: big },
        { slot: allowanceSlotKey(settlement, swap.router, found + 1n), value: big },
      ],
    },
  ];
  const allowance = await pc.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [settlement, swap.router], stateOverride: overrides });
  console.log(`Faked settlement balance (slot ${found}) and router allowance: ${allowance > 0n ? "ok" : "allowance slot not found"}`);

  const gasPrice = await pc.getGasPrice();
  for (const [label, gp] of [["gas price 0", undefined], [`real gas price ${formatUnits(gasPrice, 9)} gwei`, gasPrice]] as const) {
    try {
      await pc.call({ account: settlement, to: swap.router, data: swap.data, stateOverride: overrides, gasPrice: gp as any });
      console.log(`\nReplay (${label}): SWAP SUCCEEDS`);
    } catch (e: any) {
      const data = (e.walk?.((x: any) => x?.data)?.data ?? e.data) as Hex | undefined;
      console.log(`\nReplay (${label}): REVERTS -> ${describe(data)}\n  ${e.shortMessage ?? e.message}`.slice(0, 900));
    }
  }
}

main().catch((e) => {
  console.error("\nFAILED:", e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
