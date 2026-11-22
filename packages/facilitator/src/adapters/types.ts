import type { Address, Hex } from "viem";

export interface AdapterQuote {
  amountIn: bigint; // estimated input for the exact USDG output
  priceImpact?: number; // 0.01 = 1%
}

export interface BuiltSwap {
  router: Address;
  data: Hex;
}

/** Turns "I need exactly N USDG out of token X" into router calldata whose recipient is the settlement contract. */
export interface SwapAdapter {
  name: string;
  quote(tokenIn: Address, usdgOut: bigint): Promise<AdapterQuote>;
  build(tokenIn: Address, usdgOut: bigint, maxAmountIn: bigint): Promise<BuiltSwap>;
}
