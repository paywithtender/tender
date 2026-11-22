import { keccak256, toHex, type Address, type Hex } from "viem";

/** Robinhood Chain mainnet. */
export const ROBINHOOD = {
  chainId: 4663,
  network: "eip155:4663",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address,
  usdgDecimals: 6,
  usdgDomain: { name: "Global Dollar", version: "1" },
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
} as const;

export const X402_VERSION = 2;
export const SCHEME_EXACT = "exact";
export const SCHEME_SWAP = "tender-swap";

/** What a merchant asks for (one entry of `accepts`). */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  amount: string; // USDG atomic units
  asset: Address; // always USDG for Tender
  payTo: Address;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirements[];
}

/** Standard x402 `exact` EVM payload (EIP-3009). */
export interface ExactPayload {
  signature: Hex;
  authorization: {
    from: Address;
    to: Address;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
  };
}

/** Tender `tender-swap` payload (Permit2 witness transfer). */
export interface SwapPayload {
  payer: Address;
  permit: { permitted: { token: Address; amount: string }; nonce: string; deadline: string };
  payment: { merchant: Address; amountOut: string; fee: string; resource: Hex };
  signature: Hex;
}

export interface PaymentPayload<P = ExactPayload | SwapPayload> {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: P;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: Address;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  transaction: Hex | "";
  network: string;
  payer?: Address;
}

export interface SwapQuote {
  tokenIn: Address;
  amountOut: string; // USDG to merchant
  fee: string; // USDG to Tender: protocol part + gas part
  feeBreakdown: { protocol: string; gas: string };
  estimatedAmountIn: string;
  maxAmountIn: string; // what the payer should sign for
  priceImpact?: number;
  expiresAt: number; // unix seconds
  settlement: Address;
}

// ---------------------------------------------------------------- typed data

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const PERMIT2_WITNESS_TYPES = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Payment" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  Payment: [
    { name: "merchant", type: "address" },
    { name: "amountOut", type: "uint256" },
    { name: "fee", type: "uint256" },
    { name: "resource", type: "bytes32" },
  ],
} as const;

export function permit2Domain(chainId: number, permit2: Address) {
  return { name: "Permit2", chainId, verifyingContract: permit2 } as const;
}

export function usdgDomain(chainId: number, usdg: Address, name = "Global Dollar", version = "1") {
  return { name, version, chainId, verifyingContract: usdg } as const;
}

export function swapTypedData(chainId: number, permit2: Address, settlement: Address, p: SwapPayload) {
  return {
    domain: permit2Domain(chainId, permit2),
    types: PERMIT2_WITNESS_TYPES,
    primaryType: "PermitWitnessTransferFrom" as const,
    message: {
      permitted: { token: p.permit.permitted.token, amount: BigInt(p.permit.permitted.amount) },
      spender: settlement,
      nonce: BigInt(p.permit.nonce),
      deadline: BigInt(p.permit.deadline),
      witness: {
        merchant: p.payment.merchant,
        amountOut: BigInt(p.payment.amountOut),
        fee: BigInt(p.payment.fee),
        resource: p.payment.resource,
      },
    },
  };
}

export function resourceHash(url: string): Hex {
  return keccak256(toHex(url));
}

// ---------------------------------------------------------------- headers

export const HEADER_PAYMENT = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_V1 = "X-PAYMENT";
export const HEADER_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_RESPONSE = "PAYMENT-RESPONSE";

export function encodeHeader(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

export function decodeHeader<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
}

/** Turn "$0.05" or "0.05" into USDG atomic units. */
export function usd(price: string | number): string {
  const s = String(price).replace("$", "").trim();
  const [whole, frac = ""] = s.split(".");
  return (BigInt(whole || "0") * 10n ** 6n + BigInt((frac + "000000").slice(0, 6))).toString();
}
