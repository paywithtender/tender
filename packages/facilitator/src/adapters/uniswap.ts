import type { Address, Hex } from "viem";
import type { Config } from "../config.ts";
import type { AdapterQuote, BuiltSwap, SwapAdapter } from "./types.ts";

/**
 * Uniswap Trading API, in its "proxy approval" mode (x-permit2-disabled: true).
 * The swapper is the TenderSettlement contract: it approves the returned router for exactly the
 * amount it pulled from the payer, so the router must be allowlisted on-chain with usesPermit2 = false.
 */
export class UniswapAdapter implements SwapAdapter {
  name = "uniswap-trading-api";
  constructor(private cfg: Config) {
    if (!cfg.uniswapApiKey) throw new Error("UNISWAP_API_KEY is required for the uniswap adapter");
  }

  private headers() {
    return {
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": this.cfg.uniswapApiKey,
      "x-permit2-disabled": "true",
      "x-universal-router-version": "2.1.2",
    };
  }

  private async rawQuote(tokenIn: Address, usdgOut: bigint, slippagePct: number) {
    const res = await fetch(`${this.cfg.uniswapApiUrl}/quote`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        type: "EXACT_OUTPUT",
        amount: usdgOut.toString(),
        tokenIn,
        tokenOut: this.cfg.usdg,
        tokenInChainId: this.cfg.chain.id,
        tokenOutChainId: this.cfg.chain.id,
        swapper: this.cfg.settlement,
        slippageTolerance: slippagePct,
        routingPreference: "BEST_PRICE",
        protocols: ["V2", "V3", "V4"],
      }),
    });
    if (!res.ok) throw new Error(`uniswap quote ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as any;
    if (process.env.TENDER_DEBUG) console.log("[uniswap quote]", JSON.stringify(json).slice(0, 1500));
    return json;
  }

  async quote(tokenIn: Address, usdgOut: bigint): Promise<AdapterQuote> {
    const q = await this.rawQuote(tokenIn, usdgOut, this.cfg.slippageBps / 100);
    const quote = q.quote ?? {};
    const amountIn = BigInt(quote.input?.amount ?? quote.amountIn ?? quote.quote?.amountIn ?? 0);
    if (amountIn === 0n) throw new Error(`uniswap returned no input amount (routing ${q.routing}; keys ${Object.keys(quote).join(",")})`);
    const impact = quote.priceImpact !== undefined ? Number(quote.priceImpact) / 100 : undefined;
    return { amountIn, priceImpact: impact };
  }

  async build(tokenIn: Address, usdgOut: bigint, maxAmountIn: bigint): Promise<BuiltSwap> {
    // The proxy router pulls the route's full maximum (quote + slippage) up front and refunds the rest,
    // and the settlement contract only approves what the payer signed. So the route's maximum must fit
    // under the signed maximum, or the router's pull fails. On fast-moving tokens the fresh quote can be
    // higher than the payer's, so narrow the slippage to the room that's left (never below MIN_ROUTE_SLIPPAGE).
    const fullBps = this.cfg.slippageBps;
    const pulls = (quotedIn: bigint, bps: number) => (quotedIn * BigInt(10_000 + bps + 10)) / 10_000n; // +0.1% for rounding
    let q = await this.rawQuote(tokenIn, usdgOut, fullBps / 100);
    let quotedIn = BigInt(q.quote?.input?.amount ?? 0);
    if (quotedIn === 0n || quotedIn > maxAmountIn) throw new Error("price moved past the payer's signed maximum");
    if (pulls(quotedIn, fullBps) > maxAmountIn) {
      const room = Number((maxAmountIn * 10_000n) / quotedIn - 10_000n) - 15;
      if (room < this.cfg.minRouteSlippageBps) throw new Error("price moved past the payer's signed maximum");
      q = await this.rawQuote(tokenIn, usdgOut, room / 100);
      quotedIn = BigInt(q.quote?.input?.amount ?? 0);
      if (quotedIn === 0n || pulls(quotedIn, room) > maxAmountIn) throw new Error("price moved past the payer's signed maximum");
    }

    // /swap wants the quote response flat, without null permit fields.
    const body: Record<string, unknown> = { ...q };
    delete body.permitData;
    delete body.permitTransaction;
    const res = await fetch(`${this.cfg.uniswapApiUrl}/swap`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`uniswap swap ${res.status}: ${await res.text()}`);
    const swap = ((await res.json()) as any).swap;
    if (!swap?.to || !swap?.data) throw new Error("uniswap returned no swap calldata");
    if (BigInt(swap.value ?? 0) !== 0n) throw new Error("swap needs native value, refusing");
    return { router: swap.to as Address, data: swap.data as Hex };
  }
}
