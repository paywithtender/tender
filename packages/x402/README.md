# @paywithtender/x402

Accept or pay with **any token** on Robinhood Chain from Coinbase's x402 SDKs (`@x402/express`, `@x402/fetch`, `@x402/core` and friends). This package adds Tender's `tender-swap` scheme. The payer's token is swapped to USDG on Uniswap in the same transaction as the payment, and the API always receives exact USDG.

It sits next to the standard `exact` scheme. Agents holding USDG pay as usual, and agents holding ETH, $TENDER, or any Pons or Uniswap coin can now pay too.

```bash
npm install @paywithtender/x402
```

## Accept any token (API side)

```ts
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { TenderSwapServer } from "@paywithtender/x402";

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: "https://facilitator.paywithtender.com" }))
  .register("eip155:4663", new ExactEvmScheme())
  .register("eip155:4663", new TenderSwapServer());

app.use(paymentMiddleware({
  "GET /data": {
    accepts: [
      { scheme: "exact", price: "$0.01", network: "eip155:4663", payTo: "0xYourAddress" },       // USDG
      { scheme: "tender-swap", price: "$0.01", network: "eip155:4663", payTo: "0xYourAddress" }, // any token
    ],
  },
}, server));
```

You receive exactly the price in USDG either way. The swap and its fee are paid by the agent.

## Pay with any token (agent side)

```ts
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { TenderSwapClient } from "@paywithtender/x402";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`);
const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:4663", client: new TenderSwapClient({ account, payWith: "0xTokenYouHold" }) }],
});

const res = await pay("https://api.example.com/data");
```

The first payment with a new token sends a one-time Permit2 approval. If the wallet has no ETH, Tender covers the gas for it. Payments are signed locally, and your key never leaves your process.

## Fees

- **Paying in USDG** with the standard `exact` scheme through the Tender facilitator: no Tender fee, and gas is covered within daily limits.
- **Paying in any other token** with `tender-swap`: 0.5% plus network gas, quoted before the agent signs.
- **Paying in $TENDER**: gas only.

## Options

`TenderSwapServer({ facilitator?, usdg? })`: `facilitator` is where agents get quotes (default `https://facilitator.paywithtender.com`). `usdg` maps other networks, such as a local test chain, to their USDG address.

`TenderSwapClient({ account, payWith?, rpcUrl?, chain?, maxFeePerCall?, autoApprove? })`: `payWith` is the token to spend (default USDG). `maxFeePerCall` refuses a payment if Tender's fee plus gas is above it (default $0.10, in USDG units). Coinbase's client spend controls (`maxAmountPerPayment`) still apply to the USDG price.

## Links

- Site: https://paywithtender.com
- Is a token spendable? https://paywithtender.com/check
- Source: https://github.com/paywithtender/tender
- Also: [`@paywithtender/sdk`](https://www.npmjs.com/package/@paywithtender/sdk) and [`@paywithtender/mcp`](https://www.npmjs.com/package/@paywithtender/mcp)
