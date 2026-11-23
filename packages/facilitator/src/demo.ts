/**
 * Tender's own paid API: small, useful endpoints anyone can pay for with any token through Tender.
 * It gives agents (and the MCP server) something real to buy, and every call shows up in the live feed.
 *
 *   GET /api            free   list of endpoints and prices
 *   GET /api/gas        $0.01  Robinhood Chain gas, ETH price and what common actions cost
 *   GET /api/token      $0.01  a token's USD price and whether it's spendable on Tender (?address=0x…)
 */
import type { Express, NextFunction, Request, Response } from "express";
import { erc20Abi, formatUnits, getAddress, isAddress, parseAbi, type Address } from "viem";
import { tenderPaywall } from "@tender/sdk/src/middleware.ts";
import type { Config } from "./config.ts";
import type { SwapAdapter } from "./adapters/types.ts";

const PRICES = { gas: "$0.01", token: "$0.01" };
const treasuryAbi = parseAbi(["function treasury() view returns (address)"]);

export function mountPaidApi(app: Express, cfg: Config, adapter: SwapAdapter) {
  const publicUrl = (process.env.PUBLIC_URL ?? "https://facilitator.paywithtender.com").replace(/\/$/, "");

  // Payments go to DEMO_PAY_TO, or to the contract's treasury
  let paywall: ReturnType<typeof tenderPaywall> | null = null;
  const getPaywall = async () => {
    if (paywall) return paywall;
    const payTo = (process.env.DEMO_PAY_TO as Address) || (await cfg.publicClient.readContract({ address: cfg.settlement, abi: treasuryAbi, functionName: "treasury" }));
    paywall = tenderPaywall({
      payTo,
      facilitator: publicUrl,
      baseUrl: publicUrl,
      chainId: cfg.chain.id,
      usdg: cfg.usdg,
      routes: {
        "GET /api/gas": { price: PRICES.gas, description: "Robinhood Chain gas price, ETH price, and what common actions cost right now" },
        "GET /api/token": { price: PRICES.token, description: "A token's USD price and whether it is spendable on Tender" },
      },
    });
    return paywall;
  };
  const pay = (req: Request, res: Response, next: NextFunction) =>
    getPaywall().then((p) => p(req, res, next), next);

  // ETH price in USD, from Uniswap via WETH (cached a minute)
  let eth: { usd: number; at: number } | null = null;
  async function ethUsd(): Promise<number | null> {
    if (cfg.gas.ethUsd) return Number(cfg.gas.ethUsd);
    if (eth && Date.now() - eth.at < 60_000) return eth.usd;
    if (!cfg.gas.weth) return null;
    const q = await adapter.quote(cfg.gas.weth, 1_000_000n);
    eth = { usd: 1 / Number(formatUnits(q.amountIn, 18)), at: Date.now() };
    return eth.usd;
  }

  async function tokenInfo(address: Address) {
    const code = await cfg.publicClient.getCode({ address });
    if (!code || code === "0x") return null;
    const read = <T>(functionName: "symbol" | "name" | "decimals" | "totalSupply", fallback: T) =>
      cfg.publicClient.readContract({ address, abi: erc20Abi, functionName }).catch(() => fallback) as Promise<T>;
    const [symbol, name, decimals, totalSupply] = await Promise.all([
      read("symbol", "?"),
      read("name", "Unknown token"),
      read<number | null>("decimals", null),
      read<bigint | null>("totalSupply", null),
    ]);
    if (decimals === null) return null;
    return { symbol, name, decimals: Number(decimals), totalSupply };
  }

  // ------------------------------------------------------------------ free index
  app.get("/api", (_req, res) => {
    res.json({
      name: "Tender API",
      description: "Pay per call with any Robinhood Chain token that has a Uniswap route. Payments settle in USDG through Tender (x402).",
      endpoints: [
        { method: "GET", path: "/api/gas", price: PRICES.gas, description: "Gas price, ETH price, and the cost of common actions" },
        { method: "GET", path: "/api/token?address=0x…", price: PRICES.token, description: "Token USD price and whether it is spendable on Tender" },
      ],
      howToPay: "Call an endpoint; it answers 402 with payment options. Use @paywithtender/sdk or the @paywithtender/mcp server to pay automatically.",
      docs: "https://github.com/paywithtender/tender#readme",
    });
  });

  // ------------------------------------------------------------------ /api/gas
  app.get("/api/gas", pay, async (_req, res) => {
    try {
      const [block, gasPrice, ethPrice] = await Promise.all([cfg.publicClient.getBlockNumber(), cfg.publicClient.getGasPrice(), ethUsd().catch(() => null)]);
      const cost = (units: bigint) => (ethPrice === null ? null : Number(formatUnits(units * gasPrice, 18)) * ethPrice);
      const round = (v: number | null) => (v === null ? null : Number(v.toPrecision(3)));
      res.json({
        chain: cfg.chain.name,
        chainId: cfg.chain.id,
        block: block.toString(),
        gasPriceGwei: Number(formatUnits(gasPrice, 9)),
        ethUsd: ethPrice === null ? null : Number(ethPrice.toFixed(2)),
        costUsd: {
          ethTransfer: round(cost(21_000n)),
          tokenTransfer: round(cost(65_000n)),
          uniswapSwap: round(cost(180_000n)),
          tenderPayment: round(cost(cfg.gas.swapUnits)),
        },
        at: new Date().toISOString(),
      });
    } catch (e: any) {
      res.status(502).json({ error: "chain read failed", detail: e.shortMessage ?? e.message });
    }
  });

  // ------------------------------------------------------------------ /api/token
  // Bad input is answered before payment, so nobody pays for a typo.
  const validateToken = async (req: Request, res: Response, next: NextFunction) => {
    const a = String(req.query.address ?? "");
    if (!isAddress(a)) return res.status(400).json({ error: "pass ?address=0x… (a token contract address)" });
    try {
      const info = await tokenInfo(getAddress(a));
      if (!info) return res.status(400).json({ error: "no ERC-20 token at that address on this chain" });
      (req as any).token = { address: getAddress(a), ...info };
      next();
    } catch (e: any) {
      res.status(502).json({ error: "chain read failed", detail: e.shortMessage ?? e.message });
    }
  };

  app.get("/api/token", validateToken, pay, async (req, res) => {
    const t = (req as any).token as { address: Address; symbol: string; name: string; decimals: number; totalSupply: bigint | null };
    const base = {
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      totalSupply: t.totalSupply === null ? null : formatUnits(t.totalSupply, t.decimals),
    };
    try {
      const isUsdg = t.address.toLowerCase() === cfg.usdg.toLowerCase();
      if (isUsdg) return res.json({ ...base, priceUsd: 1, spendable: true, costFor1Usd: "1", priceImpact: 0 });
      const q = await adapter.quote(t.address, 1_000_000n);
      const perDollar = Number(formatUnits(q.amountIn, t.decimals));
      const priceUsd = 1 / perDollar;
      const supply = t.totalSupply === null ? null : Number(formatUnits(t.totalSupply, t.decimals));
      res.json({
        ...base,
        priceUsd: Number(priceUsd.toPrecision(6)),
        marketCapUsd: supply === null ? null : Math.round(supply * priceUsd),
        spendable: q.priceImpact === undefined || q.priceImpact <= cfg.maxPriceImpact,
        costFor1Usd: Number(perDollar.toPrecision(6)).toString(),
        priceImpact: q.priceImpact ?? null,
        note: "Price from a live Uniswap quote for $1 of the token; small swaps include pool fees, so it reads slightly below spot.",
      });
    } catch (e: any) {
      const msg = String(e.message ?? e);
      if (/noroute|no route|liquidity/i.test(msg)) {
        return res.json({ ...base, priceUsd: null, spendable: false, reason: "no Uniswap route to USDG yet (Pons coins become spendable when they graduate)" });
      }
      res.status(502).json({ ...base, error: "quote failed", detail: msg.slice(0, 200) });
    }
  });
}
