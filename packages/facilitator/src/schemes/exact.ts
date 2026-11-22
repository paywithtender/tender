import { hexToSignature, verifyTypedData, type Address } from "viem";
import { eip3009Abi, erc20Abi } from "@tender/sdk/src/abi.ts";
import {
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  usdgDomain,
  type ExactPayload,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
} from "@tender/sdk/src/protocol.ts";
import type { Config } from "../config.ts";

/** Standard x402 `exact` scheme for USDG (EIP-3009 transferWithAuthorization). No Tender fee. */
export async function verifyExact(
  cfg: Config,
  pp: PaymentPayload<ExactPayload>,
  req: PaymentRequirements
): Promise<VerifyResponse> {
  const { authorization: a, signature } = pp.payload;
  const payer = a.from;
  const fail = (invalidReason: string): VerifyResponse => ({ isValid: false, invalidReason, payer });

  if (req.asset.toLowerCase() !== cfg.usdg.toLowerCase()) return fail("unsupported_asset");
  if (a.to.toLowerCase() !== req.payTo.toLowerCase()) return fail("invalid_exact_evm_payload_recipient_mismatch");
  if (BigInt(a.value) < BigInt(req.amount)) return fail("invalid_exact_evm_payload_authorization_value");

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (BigInt(a.validBefore) < now + 6n) return fail("invalid_exact_evm_payload_authorization_valid_before");
  if (BigInt(a.validAfter) > now) return fail("invalid_exact_evm_payload_authorization_valid_after");

  const ok = await verifyTypedData({
    address: payer,
    domain: usdgDomain(cfg.chain.id, cfg.usdg, cfg.usdgName, cfg.usdgVersion),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: a.from,
      to: a.to,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce,
    },
    signature,
  });
  if (!ok) return fail("invalid_exact_evm_payload_signature");

  const [balance, used] = await Promise.all([
    cfg.publicClient.readContract({ address: cfg.usdg, abi: erc20Abi, functionName: "balanceOf", args: [payer] }),
    cfg.publicClient.readContract({
      address: cfg.usdg,
      abi: eip3009Abi,
      functionName: "authorizationState",
      args: [payer, a.nonce],
    }),
  ]);
  if (balance < BigInt(a.value)) return fail("insufficient_funds");
  if (used) return fail("invalid_exact_evm_payload_authorization_nonce_used");

  return { isValid: true, payer };
}

export async function settleExact(cfg: Config, pp: PaymentPayload<ExactPayload>): Promise<SettleResponse> {
  const { authorization: a, signature } = pp.payload;
  const { v, r, s } = hexToSignature(signature);
  const hash = await cfg.walletClient.writeContract({
    address: cfg.usdg,
    abi: eip3009Abi,
    functionName: "transferWithAuthorization",
    args: [
      a.from as Address,
      a.to as Address,
      BigInt(a.value),
      BigInt(a.validAfter),
      BigInt(a.validBefore),
      a.nonce,
      Number(v),
      r,
      s,
    ],
  });
  const receipt = await cfg.publicClient.waitForTransactionReceipt({ hash });
  return {
    success: receipt.status === "success",
    errorReason: receipt.status === "success" ? undefined : "transaction_reverted",
    transaction: hash,
    network: cfg.network,
    payer: a.from,
  };
}
