import express from "express";
import fs from "node:fs";
import path from "node:path";
import { isAddress, parseEventLogs, type Address, type Hex } from "viem";
import { erc20Abi, tenderSettlementAbi } from "@tender/sdk/src/abi.ts";
import {
  SCHEME_EXACT,
  SCHEME_SWAP,
  X402_VERSION,
  type ExactPayload,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type SwapPayload,
} from "@tender/sdk/src/protocol.ts";
import { loadConfig, type Config } from "./config.ts";
import { MockAdapter } from "./adapters/mock.ts";
import { UniswapAdapter } from "./adapters/uniswap.ts";
import { settleExact, verifyExact } from "./schemes/exact.ts";
import { SwapScheme } from "./schemes/swap.ts";
import { mountPaidApi } from "./demo.ts";
import { mountBadge } from "./badge.ts";

// ------------------------------------------------------------------ small persistent store

class Store {
  private file: string;
  data: { feed: any[]; sponsored: Record<string, number>; totals: { payments: number; usdg: string; fees: string } };
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "state.json");
    this.data = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : { feed: [], sponsored: {}, totals: { payments: 0, usdg: "0", fees: "0" } };
  }
  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}

/** One settlement at a time, so the relayer's nonces never collide. */
class Queue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

export function createApp(cfg: Config) {
  const adapter = cfg.adapter === "mock" ? new MockAdapter(cfg) : new UniswapAdapter(cfg);
  const swap = new SwapScheme(cfg, adapter);
  const store = new Store(cfg.dataDir);
  const queue = new Queue();
  const inflight = new Map<string, Promise<SettleResponse>>(); // idempotency by signature
  const symbols = new Map<string, string>();

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use((_req, res, next) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, payment-signature, x-payment");
    res.setHeader("access-control-expose-headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
    next();
  });

  const parse = (body: any) => {
    const pp = body?.paymentPayload as PaymentPayload;
    const req = body?.paymentRequirements as PaymentRequirements;
    if (!pp?.payload || !req?.scheme) throw new Error("paymentPayload and paymentRequirements are required");
    if (req.network !== cfg.network) throw new Error(`unsupported network ${req.network}`);
    return { pp, req };
  };

  app.get("/supported", (_req, res) => {
    res.json({
      kinds: [
        ...(cfg.exactEnabled ? [{ x402Version: X402_VERSION, scheme: SCHEME_EXACT, network: cfg.network }] : []),
        {
          x402Version: X402_VERSION,
          scheme: SCHEME_SWAP,
          network: cfg.network,
          extra: { settlement: cfg.settlement, permit2: cfg.permit2, adapter: adapter.name },
        },
      ],
      signers: { [cfg.network]: [cfg.account.address] },
    });
  });

  app.post("/quote", async (req, res) => {
    try {
      const { tokenIn, amount } = req.body ?? {};
      if (!isAddress(tokenIn)) throw new Error("tokenIn must be an address");
      res.json(await swap.quote(tokenIn, BigInt(amount)));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/verify", async (req, res) => {
    try {
      const { pp, req: r } = parse(req.body);
      const out =
        r.scheme === SCHEME_EXACT && cfg.exactEnabled
          ? await verifyExact(cfg, pp as PaymentPayload<ExactPayload>, r)
          : r.scheme === SCHEME_SWAP
          ? await swap.verify(pp as PaymentPayload<SwapPayload>, r)
          : { isValid: false, invalidReason: "unsupported_scheme" };
      const { built: _built, ...publicOut } = out as any;
      res.json(publicOut);
    } catch (e: any) {
      res.status(400).json({ isValid: false, invalidReason: e.message });
    }
  });

  app.post("/settle", async (req, res) => {
    let parsed;
    try {
      parsed = parse(req.body);
    } catch (e: any) {
      return res.status(400).json({ success: false, errorReason: e.message, transaction: "", network: cfg.network });
    }
    const { pp, req: r } = parsed;
    const key = (pp.payload as any).signature as string;
    if (!inflight.has(key)) {
      inflight.set(
        key,
        queue.run(async () => {
          try {
            if (r.scheme === SCHEME_EXACT) {
              if (!cfg.exactEnabled) return fail("exact_scheme_disabled");
              const v = await verifyExact(cfg, pp as PaymentPayload<ExactPayload>, r);
              if (!v.isValid) return fail(v.invalidReason!, v.payer);
              return await settleExact(cfg, pp as PaymentPayload<ExactPayload>);
            }
            if (r.scheme === SCHEME_SWAP) {
              const out = await swap.settle(pp as PaymentPayload<SwapPayload>, r);
              if (out.success) await record(out.transaction as Hex);
              return out;
            }
            return fail("unsupported_scheme");
          } catch (e: any) {
            return fail(e.shortMessage ?? e.message);
          }
        })
      );
      setTimeout(() => inflight.delete(key), 10 * 60_000);
    }
    res.json(await inflight.get(key));
  });

  /** One-time ETH top-up so a payer can approve Permit2 for a token. */
  app.post("/sponsor", async (req, res) => {
    try {
      if (!cfg.sponsor.enabled) throw new Error("sponsorship is off");
      const { payer, token } = req.body ?? {};
      if (!isAddress(payer) || !isAddress(token)) throw new Error("payer and token must be addresses");
      const key = payer.toLowerCase();
      if (store.data.sponsored[key]) throw new Error("already sponsored");
      const today = Math.floor(Date.now() / 86_400_000);
      const usedToday = Object.values(store.data.sponsored).filter((d) => d === today).length;
      if (usedToday >= cfg.sponsor.dailyMax) throw new Error("daily sponsorship limit reached");

      const c = cfg.publicClient;
      const [eth, bal, allowance] = await Promise.all([
        c.getBalance({ address: payer }),
        c.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [payer] }),
        c.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [payer, cfg.permit2] }),
      ]);
      if (bal === 0n) throw new Error("payer holds none of this token");
      if (allowance > 0n) throw new Error("already approved");
      // enough for one approve at today's gas price (wallets budget ~2x the max fee)
      const fees = await c.estimateFeesPerGas();
      const need = cfg.sponsor.approveGas * (fees.maxFeePerGas ?? fees.gasPrice ?? 0n) * 2n;
      if (need > cfg.sponsor.maxWei) throw new Error("gas too expensive to sponsor right now");
      if (eth >= need) throw new Error("payer already has gas");
      await swap.quote(token, 1_000_000n); // token must be one we can actually route

      store.data.sponsored[key] = today;
      store.save();
      const hash = await queue.run(() =>
        cfg.walletClient.sendTransaction({ to: payer, value: need - eth })
      );
      res.json({ ok: true, transaction: hash });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get("/feed", (_req, res) => res.json({ totals: store.data.totals, recent: store.data.feed.slice(0, 50) }));
  if (process.env.PAID_API !== "false") mountPaidApi(app, cfg, adapter);
  mountBadge(app, cfg, adapter);

  app.get("/healthz", (_req, res) => res.json({ ok: true, relayer: cfg.account.address, network: cfg.network }));

  function fail(errorReason: string, payer?: Address): SettleResponse {
    return { success: false, errorReason, transaction: "", network: cfg.network, payer };
  }

  async function symbol(token: Address) {
    if (!symbols.has(token)) {
      const s = await cfg.publicClient
        .readContract({ address: token, abi: erc20Abi, functionName: "symbol" })
        .catch(() => "???");
      symbols.set(token, s);
    }
    return symbols.get(token)!;
  }

  async function decimals(token: Address) {
    return cfg.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch(() => 18);
  }

  async function record(hash: Hex) {
    if (store.data.feed.some((e: any) => e.tx === hash)) return;
    const receipt = await cfg.publicClient.getTransactionReceipt({ hash });
    const [ev] = parseEventLogs({ abi: tenderSettlementAbi, logs: receipt.logs, eventName: "Settled" });
    if (!ev) return;
    const a = ev.args;
    const block = await cfg.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    store.data.feed.unshift({
      time: Number(block.timestamp) * 1000,
      tx: hash,
      decimals: Number(await decimals(a.tokenIn)),
      payer: a.payer,
      merchant: a.merchant,
      token: a.tokenIn,
      symbol: await symbol(a.tokenIn),
      amountIn: a.amountIn.toString(),
      usdg: a.amountOut.toString(),
      fee: a.fee.toString(),
    });
    store.data.feed.sort((x: any, y: any) => y.time - x.time);
    store.data.feed = store.data.feed.slice(0, 500);
    const t = store.data.totals;
    t.payments += 1;
    t.usdg = (BigInt(t.usdg) + a.amountOut).toString();
    t.fees = (BigInt(t.fees) + a.fee).toString();
    store.save();
  }

  /** Rebuild the feed from the contract's on-chain Settled events, so history survives restarts and new servers. */
  async function backfill() {
    const from = BigInt(process.env.FEED_FROM_BLOCK ?? "120800000");
    const latest = await cfg.publicClient.getBlockNumber();
    const step = 50_000n;
    const event = tenderSettlementAbi.find((x: any) => x.type === "event" && x.name === "Settled") as any;
    let found = 0;
    for (let start = from; start <= latest; start += step) {
      const end = start + step - 1n > latest ? latest : start + step - 1n;
      const logs = await cfg.publicClient.getLogs({ address: cfg.settlement, event, fromBlock: start, toBlock: end });
      for (const l of logs) {
        if (!store.data.feed.some((e: any) => e.tx === l.transactionHash)) {
          await record(l.transactionHash as Hex);
          found++;
        }
      }
    }
    if (found) console.log(`feed: backfilled ${found} payment(s) from chain`);
  }
  if (process.env.FEED_BACKFILL !== "false") backfill().catch((e) => console.error("feed backfill failed:", e.shortMessage ?? e.message));

  return app;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const cfg = loadConfig();
  createApp(cfg).listen(cfg.port, () =>
    console.log(`Tender facilitator on :${cfg.port} — ${cfg.network}, relayer ${cfg.account.address}`)
  );
}
