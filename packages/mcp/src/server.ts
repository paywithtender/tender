import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  HEADER_PAYMENT,
  HEADER_REQUIRED,
  HEADER_RESPONSE,
  ROBINHOOD,
  SCHEME_SWAP,
  buildPayment,
  decodeHeader,
  encodeHeader,
  ensurePermit2Approval,
  type PaymentRequired,
  type SettleResponse,
  type SwapQuote,
} from "@paywithtender/sdk";

export const VERSION = "0.1.3";

export interface TenderMcpConfig {
  /** Agent wallet key. Without it, only the read-only tools work. */
  privateKey?: Hex;
  /** Default token to pay with. Omit to pay in USDG. */
  payWith?: Address;
  chainId: number;
  rpcUrl: string;
  facilitator: string;
  usdg: Address;
  permit2: Address;
  /** Spending limits, in USDG atomic units (6 decimals). */
  maxPerCall: bigint;
  maxFeePerCall: bigint;
  dailyLimit: bigint;
  /** File that keeps today's spending per wallet, so restarts don't reset the daily limit. Unset = memory only. */
  stateFile?: string;
  /** Allow paying plain-http URLs (local testing only). */
  allowHttp: boolean;
  explorer?: string;
  /**
   * Token approval to Permit2, in days of `dailyLimit`. The agent approves only enough of its
   * token for this many days of maximum spending, and renews when it runs low. 0 = unlimited.
   */
  approvalDays?: number;
}

const USD = 1_000_000n;

function usdUnits(v: string | undefined, fallback: string): bigint {
  const s = (v ?? fallback).replace("$", "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not a dollar amount: ${v}`);
  const [w, f = ""] = s.split(".");
  return BigInt(w) * USD + BigInt((f + "000000").slice(0, 6));
}

function approvalDaysFromEnv(v: string | undefined): number {
  const s = (v ?? "7").trim().toLowerCase();
  if (s === "unlimited" || s === "0") return 0;
  if (!/^\d+$/.test(s) || Number(s) > 365) throw new Error("TENDER_APPROVAL_DAYS must be a whole number of days (1-365), or 'unlimited'");
  return Number(s);
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): TenderMcpConfig {
  const key = env.TENDER_PRIVATE_KEY?.trim();
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("TENDER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
  const payWith = env.TENDER_PAY_WITH?.trim();
  if (payWith && !isAddress(payWith)) throw new Error("TENDER_PAY_WITH must be a token address");
  const chainId = Number(env.TENDER_CHAIN_ID ?? ROBINHOOD.chainId);
  return {
    privateKey: key as Hex | undefined,
    payWith: payWith ? getAddress(payWith) : undefined,
    chainId,
    rpcUrl: env.TENDER_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
    facilitator: (env.TENDER_FACILITATOR ?? "https://facilitator.paywithtender.com").replace(/\/$/, ""),
    usdg: getAddress(env.TENDER_USDG ?? ROBINHOOD.usdg),
    permit2: getAddress(env.TENDER_PERMIT2 ?? ROBINHOOD.permit2),
    maxPerCall: usdUnits(env.TENDER_MAX_PER_CALL_USD, "1"),
    maxFeePerCall: usdUnits(env.TENDER_MAX_FEE_USD, "0.10"),
    dailyLimit: usdUnits(env.TENDER_DAILY_LIMIT_USD, "10"),
    approvalDays: approvalDaysFromEnv(env.TENDER_APPROVAL_DAYS),
    allowHttp: env.TENDER_ALLOW_HTTP === "true",
    stateFile: env.TENDER_STATE_FILE === "none" ? undefined : env.TENDER_STATE_FILE || path.join(os.homedir(), ".tender", "spend.json"),
    explorer: chainId === ROBINHOOD.chainId ? "https://robinhoodchain.blockscout.com" : undefined,
  };
}

/** Human-friendly amount: whole numbers for big values, a few significant digits for small ones. */
function amt(raw: bigint, decimals: number): string {
  const n = Number(formatUnits(raw, decimals));
  if (n === 0) return "0";
  if (n >= 1000) return Math.round(n).toLocaleString("en-US");
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return Number(n.toPrecision(4)).toString();
}
const money = (units: bigint) => {
  const n = Number(formatUnits(units, 6));
  return "$" + (n >= 1 ? n.toFixed(2) : Number(n.toPrecision(3)).toString());
};
const text = (t: string, structured?: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: t }],
  ...(structured ? { structuredContent: structured } : {}),
});
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

export function createTenderMcp(cfg: TenderMcpConfig) {
  const chain: Chain = defineChain({
    id: cfg.chainId,
    name: cfg.chainId === ROBINHOOD.chainId ? "Robinhood Chain" : `chain ${cfg.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
  });
  const pc = createPublicClient({ chain, transport: http(cfg.rpcUrl) }) as PublicClient;
  const account: PrivateKeyAccount | undefined = cfg.privateKey ? privateKeyToAccount(cfg.privateKey) : undefined;
  const wallet = account ? createWalletClient({ chain, transport: http(cfg.rpcUrl), account }) : undefined;

  // Today's spending, per wallet and UTC day. Kept in cfg.stateFile so restarting the server (or the AI app)
  // can't hand the agent a fresh day's budget, and several server processes share one running total.
  const today = () => new Date().toISOString().slice(0, 10);
  const ledgerKey = account ? `${cfg.chainId}:${account.address.toLowerCase()}` : "";
  let memDay = today();
  let memSpent = 0n;
  function readLedger(): Record<string, { day: string; spent: string }> {
    try {
      return JSON.parse(fs.readFileSync(cfg.stateFile!, "utf8"));
    } catch (e: any) {
      if (e.code === "ENOENT") return {};
      throw new Error(`can't read the spending record at ${cfg.stateFile}: ${e.message}`);
    }
  }
  const spent = (): bigint => {
    const d = today();
    if (!cfg.stateFile) {
      if (d !== memDay) [memDay, memSpent] = [d, 0n];
      return memSpent;
    }
    const e = readLedger()[ledgerKey];
    return e && e.day === d ? BigInt(e.spent) : 0n;
  };
  function addSpent(delta: bigint) {
    const d = today();
    if (!cfg.stateFile) {
      if (d !== memDay) [memDay, memSpent] = [d, 0n];
      memSpent = memSpent + delta < 0n ? 0n : memSpent + delta;
      return;
    }
    const all = readLedger();
    const cur = all[ledgerKey]?.day === d ? BigInt(all[ledgerKey].spent) : 0n;
    const next = cur + delta < 0n ? 0n : cur + delta;
    all[ledgerKey] = { day: d, spent: next.toString() };
    fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true, mode: 0o700 });
    const tmp = `${cfg.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, cfg.stateFile);
  }

  const tokenCache = new Map<string, { symbol: string; name: string; decimals: number }>();
  async function token(addr: Address) {
    const k = addr.toLowerCase();
    if (tokenCache.has(k)) return tokenCache.get(k)!;
    const code = await pc.getCode({ address: addr });
    if (!code || code === "0x") throw new Error(`no token contract at ${addr}`);
    const [symbol, name, decimals] = await Promise.all([
      pc.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
      pc.readContract({ address: addr, abi: erc20Abi, functionName: "name" }).catch(() => "Unknown token"),
      pc.readContract({ address: addr, abi: erc20Abi, functionName: "decimals" }),
    ]);
    const info = { symbol, name, decimals: Number(decimals) };
    tokenCache.set(k, info);
    return info;
  }

  async function quote(tokenIn: Address, amount: bigint): Promise<{ ok: true; q: SwapQuote } | { ok: false; reason: string }> {
    const r = await fetch(`${cfg.facilitator}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tokenIn, amount: amount.toString() }),
    });
    const j = (await r.json()) as SwapQuote & { error?: string };
    return r.ok ? { ok: true, q: j } : { ok: false, reason: j.error ?? `HTTP ${r.status}` };
  }
  const noRoute = (reason: string) => /noroute|no route|liquidity/i.test(reason);

  const server = new McpServer(
    { name: "tender", version: VERSION },
    {
      instructions:
        "Tender lets you pay x402 APIs on Robinhood Chain with any token the wallet holds; the API always receives exact USDG. " +
        "Use check_coin to see if a token is spendable, quote to price a payment, wallet to see balances and limits, and pay to call a paid API. " +
        "pay only spends when the API answers 402 Payment Required, and never above the configured limits.",
    }
  );

  // ------------------------------------------------------------------ check_coin
  server.registerTool(
    "check_coin",
    {
      title: "Check if a coin is spendable",
      description:
        "Checks whether a Robinhood Chain token can be used to pay on Tender (it needs a Uniswap route to USDG), and what paying $1.00 costs in it.",
      inputSchema: { token: z.string().describe("Token contract address (0x…)") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ token: t }) => {
      if (!isAddress(t)) return fail("That isn't a token address.");
      const addr = getAddress(t);
      let info;
      try {
        info = await token(addr);
      } catch (e: any) {
        return fail(e.message);
      }
      const r = await quote(addr, USD);
      if (!r.ok) {
        if (noRoute(r.reason)) {
          return text(
            `${info.symbol} (${info.name}) is not spendable on Tender yet: there is no Uniswap pool deep enough to swap it into USDG. Pons coins become spendable automatically when they graduate.`,
            { token: addr, symbol: info.symbol, spendable: false, reason: "no_route" }
          );
        }
        return fail(`Couldn't get a quote: ${r.reason}`);
      }
      const q = r.q;
      const amountIn = formatUnits(BigInt(q.estimatedAmountIn), info.decimals);
      const shown = amt(BigInt(q.estimatedAmountIn), info.decimals);
      const protocol = BigInt(q.feeBreakdown.protocol);
      const gas = BigInt(q.feeBreakdown.gas);
      return text(
        `${info.symbol} (${info.name}) is spendable on Tender. Paying a $1.00 API costs about ${shown} ${info.symbol}: ` +
          `Tender fee ${protocol === 0n ? "none" : money(protocol)}, network gas ${money(gas)}` +
          (q.priceImpact ? `, swap price impact ${(q.priceImpact * 100).toFixed(2)}%` : "") +
          ". The API receives exactly $1.00 USDG.",
        {
          token: addr,
          symbol: info.symbol,
          spendable: true,
          costFor1Usd: amountIn,
          tenderFeeUsd: formatUnits(protocol, 6),
          gasFeeUsd: formatUnits(gas, 6),
          priceImpact: q.priceImpact ?? 0,
        }
      );
    }
  );

  // ------------------------------------------------------------------ quote
  server.registerTool(
    "quote",
    {
      title: "Quote a payment",
      description: "Prices a payment of a given USD amount in a given token (default: the configured pay-with token, or USDG).",
      inputSchema: {
        usd: z.string().describe('Amount the API should receive, in dollars, e.g. "0.05"'),
        token: z.string().optional().describe("Token to pay with (0x…). Omit for the default."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ usd, token: t }) => {
      let amount: bigint;
      try {
        amount = usdUnits(usd, "0");
      } catch (e: any) {
        return fail(e.message);
      }
      if (amount === 0n) return fail("Amount must be above zero.");
      const addr = t ? (isAddress(t) ? getAddress(t) : null) : (cfg.payWith ?? cfg.usdg);
      if (!addr) return fail("That isn't a token address.");
      let info;
      try {
        info = await token(addr);
      } catch (e: any) {
        return fail(e.message);
      }
      const r = await quote(addr, amount);
      if (!r.ok) return fail(noRoute(r.reason) ? `${info.symbol} isn't spendable on Tender yet (no Uniswap route to USDG).` : `Couldn't get a quote: ${r.reason}`);
      const q = r.q;
      return text(
        `To pay ${money(amount)} in ${info.symbol}: about ${amt(BigInt(q.estimatedAmountIn), info.decimals)} ${info.symbol} ` +
          `(at most ${amt(BigInt(q.maxAmountIn), info.decimals)} with slippage). Fees: Tender ${money(BigInt(q.feeBreakdown.protocol))}, gas ${money(BigInt(q.feeBreakdown.gas))}.`,
        {
          token: addr,
          symbol: info.symbol,
          usd: formatUnits(amount, 6),
          estimatedAmountIn: formatUnits(BigInt(q.estimatedAmountIn), info.decimals),
          maxAmountIn: formatUnits(BigInt(q.maxAmountIn), info.decimals),
          tenderFeeUsd: formatUnits(BigInt(q.feeBreakdown.protocol), 6),
          gasFeeUsd: formatUnits(BigInt(q.feeBreakdown.gas), 6),
        }
      );
    }
  );

  // ------------------------------------------------------------------ wallet
  server.registerTool(
    "wallet",
    {
      title: "Agent wallet and limits",
      description: "Shows the agent wallet address, its ETH, USDG and pay-with token balances, and the spending limits left today.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (!account) return fail("No wallet configured. Set TENDER_PRIVATE_KEY to let this agent pay.");
      const [eth, usdgBal] = await Promise.all([
        pc.getBalance({ address: account.address }),
        pc.readContract({ address: cfg.usdg, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
      ]);
      const lines = [`Address: ${account.address}`, `ETH: ${amt(eth, 18)}`, `USDG: ${amt(usdgBal, 6)}`];
      const structured: Record<string, unknown> = { address: account.address, eth: formatUnits(eth, 18), usdg: formatUnits(usdgBal, 6) };
      if (cfg.payWith && cfg.payWith.toLowerCase() !== cfg.usdg.toLowerCase()) {
        const info = await token(cfg.payWith);
        const [bal, allowance] = await Promise.all([
          pc.readContract({ address: cfg.payWith, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
          pc.readContract({ address: cfg.payWith, abi: erc20Abi, functionName: "allowance", args: [account.address, cfg.permit2] }),
        ]);
        lines.push(`Pays with ${info.symbol}: ${amt(bal, info.decimals)} (${allowance > 0n ? "approved" : "approval happens on first payment"}${(cfg.approvalDays ?? 7) === 0 ? ", unlimited" : `, capped at ${cfg.approvalDays ?? 7} days of the daily limit`})`);
        Object.assign(structured, { payWith: info.symbol, payWithBalance: formatUnits(bal, info.decimals) });
      } else {
        lines.push("Pays with: USDG");
      }
      const left = cfg.dailyLimit - spent();
      lines.push(`Limits: ${money(cfg.maxPerCall)} per call, ${money(cfg.maxFeePerCall)} max fee, ${money(left < 0n ? 0n : left)} of ${money(cfg.dailyLimit)} left today`);
      Object.assign(structured, { spentTodayUsd: formatUnits(spent(), 6), dailyLimitUsd: formatUnits(cfg.dailyLimit, 6) });
      return text(lines.join("\n"), structured);
    }
  );

  // ------------------------------------------------------------------ pay
  server.registerTool(
    "pay",
    {
      title: "Call a paid API",
      description:
        "Calls an x402 API. If it answers 402 Payment Required with a Tender option, pays with the agent's token (swapped to USDG on Uniswap in the same transaction) and returns the API's response. " +
        "Free endpoints are just fetched. Refuses anything above the configured per-call, fee or daily limits.",
      inputSchema: {
        url: z.string().describe("Full URL of the API endpoint"),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().describe("HTTP method, default GET"),
        body: z.string().optional().describe("Request body (sent as-is; set content-type in headers if needed)"),
        headers: z.record(z.string(), z.string()).optional().describe("Extra request headers"),
        pay_with: z.string().optional().describe("Token to pay with for this call (0x…). Omit for the default."),
        max_usd: z.string().optional().describe("Refuse if the API's price is above this many dollars (lower than the configured limit)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ url, method, body, headers, pay_with, max_usd }) => {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        return fail("That isn't a valid URL.");
      }
      if (target.protocol !== "https:" && !(cfg.allowHttp && target.protocol === "http:")) return fail("Only https URLs can be paid.");
      if (!account || !wallet) return fail("No wallet configured. Set TENDER_PRIVATE_KEY to let this agent pay.");
      const payWith = pay_with ? (isAddress(pay_with) ? getAddress(pay_with) : null) : cfg.payWith;
      if (payWith === null) return fail("pay_with isn't a token address.");

      let cap = cfg.maxPerCall;
      if (max_usd) {
        try {
          const m = usdUnits(max_usd, "0");
          if (m < cap) cap = m;
        } catch (e: any) {
          return fail(e.message);
        }
      }

      const init: RequestInit = { method: method ?? "GET", headers: headers ?? {}, body };
      const first = await fetch(target, init);
      if (first.status !== 402) return respond(first, null);

      let required: PaymentRequired;
      try {
        const h = first.headers.get(HEADER_REQUIRED);
        required = h ? decodeHeader<PaymentRequired>(h) : ((await first.json()) as PaymentRequired);
      } catch {
        return fail("The API asked for payment but its payment details couldn't be read.");
      }
      const opt = required.accepts?.find((a) => a.scheme === SCHEME_SWAP && a.network === `eip155:${cfg.chainId}`);
      if (!opt) return fail("This API doesn't accept Tender payments on this chain.");
      const price = BigInt(opt.amount);
      if (price > cap) return fail(`The API wants ${money(price)}, above this agent's limit of ${money(cap)} per call. Nothing was paid.`);
      let used: bigint;
      try {
        used = spent();
      } catch (e: any) {
        return fail(`Couldn't check today's spending: ${e.message}. Nothing was paid.`);
      }
      if (used + price > cfg.dailyLimit) {
        return fail(`Paying ${money(price)} would pass today's limit (${money(used)} of ${money(cfg.dailyLimit)} used). Nothing was paid.`);
      }

      const tokenIn = payWith ?? cfg.usdg;
      const extra = (opt.extra ?? {}) as { facilitator?: string; permit2?: Address };

      // Sign first (no allowance needed to sign), so the approval can be sized from the real quote.
      let payload;
      try {
        payload = await buildPayment(
          pc,
          { account, chain, rpcUrl: cfg.rpcUrl, payWith: payWith ?? undefined, maxUsdgPerCall: cap, maxFeePerCall: cfg.maxFeePerCall },
          required,
          cap
        );
      } catch (e: any) {
        return fail(`Couldn't prepare the payment: ${e.message}. Nothing was paid.`);
      }

      // Permit2 payments need an approval. Capped by default: enough of this token for
      // TENDER_APPROVAL_DAYS days at the daily limit, never an unlimited allowance.
      const permit = (payload.payload as { permit?: { permitted: { amount: string } } }).permit;
      if (permit) {
        const needed = BigInt(permit.permitted.amount);
        const days = cfg.approvalDays ?? 7;
        const amount = days === 0 ? undefined : (needed * cfg.dailyLimit * BigInt(days)) / (price > 0n ? price : 1n);
        try {
          await ensurePermit2Approval({
            wallet,
            publicClient: pc,
            token: tokenIn,
            permit2: extra.permit2 ?? cfg.permit2,
            facilitator: extra.facilitator ?? cfg.facilitator,
            amount,
            needed,
          });
        } catch (e: any) {
          return fail(`Token approval failed: ${e.shortMessage ?? e.message}. Nothing was paid.`);
        }
      }
      const h = new Headers(init.headers);
      h.set(HEADER_PAYMENT, encodeHeader(payload));
      // count the payment before sending it, so parallel calls and crashes can't overspend; give it back only if it clearly failed
      try {
        addSpent(price);
      } catch (e: any) {
        return fail(`Couldn't record today's spending: ${e.message}. Nothing was paid.`);
      }
      let paid: Response;
      try {
        paid = await fetch(target, { ...init, headers: h });
      } catch (e: any) {
        return fail(`The API couldn't be reached after signing (${e.message}). The payment may or may not have settled, so ${money(price)} stays counted toward today's limit.`);
      }
      const settleHeader = paid.headers.get(HEADER_RESPONSE);
      const settle = settleHeader ? decodeHeader<SettleResponse>(settleHeader) : null;
      if ((settle && !settle.success) || (!settle && paid.status === 402)) addSpent(-price);
      return respond(paid, settle ? { ...settle, price, tokenIn } : null);
    }
  );

  async function respond(res: Response, payment: (SettleResponse & { price: bigint; tokenIn: Address }) | null) {
    const raw = await res.text();
    const shown = raw.length > 8000 ? raw.slice(0, 8000) + `\n… (${raw.length - 8000} more characters)` : raw;
    const lines = [`HTTP ${res.status}`];
    const structured: Record<string, unknown> = { status: res.status };
    if (payment?.success) {
      const sym = (await token(payment.tokenIn).catch(() => null))?.symbol ?? payment.tokenIn;
      const link = cfg.explorer && payment.transaction ? `${cfg.explorer}/tx/${payment.transaction}` : payment.transaction;
      lines.push(`Paid ${money(payment.price)} in ${sym} via Tender. Transaction: ${link}`);
      Object.assign(structured, { paid: true, priceUsd: formatUnits(payment.price, 6), paidWith: sym, transaction: payment.transaction });
    } else if (payment) {
      lines.push(`Payment did not settle: ${(payment as any).errorReason ?? "unknown reason"}`);
      structured.paid = false;
    } else if (res.status === 402) {
      lines.push("The API still asks for payment; it was refused.");
      structured.paid = false;
    }
    lines.push("", shown);
    structured.body = shown;
    return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: structured, isError: res.status >= 400 };
  }

  return { server, account };
}
