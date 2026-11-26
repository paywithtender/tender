import {
  createPublicClient,
  http,
  maxUint256,
  toHex,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { erc20Abi } from "./abi.ts";
import {
  HEADER_PAYMENT,
  HEADER_REQUIRED,
  SCHEME_EXACT,
  SCHEME_SWAP,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  X402_VERSION,
  decodeHeader,
  encodeHeader,
  resourceHash,
  swapTypedData,
  usdgDomain,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SwapPayload,
  type SwapQuote,
} from "./protocol.ts";

export interface TenderClientOptions {
  account: LocalAccount; // signs payments (an agent's key)
  chain: Chain;
  rpcUrl?: string;
  /** Token to pay with. Omit (or pass USDG) to pay in USDG; any other token goes through a Tender swap. */
  payWith?: Address;
  /** Refuse any single payment above this many USDG atomic units (default 1 USDG). */
  maxUsdgPerCall?: bigint;
  /** Extra slippage check: refuse if the quote wants more than this much of `payWith`. */
  maxTokenPerCall?: bigint;
  /** Refuse if Tender's fee (protocol + gas) is above this many USDG atomic units. */
  maxFeePerCall?: bigint;
}

function randomUint256(): bigint {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return BigInt(toHex(b));
}

async function readRequired(res: Response): Promise<PaymentRequired> {
  const h = res.headers.get(HEADER_REQUIRED);
  if (h) return decodeHeader<PaymentRequired>(h);
  return (await res.json()) as PaymentRequired;
}

/** Wraps fetch so 402 responses are paid automatically, in USDG or any routable token. */
export function wrapFetchWithTender(fetchImpl: typeof fetch, opts: TenderClientOptions): typeof fetch {
  const pc = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) }) as PublicClient;
  const cap = opts.maxUsdgPerCall ?? 1_000_000n;

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const first = await fetchImpl(input, init);
    if (first.status !== 402) return first;

    const required = await readRequired(first);
    const payload = await buildPayment(pc, opts, required, cap);
    const headers = new Headers(init?.headers);
    headers.set(HEADER_PAYMENT, encodeHeader(payload));
    return fetchImpl(input, { ...init, headers });
  }) as typeof fetch;
}

export async function buildPayment(
  pc: PublicClient,
  opts: TenderClientOptions,
  required: PaymentRequired,
  cap: bigint
): Promise<PaymentPayload> {
  const network = `eip155:${opts.chain.id}`;
  const exact = required.accepts.find((a) => a.scheme === SCHEME_EXACT && a.network === network);
  const swapReq = required.accepts.find((a) => a.scheme === SCHEME_SWAP && a.network === network);
  const any = exact ?? swapReq;
  if (!any) throw new Error("no Tender-compatible payment option offered");
  if (BigInt(any.amount) > cap) throw new Error(`price ${any.amount} is above this client's cap ${cap}`);

  const payInUsdg = !opts.payWith || opts.payWith.toLowerCase() === any.asset.toLowerCase();
  if (payInUsdg && exact) return signExact(opts, exact, required);
  if (!swapReq) throw new Error("merchant does not accept Tender payments");
  // USDG without the exact scheme goes through Tender too (Permit2, no swap, gas fee only)
  return signSwap(opts, swapReq, required, payInUsdg ? any.asset : opts.payWith!);
}

async function signExact(opts: TenderClientOptions, req: PaymentRequirements, required: PaymentRequired) {
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: opts.account.address,
    to: req.payTo,
    value: req.amount,
    validAfter: String(now - 600),
    validBefore: String(now + req.maxTimeoutSeconds),
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))) as Hex,
  };
  const extra = (req.extra ?? {}) as { name?: string; version?: string };
  const signature = await opts.account.signTypedData({
    domain: usdgDomain(opts.chain.id, req.asset, extra.name, extra.version),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      ...authorization,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
    },
  });
  const pp: PaymentPayload = {
    x402Version: X402_VERSION,
    resource: required.resource,
    accepted: req,
    payload: { signature, authorization },
  };
  return pp;
}

async function signSwap(opts: TenderClientOptions, req: PaymentRequirements, required: PaymentRequired, token: Address) {
  const extra = (req.extra ?? {}) as { facilitator?: string; settlement?: Address; permit2?: Address };
  if (!extra.facilitator || !extra.settlement || !extra.permit2) throw new Error("tender-swap option is missing extra fields");

  const q = (await (
    await fetch(`${extra.facilitator}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tokenIn: token, amount: req.amount }),
    })
  ).json()) as SwapQuote & { error?: string };
  if (q.error) throw new Error(`quote failed: ${q.error}`);
  if (q.settlement.toLowerCase() !== extra.settlement.toLowerCase()) throw new Error("settlement contract mismatch");
  if (opts.maxTokenPerCall !== undefined && BigInt(q.maxAmountIn) > opts.maxTokenPerCall) {
    throw new Error("quote is above this client's token cap");
  }
  if (opts.maxFeePerCall !== undefined && BigInt(q.fee) > opts.maxFeePerCall) {
    throw new Error(`fee ${q.fee} (gas ${q.feeBreakdown.gas}) is above this client's fee cap`);
  }

  const deadline = Math.floor(Date.now() / 1000) + Math.min(req.maxTimeoutSeconds, 300);
  const unsigned: SwapPayload = {
    payer: opts.account.address,
    permit: { permitted: { token, amount: q.maxAmountIn }, nonce: randomUint256().toString(), deadline: String(deadline) },
    payment: { merchant: req.payTo, amountOut: req.amount, fee: q.fee, resource: resourceHash(required.resource.url) },
    signature: "0x",
  };
  const td = swapTypedData(opts.chain.id, extra.permit2, extra.settlement, unsigned);
  const signature = await opts.account.signTypedData(td);
  const pp: PaymentPayload = {
    x402Version: X402_VERSION,
    resource: required.resource,
    accepted: req,
    payload: { ...unsigned, signature },
  };
  return pp;
}

/**
 * Approve Permit2 to move `token` for this wallet.
 *
 * Default (no `amount`): one-time unlimited approval, made only if there is none yet.
 * Capped (`amount` set): approves `amount` (at least `needed`), and approves again only
 * when the remaining allowance can't cover `needed`. Payments still need a fresh signature
 * each time; the cap limits what Permit2 could ever move without a new on-chain approval.
 *
 * If the wallet has no ETH for gas, asks the facilitator to sponsor a tiny top-up first.
 * The facilitator sponsors a wallet's first approval only.
 */
export async function ensurePermit2Approval(params: {
  wallet: WalletClient;
  publicClient: PublicClient;
  token: Address;
  permit2: Address;
  facilitator?: string;
  /** Approve this many token units instead of unlimited. */
  amount?: bigint;
  /** Token units the next payment needs. With `amount`, re-approves when the allowance is below this. */
  needed?: bigint;
}) {
  const { wallet, publicClient: pc, token, permit2, facilitator, amount } = params;
  const needed = params.needed ?? 1n;
  const owner = wallet.account!.address;
  const allowance = await pc.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, permit2] });
  if (amount === undefined ? allowance > 0n : allowance >= needed) return null;
  const approveAmount = amount === undefined ? maxUint256 : amount > needed ? amount : needed;

  const eth = await pc.getBalance({ address: owner });
  if (eth === 0n && allowance > 0n) {
    throw new Error("the capped token approval is used up and this wallet has no ETH for gas to renew it; send it a little ETH on Robinhood Chain");
  }
  if (eth === 0n && facilitator) {
    const r = (await (
      await fetch(`${facilitator}/sponsor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payer: owner, token }),
      })
    ).json()) as { ok: boolean; transaction?: Hex; error?: string };
    if (!r.ok) throw new Error(`gas sponsorship refused: ${r.error}`);
    await pc.waitForTransactionReceipt({ hash: r.transaction! });
  }
  const hash = await wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [permit2, approveAmount],
    account: wallet.account!,
    chain: wallet.chain,
  });
  await pc.waitForTransactionReceipt({ hash });
  return hash;
}
