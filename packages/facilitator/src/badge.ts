/**
 * "Spendable on Tender" badge: a live SVG any token can embed on its site, docs or README.
 *
 *   GET /badge/:address.svg   → Spendable on Tender   (a $0.10 payment routes to USDG on Uniswap)
 *                             → Spendable at graduation (no route yet, e.g. still on a Pons curve)
 *
 * The status is checked live and cached for a few minutes, so a coin's badge flips on its own when it graduates.
 */
import type { Express } from "express";
import { erc20Abi, getAddress, isAddress, type Address } from "viem";
import type { Config } from "./config.ts";
import type { SwapAdapter } from "./adapters/types.ts";

const TTL_MS = 5 * 60_000;
type Status = { state: "spendable" | "graduation" | "invalid"; symbol: string };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Rough text width for a sans font at 13px, so the pill fits without needing fonts at render time. */
function textWidth(s: string, px = 13) {
  let w = 0;
  for (const ch of s) w += /[MW@]/.test(ch) ? 0.83 : /[A-Z$0-9]/.test(ch) ? 0.66 : /[il.,'|!]/.test(ch) ? 0.28 : /[mw]/.test(ch) ? 0.78 : 0.54;
  return Math.ceil(w * px);
}

/** The Tender rosette mark, small. */
function mark(x: number, y: number) {
  let paths = "";
  for (const a of [0, 30, 60, 90, 120, 150]) {
    paths += `<ellipse cx="${x}" cy="${y}" rx="7.2" ry="2.9" transform="rotate(${a} ${x} ${y})" fill="none" stroke="url(#tf)" stroke-width="0.9"/>`;
  }
  return paths + `<circle cx="${x}" cy="${y}" r="1.4" fill="url(#tf)"/>`;
}

export function badgeSvg(status: Status): string {
  const left = status.state === "invalid" ? "Tender" : `$${status.symbol}`.slice(0, 16);
  const right = status.state === "spendable" ? "Spendable on Tender" : status.state === "graduation" ? "Spendable at graduation" : "Not a token";
  const dot = status.state === "spendable" ? "#7CF0C5" : status.state === "graduation" ? "#FFD3A3" : "#8E9CB8";
  const h = 36;
  const leftW = 34 + textWidth(left, 13) + 12;
  const rightW = 22 + textWidth(right, 13) + 16;
  const w = leftW + rightW;
  const label = `${left}: ${right}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">
<title>${esc(label)}</title>
<defs>
  <linearGradient id="tf" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9AE6D8"/><stop offset=".5" stop-color="#B6A6FF"/><stop offset="1" stop-color="#FFD3A3"/></linearGradient>
  <clipPath id="r"><rect width="${w}" height="${h}" rx="${h / 2}"/></clipPath>
</defs>
<g clip-path="url(#r)">
  <rect width="${w}" height="${h}" fill="#0A1222"/>
  <rect width="${leftW}" height="${h}" fill="#121D33"/>
  <rect x="${leftW}" width="1" height="${h}" fill="#22304D"/>
</g>
<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="${(h - 1) / 2}" fill="none" stroke="#22304D"/>
${mark(19, h / 2)}
<g font-family="Geist, Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="13">
  <text x="34" y="${h / 2 + 4.5}" fill="#EEF1F7" font-weight="600" textLength="${textWidth(left, 13)}" lengthAdjust="spacingAndGlyphs">${esc(left)}</text>
  <circle cx="${leftW + 13}" cy="${h / 2}" r="3.5" fill="${dot}"/>
  <text x="${leftW + 22}" y="${h / 2 + 4.5}" fill="#EEF1F7" font-weight="500" textLength="${textWidth(right, 13)}" lengthAdjust="spacingAndGlyphs">${esc(right)}</text>
</g>
</svg>`;
}

export function mountBadge(app: Express, cfg: Config, adapter: SwapAdapter) {
  const cache = new Map<string, { at: number; status: Status }>();
  const inflight = new Map<string, Promise<Status>>();

  async function check(address: Address): Promise<Status> {
    const code = await cfg.publicClient.getCode({ address });
    if (!code || code === "0x") return { state: "invalid", symbol: "" };
    const symbol = await cfg.publicClient.readContract({ address, abi: erc20Abi, functionName: "symbol" }).catch(() => null);
    const decimals = await cfg.publicClient.readContract({ address, abi: erc20Abi, functionName: "decimals" }).catch(() => null);
    if (symbol === null || decimals === null) return { state: "invalid", symbol: "" };
    if (address.toLowerCase() === cfg.usdg.toLowerCase()) return { state: "spendable", symbol };
    try {
      // check at API-payment size ($0.10): most Tender payments are cents, and a thin pool can take those
      // even when a $1 swap would move the price too much. Same rule as the facilitator's quote.
      const amount = 100_000n;
      const q = await adapter.quote(address, amount);
      const impact = q.priceImpact ?? 0;
      const overhead = (amount * BigInt(Math.round(impact * 1_000_000))) / 1_000_000n;
      const ok = impact <= cfg.maxPriceImpact || (impact <= cfg.maxPriceImpactSmall && overhead <= cfg.maxImpactUsd6);
      return { state: ok ? "spendable" : "graduation", symbol };
    } catch (e: any) {
      if (/noroute|no route|liquidity/i.test(String(e.message ?? e))) return { state: "graduation", symbol };
      throw e;
    }
  }

  async function status(address: Address): Promise<Status> {
    const k = address.toLowerCase();
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.status;
    if (!inflight.has(k)) {
      inflight.set(
        k,
        check(address)
          .then((s) => {
            cache.set(k, { at: Date.now(), status: s });
            if (cache.size > 2000) cache.delete(cache.keys().next().value!);
            return s;
          })
          .finally(() => inflight.delete(k))
      );
    }
    return inflight.get(k)!;
  }

  app.get("/badge/:file", async (req, res) => {
    const raw = req.params.file.replace(/\.svg$/i, "");
    res.setHeader("content-type", "image/svg+xml; charset=utf-8");
    if (!isAddress(raw)) {
      res.setHeader("cache-control", "public, max-age=3600");
      return res.status(404).send(badgeSvg({ state: "invalid", symbol: "" }));
    }
    try {
      const s = await status(getAddress(raw));
      res.setHeader("cache-control", "public, max-age=300");
      res.send(badgeSvg(s));
    } catch {
      // keep the last known badge if a lookup fails; otherwise show nothing alarming and retry soon
      const last = cache.get(raw.toLowerCase());
      res.setHeader("cache-control", "public, max-age=60");
      res.send(badgeSvg(last?.status ?? { state: "graduation", symbol: "?" }));
    }
  });
}
