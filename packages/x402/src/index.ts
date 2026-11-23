/**
 * @paywithtender/x402: Tender's "tender-swap" scheme for Coinbase's x402 SDKs (@x402/core, @x402/express, @x402/fetch…).
 *
 *   APIs:   register TenderSwapServer next to ExactEvmScheme, and agents can pay with ANY token that has a
 *           Uniswap route on Robinhood Chain. You still receive exact USDG.
 *   Agents: register TenderSwapClient and pay x402 APIs with whatever token the wallet holds.
 *
 * Payments settle through the Tender facilitator (facilitator.paywithtender.com).
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddress,
  type Address,
  type Chain,
  type LocalAccount,
  type PublicClient,
} from "viem";
import { ROBINHOOD, SCHEME_SWAP, buildPayment, ensurePermit2Approval } from "@paywithtender/sdk";

export const TENDER_FACILITATOR = "https://facilitator.paywithtender.com";
export const ROBINHOOD_NETWORK = `eip155:${ROBINHOOD.chainId}`;

// Minimal structural types, so this package works across @x402/core minor versions.
interface Requirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}
interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}
type Price = string | number | { amount: string; asset: string; extra?: Record<string, unknown> };
interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

function usdToUnits(price: string | number): string {
  const s = String(price).trim().replace(/^\$/, "").replace(/\s*(usd|usdg)$/i, "");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`tender-swap: can't read price ${JSON.stringify(price)}; use "$0.01" or { amount, asset }`);
  const [w, f = ""] = s.split(".");
  if (f.length > 6) throw new Error(`tender-swap: USDG has 6 decimals, ${price} has more`);
  return (BigInt(w) * 1_000_000n + BigInt((f + "000000").slice(0, 6))).toString();
}

// ---------------------------------------------------------------------------------------------- server
export interface TenderSwapServerOptions {
  /** Facilitator agents should get quotes from. Default: the public Tender facilitator. */
  facilitator?: string;
  /** USDG address per network, for networks other than Robinhood Chain (e.g. a local test chain). */
  usdg?: Record<string, string>;
}

/**
 * Server side of tender-swap for x402ResourceServer:
 *   new x402ResourceServer(facilitatorClient).register("eip155:4663", new TenderSwapServer())
 * and add { scheme: "tender-swap", price: "$0.01", network: "eip155:4663", payTo } to a route's accepts.
 */
export class TenderSwapServer {
  readonly scheme = SCHEME_SWAP;
  readonly defaultAssetTransferMethod = "default";
  // verify before your handler runs, settle after it succeeds (the payer isn't charged if your handler fails)
  readonly paymentFlows = { default: { supported: ["authorization"] as const, default: "authorization" as const } };
  private readonly facilitator: string;
  private readonly usdg: Record<string, string>;

  constructor(opts: TenderSwapServerOptions = {}) {
    this.facilitator = (opts.facilitator ?? TENDER_FACILITATOR).replace(/\/$/, "");
    this.usdg = { [ROBINHOOD_NETWORK]: ROBINHOOD.usdg, ...(opts.usdg ?? {}) };
  }

  private usdgFor(network: string): string {
    const a = this.usdg[network];
    if (!a) throw new Error(`tender-swap: no USDG address for ${network}; pass { usdg: { "${network}": "0x…" } }`);
    return a;
  }

  getAssetDecimals(asset: string, network: string): number | undefined {
    return asset.toLowerCase() === this.usdg[network]?.toLowerCase() ? 6 : undefined;
  }

  async parsePrice(price: Price, network: string) {
    if (typeof price === "object" && price !== null && "amount" in price) {
      return { amount: price.amount, asset: price.asset ?? this.usdgFor(network), extra: price.extra ?? {} };
    }
    return { amount: usdToUnits(price), asset: this.usdgFor(network), extra: {} };
  }

  async enhancePaymentRequirements(req: Requirements, kind: SupportedKind, _extensions: string[]): Promise<Requirements> {
    const k = (kind?.extra ?? {}) as { settlement?: string; permit2?: string };
    if (!k.settlement || !k.permit2) throw new Error("tender-swap: the facilitator didn't advertise settlement/permit2; is it a Tender facilitator?");
    return { ...req, extra: { ...(req.extra ?? {}), facilitator: this.facilitator, settlement: k.settlement, permit2: k.permit2 } };
  }

  validateFacilitatorSupport(_network: string, kind: SupportedKind): string | void {
    const k = (kind?.extra ?? {}) as { settlement?: string };
    if (!k.settlement) return "the facilitator supports tender-swap but didn't advertise its settlement contract";
  }
}

// ---------------------------------------------------------------------------------------------- client
export interface TenderSwapClientOptions {
  /** The agent's account (e.g. privateKeyToAccount(key)). It signs locally; the key never leaves this process. */
  account: LocalAccount;
  /** Token to pay with. Omit to pay in USDG (through Tender, gas-only fee). */
  payWith?: Address;
  /** RPC for the network. Default: Robinhood Chain public RPC. */
  rpcUrl?: string;
  /** Chain, for networks other than Robinhood Chain. */
  chain?: Chain;
  /** Refuse if Tender's fee + gas for one payment is above this (USDG atomic units). Default $0.10. */
  maxFeePerCall?: bigint;
  /** Approve Permit2 for the token automatically on first use (gas sponsored if the wallet has no ETH). Default true. */
  autoApprove?: boolean;
}

/**
 * Client side of tender-swap for x402Client / @x402/fetch:
 *   wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: "eip155:4663", client: new TenderSwapClient({ account, payWith }) }] })
 */
export class TenderSwapClient {
  readonly scheme = SCHEME_SWAP;
  readonly schemeHooks: { onBeforePaymentCreation: (ctx: any) => Promise<void> };
  private readonly opts: TenderSwapClientOptions;
  private readonly chain: Chain;
  private readonly rpcUrl: string;
  private readonly pc: PublicClient;
  // tender-swap signatures commit to the API's URL, which x402 passes to hooks but not to createPaymentPayload
  private readonly resources = new WeakMap<object, ResourceInfo>();
  private lastResource: ResourceInfo | undefined;
  private readonly approved = new Set<string>();

  constructor(opts: TenderSwapClientOptions) {
    if (!opts?.account) throw new Error("tender-swap: account is required");
    if (opts.payWith && !isAddress(opts.payWith)) throw new Error("tender-swap: payWith must be a token address");
    this.opts = opts;
    this.rpcUrl = opts.rpcUrl ?? "https://rpc.mainnet.chain.robinhood.com";
    this.chain =
      opts.chain ??
      defineChain({
        id: ROBINHOOD.chainId,
        name: "Robinhood Chain",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [this.rpcUrl] } },
      });
    this.pc = createPublicClient({ chain: this.chain, transport: http(this.rpcUrl) }) as PublicClient;
    this.schemeHooks = {
      onBeforePaymentCreation: async (ctx: any) => {
        const resource = ctx?.paymentRequired?.resource as ResourceInfo | undefined;
        if (resource) {
          this.lastResource = resource;
          if (ctx.selectedRequirements && typeof ctx.selectedRequirements === "object") this.resources.set(ctx.selectedRequirements, resource);
        }
      },
    };
  }

  async createPaymentPayload(x402Version: number, req: Requirements, context?: { maxAmountPerPayment?: string }) {
    const resource = this.resources.get(req as object) ?? this.lastResource;
    if (!resource?.url) throw new Error("tender-swap: no resource URL for this payment");
    const extra = (req.extra ?? {}) as { facilitator?: string; permit2?: Address };
    const token = this.opts.payWith ? getAddress(this.opts.payWith) : (getAddress(req.asset) as Address);

    if (this.opts.autoApprove !== false && !this.approved.has(token.toLowerCase())) {
      const wallet = createWalletClient({ chain: this.chain, transport: http(this.rpcUrl), account: this.opts.account });
      await ensurePermit2Approval({
        wallet,
        publicClient: this.pc,
        token,
        permit2: extra.permit2 ?? ROBINHOOD.permit2,
        facilitator: extra.facilitator ?? TENDER_FACILITATOR,
      });
      this.approved.add(token.toLowerCase());
    }

    const cap = context?.maxAmountPerPayment ? BigInt(context.maxAmountPerPayment) : BigInt(req.amount);
    const pp = await buildPayment(
      this.pc,
      {
        account: this.opts.account,
        chain: this.chain,
        rpcUrl: this.rpcUrl,
        payWith: token,
        maxFeePerCall: this.opts.maxFeePerCall ?? 100_000n,
      },
      { x402Version, resource, accepts: [req as any] },
      cap
    );
    return { x402Version, payload: pp.payload as unknown as Record<string, unknown> };
  }
}
