import type { NextFunction, Request, Response } from "express";
import type { Address } from "viem";
import {
  HEADER_PAYMENT,
  HEADER_PAYMENT_V1,
  HEADER_REQUIRED,
  HEADER_RESPONSE,
  ROBINHOOD,
  SCHEME_EXACT,
  SCHEME_SWAP,
  X402_VERSION,
  decodeHeader,
  encodeHeader,
  usd,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type ResourceInfo,
  type SettleResponse,
  type VerifyResponse,
} from "./protocol.ts";

export interface RouteConfig {
  price: string; // "$0.05"
  description?: string;
  mimeType?: string;
}

export interface TenderPaywallOptions {
  payTo: Address;
  facilitator: string; // e.g. https://facilitator.paywithtender.com
  routes: Record<string, RouteConfig>; // "GET /premium"
  /** Public base URL of this API, e.g. https://api.example.com (defaults to the request's host). */
  baseUrl?: string;
  chainId?: number;
  usdg?: Address;
  usdgName?: string;
  usdgVersion?: string;
  maxTimeoutSeconds?: number;
  /** Also offer plain USDG through the standard `exact` scheme (default true). */
  acceptUsdg?: boolean;
}

/**
 * Express middleware: 402s unpaid requests, accepts USDG directly or any token via Tender,
 * and settles before the handler runs.
 */
export function tenderPaywall(opts: TenderPaywallOptions) {
  const chainId = opts.chainId ?? ROBINHOOD.chainId;
  const network = `eip155:${chainId}`;
  const usdg = opts.usdg ?? ROBINHOOD.usdg;
  let supported: Promise<{ settlement: Address; permit2: Address; exact: boolean }> | null = null;

  const loadSupported = () =>
    (supported ??= fetch(`${opts.facilitator}/supported`)
      .then((r) => r.json())
      .then((s: any) => {
        const k = s.kinds.find((k: any) => k.scheme === SCHEME_SWAP && k.network === network);
        if (!k) throw new Error("facilitator does not support tender-swap on this network");
        const exact = s.kinds.some((k: any) => k.scheme === SCHEME_EXACT && k.network === network);
        return { settlement: k.extra.settlement, permit2: k.extra.permit2, exact };
      })
      .catch((e) => {
        supported = null;
        throw e;
      }));

  return async (req: Request, res: Response, next: NextFunction) => {
    const route = opts.routes[`${req.method} ${req.path}`];
    if (!route) return next();

    try {
      const { settlement, permit2, exact } = await loadSupported();
      const resource: ResourceInfo = {
        url: `${opts.baseUrl ?? `${req.protocol}://${req.get("host")}`}${req.path}`,
        description: route.description,
        mimeType: route.mimeType ?? "application/json",
      };
      const base = {
        network,
        amount: usd(route.price),
        asset: usdg,
        payTo: opts.payTo,
        maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 120,
      };
      const accepts: PaymentRequirements[] = [];
      if (opts.acceptUsdg !== false && exact) {
        accepts.push({
          ...base,
          scheme: SCHEME_EXACT,
          extra: { name: opts.usdgName ?? ROBINHOOD.usdgDomain.name, version: opts.usdgVersion ?? ROBINHOOD.usdgDomain.version },
        });
      }
      accepts.push({ ...base, scheme: SCHEME_SWAP, extra: { facilitator: opts.facilitator, settlement, permit2 } });

      const header = req.get(HEADER_PAYMENT) ?? req.get(HEADER_PAYMENT_V1);
      if (!header) return send402(res, { x402Version: X402_VERSION, resource, accepts });

      const pp = decodeHeader<PaymentPayload>(header);
      const match = accepts.find((a) => a.scheme === pp.accepted?.scheme);
      if (!match) return send402(res, { x402Version: X402_VERSION, error: "unsupported_scheme", resource, accepts });
      pp.resource = resource; // the merchant decides which resource is being paid for

      const body = JSON.stringify({ paymentPayload: pp, paymentRequirements: match });
      const post = (p: string) =>
        fetch(`${opts.facilitator}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body }).then(
          (r) => r.json()
        );

      const v = (await post("/verify")) as VerifyResponse;
      if (!v.isValid) return send402(res, { x402Version: X402_VERSION, error: v.invalidReason, resource, accepts });

      const s = (await post("/settle")) as SettleResponse;
      if (!s.success) return send402(res, { x402Version: X402_VERSION, error: s.errorReason, resource, accepts });

      res.setHeader(HEADER_RESPONSE, encodeHeader(s));
      res.setHeader("access-control-expose-headers", `${HEADER_RESPONSE}, ${HEADER_REQUIRED}`);
      (req as any).tenderPayment = s;
      next();
    } catch (e) {
      next(e);
    }
  };
}

function send402(res: Response, body: PaymentRequired) {
  res.setHeader(HEADER_REQUIRED, encodeHeader(body));
  res.status(402).json(body);
}
