# @paywithtender/mcp

An MCP server that lets any AI agent pay x402 APIs on Robinhood Chain with whatever token it holds. Tender swaps the token to USDG on Uniswap inside the payment, so the API always receives the exact price, in one transaction.

Works with Claude Desktop, Claude Code, Cursor, and any other MCP client.

## Tools

| Tool | What it does |
| --- | --- |
| `check_coin` | Whether a token is spendable on Tender, and what paying $1.00 costs in it |
| `quote` | The cost and fees of paying a given dollar amount in a given token |
| `wallet` | The agent's address, balances, and the spending limits left today |
| `pay` | Calls an API. If it answers `402 Payment Required`, pays with the agent's token and returns the response |

`pay` only spends when an API asks for payment, and never above your limits.

## Setup

Add this to your MCP client's config (for Claude Desktop, `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "tender": {
      "command": "npx",
      "args": ["-y", "@paywithtender/mcp"],
      "env": {
        "TENDER_PRIVATE_KEY": "0xYOUR_AGENT_WALLET_KEY",
        "TENDER_PAY_WITH": "0xTOKEN_THE_AGENT_HOLDS",
        "TENDER_MAX_PER_CALL_USD": "0.50",
        "TENDER_DAILY_LIMIT_USD": "5"
      }
    }
  }
}
```

Use a dedicated agent wallet holding only what you're happy for the agent to spend. The key stays on your machine: payments are signed locally and only the signature is sent.

Leave out `TENDER_PRIVATE_KEY` to run read-only (`check_coin` and `quote` only).

## Settings

| Variable | Default | |
| --- | --- | --- |
| `TENDER_PRIVATE_KEY` | none | Agent wallet key. Without it the server is read-only. |
| `TENDER_PAY_WITH` | USDG | Token to pay with. Any token with a Uniswap route to USDG works. |
| `TENDER_MAX_PER_CALL_USD` | `1` | Refuse any API priced above this. |
| `TENDER_MAX_FEE_USD` | `0.10` | Refuse if Tender's fee plus gas is above this. |
| `TENDER_DAILY_LIMIT_USD` | `10` | Total the agent may spend per UTC day (resets when the server restarts). |
| `TENDER_RPC_URL` | Robinhood Chain public RPC | |
| `TENDER_FACILITATOR` | `https://facilitator.paywithtender.com` | |

## Fees

- Paying in USDG: network gas only
- Paying in any other token: 0.5% + gas
- Paying in $TENDER: gas only

The first payment with a new token needs a one-time Permit2 approval. If the agent wallet has no ETH, Tender covers the gas for it.

## Links

- Website: https://paywithtender.com
- Is your coin spendable? https://paywithtender.com/check
- Source: https://github.com/paywithtender/tender
- SDK for APIs and agents: [`@paywithtender/sdk`](https://www.npmjs.com/package/@paywithtender/sdk)
