import type { Address } from "viem";
import type { Config } from "./config.ts";
import type { SwapAdapter } from "./adapters/types.ts";

/**
 * Prices the gas the relayer will spend settling a payment, in USDG atomic units.
 * gas units × gas price (wei) × ETH price, plus a margin. Payers sign for this up front.
 */
export class GasPricer {
  private ethUsd6: { value: bigint; at: number } | null = null; // USD per ETH, 6 decimals

  constructor(private cfg: Config, private adapter: SwapAdapter) {}

  private async ethPrice(): Promise<bigint> {
    if (this.cfg.gas.ethUsd) {
      const [w, f = ""] = this.cfg.gas.ethUsd.split(".");
      return BigInt(w) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
    }
    if (this.ethUsd6 && Date.now() - this.ethUsd6.at < 60_000) return this.ethUsd6.value;
    if (!this.cfg.gas.weth) throw new Error("Set ETH_USD_PRICE or WETH_ADDRESS to price gas");
    // how much WETH buys exactly 1 USDG → USD per ETH
    const q = await this.adapter.quote(this.cfg.gas.weth, 1_000_000n);
    const value = (10n ** 18n * 1_000_000n) / q.amountIn;
    this.ethUsd6 = { value, at: Date.now() };
    return value;
  }

  /** USDG (6 decimals) to charge for settling one payment paid in `tokenIn`. */
  async fee(tokenIn: Address): Promise<bigint> {
    const units = tokenIn.toLowerCase() === this.cfg.usdg.toLowerCase() ? this.cfg.gas.usdgUnits : this.cfg.gas.swapUnits;
    const [gasPrice, ethUsd6] = await Promise.all([this.cfg.publicClient.getGasPrice(), this.ethPrice()]);
    const usdg = (units * gasPrice * ethUsd6) / 10n ** 18n;
    const withMargin = (usdg * BigInt(10_000 + this.cfg.gas.marginBps)) / 10_000n;
    return withMargin > 0n ? withMargin : 1n;
  }
}
