# Tender

**Every coin on Robinhood is money.** Tender is an x402 payment rail for Robinhood Chain that lets AI agents pay any x402 endpoint with any liquid token. The merchant always receives exact USDG.

- **Every payment covers its own gas.** The facilitator prices the gas it will spend to settle (gas units × gas price × ETH price, +20%) into each quote, and the agent signs for it. The contract caps the gas part at `maxGasFee` (1 USDG by default).
- Paying in **USDG**: Permit2 transfer, no swap. Fee = gas only.
- Paying in **any other token**: in one transaction the payer's token is pulled with a Permit2 signature, swapped on Uniswap to USDG, the merchant is paid exactly, Tender keeps **0.5% + gas**, and any unused token is refunded.
- **$TENDER** (`0xda4a075417d613ec018c8959fea6ab5ac5d5b78c`) is fee-exempt: gas only.
- The standard x402 `exact` scheme (EIP-3009 USDG) is on in production: any standard x402 client or API on Robinhood Chain can use Tender. Tender pays its gas with no fee, capped by `EXACT_DAILY_MAX` and `EXACT_PER_PAYER_DAILY_MAX`.

## Live now

| | |
|---|---|
| Website | https://paywithtender.com |
| Coin checker | https://paywithtender.com/check — is a token spendable, and what does $1 cost in it |
| Facilitator | https://facilitator.paywithtender.com (`/supported`, `/quote`, `/verify`, `/settle`, `/feed`) |
| Tender API | https://facilitator.paywithtender.com/api — paid endpoints (`/api/gas`, `/api/token?address=`), $0.01 per call, any coin |
| SDK | [`@paywithtender/sdk`](https://www.npmjs.com/package/@paywithtender/sdk) — `tenderPaywall` for APIs, `wrapFetchWithTender` for agents |
| MCP server | [`@paywithtender/mcp`](https://www.npmjs.com/package/@paywithtender/mcp) — `npx -y @paywithtender/mcp`; tools `check_coin`, `quote`, `wallet`, `pay` ([setup](packages/mcp/README.md)) |
| Contract | [`0x7A93fE8C092b1929d6FFe5085b3619B9071b97C4`](https://robinhoodchain.blockscout.com/address/0x7A93fE8C092b1929d6FFe5085b3619B9071b97C4) on Robinhood Chain (verified) |

## Use Tender with the standard x402 SDKs

Tender is a standard x402 v2 facilitator for Robinhood Chain (`eip155:4663`). APIs built with Coinbase's `@x402/*` packages can point at it as-is and get paid in USDG with the stock `exact` scheme. Tender covers the gas (within daily limits), and there is no Tender fee.

```ts
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: "https://facilitator.paywithtender.com" }))
  .register("eip155:4663", new ExactEvmScheme());

app.use(paymentMiddleware({
  "GET /weather": { accepts: [{ scheme: "exact", price: "$0.01", network: "eip155:4663", payTo: "0xYourAddress" }] },
}, server));
```

Agents using `@x402/fetch` with `ExactEvmScheme` pay these endpoints with no changes. To also accept any token (swapped to USDG on Uniswap in the same transaction), use `tenderPaywall` from `@paywithtender/sdk`. It offers both `exact` and `tender-swap`. `npm run test:x402` runs Coinbase's packages against a local Tender stack.

## Layout

| Path | What |
|---|---|
| `contracts/` | `TenderSettlement.sol`, its tests, and the deploy and admin scripts |
| `packages/facilitator/` | The facilitator server: `/supported`, `/quote`, `/verify`, `/settle`, `/sponsor`, `/feed`, plus the paid `/api` |
| `packages/sdk/` | `wrapFetchWithTender` (agents), `tenderPaywall` (merchants, Express), `ensurePermit2Approval` |
| `packages/mcp/` | `@paywithtender/mcp`, the MCP server |
| `site/` | paywithtender.com and the coin checker (`site/check/`) |
| `e2e/run.ts` | Full local run: chain, facilitator, paywalled API, agents paying in USDG and in a memecoin |
| `e2e/mcp.mts`, `e2e/api.mts` | The MCP server and the paid API, driven end to end on a local chain |

## Run the tests

```bash
npm install
cd contracts && npx hardhat test && cd ..   # 13 contract tests
npm run test:e2e                            # end-to-end checks on a local chain (incl. "fee covers real gas")
npm run test:mcp                            # MCP server tools against the local stack
npm run test:api                            # the paid /api endpoints, paid through the MCP server
```

## How a memecoin payment works

1. The agent hits a paid endpoint and gets a `402` offering `exact` (USDG) and `tender-swap`.
2. The agent asks the facilitator `/quote`: "how much RHDOGE pays 0.05 USDG?" The answer includes the fee (0.5% + gas, broken down) and a 3% slippage buffer. Agents can refuse with `maxFeePerCall`.
3. The agent signs a **Permit2 witness transfer**. The signature locks in the merchant, USDG amount, fee and resource URL, so nobody can redirect the money.
4. The merchant passes it to the facilitator, which builds the Uniswap route and simulates the whole settlement before sending it.
5. `TenderSettlement.settle` pulls the token, swaps, checks it got enough USDG, and then pays the merchant, the fee and the refund. If the output is short, everything reverts.

First-time setup per token is one `approve(Permit2)`. If the agent has no ETH, `/sponsor` sends just enough gas for that one approval (once per wallet, capped).

## Merchant integration

```ts
import express from "express";
import { tenderPaywall } from "@paywithtender/sdk";

const app = express();
app.use(tenderPaywall({
  payTo: "0xYourWallet",
  facilitator: "https://facilitator.paywithtender.com",
  routes: { "GET /premium": { price: "$0.05", description: "Premium data" } },
}));
app.get("/premium", (req, res) => res.json({ data: "…" }));
```

## Agent integration

```ts
import { wrapFetchWithTender } from "@paywithtender/sdk";
const pay = wrapFetchWithTender(fetch, {
  account,                        // viem LocalAccount
  chain: robinhood,               // chain id 4663
  payWith: "0x<memecoin>",        // omit to pay in USDG
  maxUsdgPerCall: 100_000n,       // refuse anything above $0.10
});
const res = await pay("https://api.example.com/premium");
```

## Mainnet launch checklist (in order)

1. **New wallets, unconnected to anything else:** deployer, relayer (hot, keep about $5 of ETH on it), treasury, and owner (cold).
2. **Uniswap API key** from the Uniswap developer portal, signed up under an anonymous email.
3. **Deploy:**
   ```bash
   cd contracts
   DEPLOYER_PRIVATE_KEY=0x… TREASURY_ADDRESS=0x… RELAYER_ADDRESS=0x… OWNER_ADDRESS=0x… \
     npx hardhat run scripts/deploy.js --network robinhood
   ```
   Then accept ownership from the owner wallet.
   Code is published at github.com/paywithtender.
4. **Start small:** `ACTION=set-max USDG=25 npx hardhat run scripts/admin.js --network robinhood`
5. **Allowlist the Uniswap proxy router:** `UNISWAP_API_KEY=… SETTLEMENT_ADDRESS=… TOKEN=<liquid coin> npx tsx packages/facilitator/scripts/find-router.ts`, then run the `set-router` command it prints.
6. **Run the facilitator:** copy `packages/facilitator/.env.example` to `.env`, fill it in, then `npm run facilitator` (or deploy the Dockerfile to Fly).
7. **Live smoke test:** put a demo endpoint behind `tenderPaywall` at $0.01, then pay it once in USDG and once in a liquid Pons coin. Check `/feed` and Blockscout.
8. Verify the contract on Blockscout and publish the repo from the anonymous GitHub account.

## Check these on the first mainnet run

These couldn't be tested from the build environment (no access to Robinhood's RPC or Uniswap's API there):

- **Trading API response shape:** `quote.input.amount` and the unit of `priceImpact` (assumed to be a percent) in `adapters/uniswap.ts`.
- **Contract as swapper:** that `EXACT_OUTPUT` quotes with `x-permit2-disabled: true` work with the settlement contract as `swapper`, and that the returned `swap.to` is the proxy router you allowlisted.
- **Pons V2 coins:** that coins sitting in Uniswap v4 pools with hooks get routed.
- **Gas units:** `SETTLE_GAS_SWAP` (600k) and `SETTLE_GAS_USDG` (200k) are estimates with headroom, including the L1 data part. Compare against the first real settlements and tune; the facilitator logs nothing yet, so read `gasUsed` on Blockscout.
- **USDG signing domain:** the EIP-712 name and version (`"Global Dollar"`, `"1"`); confirm via `eip712Domain()` on the USDG contract.

If the Trading API doesn't fit, add a direct Universal Router adapter next to `adapters/uniswap.ts` (same `SwapAdapter` interface) and allowlist the router with `PERMIT2_MODE=true`. The contract already supports both modes.

## Security notes

- The contract holds no funds between transactions. It approves the router only for the amount it just received, and revokes after.
- A relayer can't redirect payments, because the payer's signature fixes the merchant, amount, fee and resource. The worst case for a payer is a bad fill up to the max input they signed, which is the quote plus 3%.
- Only allowlisted relayers can call `settle`, and only allowlisted routers can be called.
- The owner can pause, change the fee (hard-capped at 1%), set the size cap, and set exemptions.
- **There has been no external audit.** Keep the per-payment cap low until it has run cleanly on mainnet.
