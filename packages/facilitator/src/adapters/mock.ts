import { encodeFunctionData, parseAbi, type Address } from "viem";
import type { Config } from "../config.ts";
import type { AdapterQuote, BuiltSwap, SwapAdapter } from "./types.ts";

const mockRouterAbi = parseAbi([
  "function num() view returns (uint256)",
  "function den() view returns (uint256)",
  "function swapExactOut(address tokenIn, uint256 amountOut, uint256 amountInMax, address recipient, bool viaPermit2)",
]);

/** Local-testing adapter for the MockRouter in contracts/contracts/test/Mocks.sol. */
export class MockAdapter implements SwapAdapter {
  name = "mock";
  constructor(private cfg: Config) {
    if (!cfg.mockRouter) throw new Error("MOCK_ROUTER is required for the mock adapter");
  }

  async quote(_tokenIn: Address, usdgOut: bigint): Promise<AdapterQuote> {
    const c = this.cfg.publicClient;
    const [num, den] = await Promise.all([
      c.readContract({ address: this.cfg.mockRouter, abi: mockRouterAbi, functionName: "num" }),
      c.readContract({ address: this.cfg.mockRouter, abi: mockRouterAbi, functionName: "den" }),
    ]);
    return { amountIn: (usdgOut * num) / den, priceImpact: 0 };
  }

  async build(tokenIn: Address, usdgOut: bigint, maxAmountIn: bigint): Promise<BuiltSwap> {
    return {
      router: this.cfg.mockRouter,
      data: encodeFunctionData({
        abi: mockRouterAbi,
        functionName: "swapExactOut",
        args: [tokenIn, usdgOut, maxAmountIn, this.cfg.settlement, false],
      }),
    };
  }
}
