# @paywithtender/sdk

Pay any x402 API with any token on Robinhood Chain. Merchants always receive exact USDG.

[paywithtender.com](https://paywithtender.com) · [GitHub](https://github.com/paywithtender/tender)

```bash
npm install @paywithtender/sdk viem
```

## Charge for an API (Express)

```ts
import express from "express";
import { tenderPaywall } from "@paywithtender/sdk";

const app = express();
app.use(tenderPaywall({
  payTo: "0xYourWallet",
  facilitator: "https://facilitator.paywithtender.com",
  routes: { "GET /premium": { price: "$0.25", description: "Premium data" } },
}));
app.get("/premium", (req, res) => res.json({ data: "…" }));
app.listen(3000);
```

Unpaid requests get a `402` with payment options. Paid requests are verified and settled on-chain before your handler runs.

## Pay from an agent

```ts
import { defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithTender } from "@paywithtender/sdk";

const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
});

const pay = wrapFetchWithTender(fetch, {
  account: privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`),
  chain: robinhood,
  payWith: "0xAnyLiquidToken", // leave out to pay in USDG
  maxUsdgPerCall: 1_000_000n,  // never more than $1 per call
  maxFeePerCall: 50_000n,      // skip if fees top $0.05
});

const res = await pay("https://api.example.com/premium");
```

The first time an agent pays with a token it needs one Permit2 approval. `ensurePermit2Approval` does it, and asks the facilitator to cover the gas if the wallet has no ETH:

```ts
import { ensurePermit2Approval, ROBINHOOD } from "@paywithtender/sdk";
await ensurePermit2Approval({ wallet, publicClient, token, permit2: ROBINHOOD.permit2, facilitator: "https://facilitator.paywithtender.com" });
```

## Fees

- USDG: network gas only
- Any other token: 0.5% + network gas, swapped to USDG on Uniswap in the same transaction
- Every fee is quoted before the agent signs, and capped on-chain

Settlement contract: [`0x7A93fE8C092b1929d6FFe5085b3619B9071b97C4`](https://robinhoodchain.blockscout.com/address/0x7A93fE8C092b1929d6FFe5085b3619B9071b97C4) (verified)

## License

MIT
