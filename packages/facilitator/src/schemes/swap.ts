import { BaseError, ContractFunctionRevertedError, verifyTypedData, type Address, type Hex } from "viem";
import { erc20Abi, tenderSettlementAbi } from "@tender/sdk/src/abi.ts";
import {
  resourceHash,
  swapTypedData,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type SwapPayload,
  type SwapQuote,
  type VerifyResponse,
} from "@tender/sdk/src/protocol.ts";
import type { Config } from "../config.ts";
import type { SwapAdapter } from "../adapters/types.ts";
import { GasPricer } from "../gas.ts";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export class SwapScheme {
  private gas: GasPricer;
  constructor(private cfg: Config, private adapter: SwapAdapter) {
    this.gas = new GasPricer(cfg, adapter);
  }

  private isUsdg(token: Address) {
    return token.toLowerCase() === this.cfg.usdg.toLowerCase();
  }

  /** On-chain protocol minimum (0.5% for swaps, 0 for USDG / exempt tokens). */
  private async fee(tokenIn: Address, amountOut: bigint): Promise<bigint> {
    return this.cfg.publicClient.readContract({
      address: this.cfg.settlement,
      abi: tenderSettlementAbi,
      functionName: "quoteFee",
      args: [tokenIn, amountOut],
    });
  }

  /** How much of `tokenIn` the payer should sign for to pay `amountOut` USDG, gas included. */
  async quote(tokenIn: Address, amountOut: bigint): Promise<SwapQuote> {
    if (this.cfg.denylist.has(tokenIn.toLowerCase())) throw new Error("token not accepted");
    const [max, maxGas] = await Promise.all([
      this.cfg.publicClient.readContract({ address: this.cfg.settlement, abi: tenderSettlementAbi, functionName: "maxAmountOut" }),
      this.cfg.publicClient.readContract({ address: this.cfg.settlement, abi: tenderSettlementAbi, functionName: "maxGasFee" }),
    ]);
    if (amountOut === 0n || amountOut > max) throw new Error("amount outside limits");

    const [protocolFee, gasFee] = await Promise.all([this.fee(tokenIn, amountOut), this.gas.fee(tokenIn)]);
    if (gasFee > maxGas) throw new Error("network gas is too expensive to settle right now, try again later");
    const fee = protocolFee + gasFee;
    const base = {
      tokenIn,
      amountOut: amountOut.toString(),
      fee: fee.toString(),
      feeBreakdown: { protocol: protocolFee.toString(), gas: gasFee.toString() },
      expiresAt: Math.floor(Date.now() / 1000) + this.cfg.quoteTtlSeconds,
      settlement: this.cfg.settlement,
    };
    if (this.isUsdg(tokenIn)) {
      const total = (amountOut + fee).toString();
      return { ...base, estimatedAmountIn: total, maxAmountIn: total, priceImpact: 0 };
    }

    const q = await this.adapter.quote(tokenIn, amountOut + fee);
    // Refuse thin liquidity. On tiny payments a pool's fixed per-swap costs (e.g. a gas-based hook fee) read as a
    // large percentage while costing a fraction of a cent, so above the normal limit we still allow the swap when
    // the extra cost in dollars is small, up to a hard ceiling.
    if (q.priceImpact !== undefined && q.priceImpact > this.cfg.maxPriceImpact) {
      const swapUsd6 = amountOut + fee;
      const overheadUsd6 = (swapUsd6 * BigInt(Math.round(q.priceImpact * 1_000_000))) / 1_000_000n;
      if (q.priceImpact > this.cfg.maxPriceImpactSmall || overheadUsd6 > this.cfg.maxImpactUsd6) {
        throw new Error(`not enough liquidity for this token (price impact ${(q.priceImpact * 100).toFixed(1)}%)`);
      }
    }
    // the payer signs for a cushion above the quote, so a fresh route a few seconds later still fits; unused input is refunded
    const buffer = Math.max(this.cfg.signBufferBps, this.cfg.slippageBps);
    const maxAmountIn = (q.amountIn * BigInt(10_000 + buffer)) / 10_000n;
    return { ...base, estimatedAmountIn: q.amountIn.toString(), maxAmountIn: maxAmountIn.toString(), priceImpact: q.priceImpact };
  }

  /** Off-chain checks. `build` also simulates the full settlement on-chain. */
  async verify(pp: PaymentPayload<SwapPayload>, req: PaymentRequirements): Promise<VerifyResponse & { built?: any }> {
    const p = pp.payload;
    const payer = p.payer;
    const fail = (invalidReason: string): VerifyResponse => ({ isValid: false, invalidReason, payer });

    if (req.asset.toLowerCase() !== this.cfg.usdg.toLowerCase()) return fail("unsupported_asset");
    if (p.payment.merchant.toLowerCase() !== req.payTo.toLowerCase()) return fail("recipient_mismatch");
    if (BigInt(p.payment.amountOut) !== BigInt(req.amount)) return fail("amount_mismatch");
    const resourceUrl = pp.resource?.url;
    if (resourceUrl && p.payment.resource !== resourceHash(resourceUrl)) return fail("resource_mismatch");

    const token = p.permit.permitted.token;
    if (this.cfg.denylist.has(token.toLowerCase())) return fail("token_not_accepted");
    const now = Math.floor(Date.now() / 1000);
    if (Number(p.permit.deadline) < now + 10) return fail("permit_expired");

    // The signed fee must cover the protocol minimum plus today's gas (with some tolerance for price moves).
    const [minFee, gasFee] = await Promise.all([this.fee(token, BigInt(p.payment.amountOut)), this.gas.fee(token)]);
    const floor = minFee + (gasFee * BigInt(10_000 - this.cfg.gas.toleranceBps)) / 10_000n;
    if (BigInt(p.payment.fee) < floor) return fail("fee_too_low_for_current_gas");

    const ok = await verifyTypedData({
      address: payer,
      ...swapTypedData(this.cfg.chain.id, this.cfg.permit2, this.cfg.settlement, p),
      signature: p.signature,
    });
    if (!ok) return fail("invalid_signature");

    const maxIn = BigInt(p.permit.permitted.amount);
    const [balance, allowance] = await Promise.all([
      this.cfg.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [payer] }),
      this.cfg.publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [payer, this.cfg.permit2],
      }),
    ]);
    if (balance < maxIn) return fail("insufficient_funds");
    if (allowance < maxIn) return fail("permit2_not_approved");

    // Build the route and dry-run the whole settlement from the relayer.
    let built;
    try {
      built = await this.buildAndSimulate(p);
    } catch (e) {
      return fail(`simulation_failed: ${errName(e)}`);
    }
    return { isValid: true, payer, built };
  }

  private async buildAndSimulate(p: SwapPayload) {
    const out = BigInt(p.payment.amountOut) + BigInt(p.payment.fee);
    if (this.isUsdg(p.permit.permitted.token)) {
      if (BigInt(p.permit.permitted.amount) < out) throw new Error("signed amount below price plus fee");
      const args = settleArgs(p, ZERO, "0x");
      const sim = await this.cfg.publicClient.simulateContract({
        account: this.cfg.account,
        address: this.cfg.settlement,
        abi: tenderSettlementAbi,
        functionName: "settle",
        args,
      });
      return { args, request: sim.request, amountIn: sim.result };
    }
    const swap = await this.adapter.build(p.permit.permitted.token, out, BigInt(p.permit.permitted.amount));
    const allowed = await this.cfg.publicClient.readContract({
      address: this.cfg.settlement,
      abi: tenderSettlementAbi,
      functionName: "routers",
      args: [swap.router],
    });
    if (!allowed) throw new Error(`router ${swap.router} not allowlisted`);
    const args = settleArgs(p, swap.router, swap.data);
    const sim = await this.cfg.publicClient.simulateContract({
      account: this.cfg.account,
      address: this.cfg.settlement,
      abi: tenderSettlementAbi,
      functionName: "settle",
      args,
    });
    return { args, request: sim.request, amountIn: sim.result };
  }

  async settle(pp: PaymentPayload<SwapPayload>, req: PaymentRequirements): Promise<SettleResponse> {
    const v = await this.verify(pp, req);
    const base = { network: this.cfg.network, payer: pp.payload.payer };
    if (!v.isValid || !v.built) return { ...base, success: false, errorReason: v.invalidReason, transaction: "" };

    const hash = await this.cfg.walletClient.writeContract(v.built.request);
    const receipt = await this.cfg.publicClient.waitForTransactionReceipt({ hash });
    return {
      ...base,
      success: receipt.status === "success",
      errorReason: receipt.status === "success" ? undefined : "transaction_reverted",
      transaction: hash,
    };
  }
}

function settleArgs(p: SwapPayload, router: Address, data: Hex) {
  return [
    {
      permitted: { token: p.permit.permitted.token, amount: BigInt(p.permit.permitted.amount) },
      nonce: BigInt(p.permit.nonce),
      deadline: BigInt(p.permit.deadline),
    },
    p.payer,
    {
      merchant: p.payment.merchant,
      amountOut: BigInt(p.payment.amountOut),
      fee: BigInt(p.payment.fee),
      resource: p.payment.resource,
    },
    p.signature,
    router,
    data,
  ] as const;
}

function errName(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? revert.shortMessage;
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}
