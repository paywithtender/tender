import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ROBINHOOD } from "@tender/sdk/src/protocol.ts";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing env ${name}`);
  return v;
}

export function loadConfig() {
  const chainId = Number(env("CHAIN_ID", String(ROBINHOOD.chainId)));
  const rpcUrl = env("RPC_URL", "https://rpc.mainnet.chain.robinhood.com");
  const chain = defineChain({
    id: chainId,
    name: chainId === ROBINHOOD.chainId ? "Robinhood Chain" : `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const account = privateKeyToAccount(env("RELAYER_PRIVATE_KEY") as Hex);

  return {
    port: Number(env("PORT", "4021")),
    chain,
    network: `eip155:${chainId}`,
    usdg: env("USDG_ADDRESS", ROBINHOOD.usdg) as Address,
    usdgName: env("USDG_EIP712_NAME", ROBINHOOD.usdgDomain.name),
    usdgVersion: env("USDG_EIP712_VERSION", ROBINHOOD.usdgDomain.version),
    permit2: env("PERMIT2_ADDRESS", ROBINHOOD.permit2) as Address,
    settlement: env("SETTLEMENT_ADDRESS") as Address,
    adapter: env("SWAP_ADAPTER", "uniswap") as "uniswap" | "mock",
    uniswapApiKey: process.env.UNISWAP_API_KEY ?? "",
    uniswapApiUrl: env("UNISWAP_API_URL", "https://trade-api.gateway.uniswap.org/v1"),
    mockRouter: (process.env.MOCK_ROUTER ?? "") as Address,
    exactEnabled: env("EXACT_ENABLED", "false") === "true", // plain EIP-3009 USDG: facilitator eats the gas
    // Standard x402 "exact" payments cost Tender gas with no fee, so cap how many it covers.
    exact: {
      dailyMax: Number(env("EXACT_DAILY_MAX", "300")), // gas-covered exact settlements per UTC day, all payers
      perPayerDailyMax: Number(env("EXACT_PER_PAYER_DAILY_MAX", "30")),
      minAmount: BigInt(env("EXACT_MIN_AMOUNT", "1000")), // $0.001 in USDG units: no dust spam on Tender's gas
    },
    gas: {
      swapUnits: BigInt(env("SETTLE_GAS_SWAP", "420000")), // gas for a swap settlement, incl. L1 data, with headroom
      usdgUnits: BigInt(env("SETTLE_GAS_USDG", "190000")),
      marginBps: Number(env("GAS_MARGIN_BPS", "2000")), // charge 20% over the estimate
      toleranceBps: Number(env("GAS_TOLERANCE_BPS", "3000")), // accept a signed gas fee down to 70% of today's price
      ethUsd: process.env.ETH_USD_PRICE ?? "", // fixed ETH price; otherwise read from Uniswap via WETH
      weth: (process.env.WETH_ADDRESS ?? "") as Address,
    },
    slippageBps: Number(env("SLIPPAGE_BPS", "300")), // slippage the swap route is built with
    signBufferBps: Number(env("SIGN_BUFFER_BPS", "1000")), // extra the payer signs for on top of the quote; unused input is refunded
    minRouteSlippageBps: Number(env("MIN_ROUTE_SLIPPAGE_BPS", "400")), // never route tighter than this (some v4 pools take a gas-price fee)
    maxPriceImpact: Number(env("MAX_PRICE_IMPACT", "0.05")), // tokens with thinner liquidity are refused
    maxPriceImpactSmall: Number(env("MAX_PRICE_IMPACT_SMALL", "0.25")), // hard ceiling, even for tiny payments
    maxImpactUsd6: BigInt(env("MAX_IMPACT_USD6", "50000")), // above MAX_PRICE_IMPACT, allow only if impact costs under $0.05
    quoteTtlSeconds: Number(env("QUOTE_TTL_SECONDS", "60")),
    denylist: new Set(
      (process.env.TOKEN_DENYLIST ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    ),
    sponsor: {
      enabled: env("SPONSOR_ENABLED", "false") === "true",
      maxWei: BigInt(env("SPONSOR_MAX_WEI", "100000000000000")), // never send more than 0.0001 ETH
      approveGas: BigInt(env("SPONSOR_APPROVE_GAS", "70000")),
      dailyMax: Number(env("SPONSOR_DAILY_MAX", "200")),
    },
    dataDir: env("DATA_DIR", "./data"),
    publicClient: createPublicClient({ chain, transport: http(rpcUrl) }),
    walletClient: createWalletClient({ chain, transport: http(rpcUrl), account }),
    account,
  };
}

export type Config = ReturnType<typeof loadConfig>;
