// Tender "Try it" page: pay the $0.01 gas API from a browser wallet, in any coin.
import { createPublicClient, createWalletClient, custom, defineChain, erc20Abi, formatUnits, http, type Address, type PublicClient } from "viem";
import { buildPayment, ensurePermit2Approval } from "../../packages/sdk/src/client.ts";
import { ROBINHOOD } from "../../packages/sdk/src/protocol.ts";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const FACILITATOR = "https://facilitator.paywithtender.com";
const API = FACILITATOR + "/api/gas";
const EXPLORER = "https://robinhoodchain.blockscout.com";
const USDG = ROBINHOOD.usdg;
const PRESETS: { label: string; address: Address }[] = [
  { label: "USDG", address: USDG },
  { label: "$TENDER", address: "0xda4a075417d613ec018c8959fea6ab5ac5d5b78c" },
  { label: "WETH", address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" },
];

const chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER } },
});
const pc = createPublicClient({ chain, transport: http(RPC) }) as PublicClient;

const $ = (id: string) => document.getElementById(id)!;
const b64 = (o: unknown) => btoa(JSON.stringify(o));
const unb64 = <T,>(s: string) => JSON.parse(atob(s)) as T;
const isUsdg = (a?: string) => !!a && a.toLowerCase() === USDG.toLowerCase();
const short = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);
const fmt = (v: bigint, d: number) => Number(formatUnits(v, d)).toLocaleString("en-US", { maximumSignificantDigits: 6 });

type Coin = { address: Address; symbol: string; decimals: number; balance: bigint; need?: bigint; fee?: bigint; error?: string };
const state: { eth?: any; address?: Address; coin?: Coin; busy: boolean } = { busy: false };

function status(step: string, text: string, kind: "todo" | "on" | "done" | "err" = "on") {
  const el = $(step);
  el.dataset.state = kind;
  el.querySelector(".msg")!.textContent = text;
}
function setError(text: string) { $("err").textContent = text; }

/* ------------------------------------------------------------------ step 1: wallet */
async function connect() {
  setError("");
  const eth = (window as any).ethereum;
  if (!eth) {
    setError("No browser wallet found. Install MetaMask, Rabby or Coinbase Wallet, or open this page in your wallet app's browser.");
    return;
  }
  state.eth = eth;
  try {
    const [addr] = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
    state.address = addr;
    await ensureChain();
    status("s1", `Connected ${short(addr)} on Robinhood Chain`, "done");
    $("connect").textContent = "Connected";
    ($("connect") as HTMLButtonElement).disabled = true;
    $("coins").classList.remove("off");
    eth.on?.("accountsChanged", () => location.reload());
    eth.on?.("chainChanged", () => location.reload());
    await pick(PRESETS[0].address);
  } catch (e: any) {
    setError(e?.shortMessage || e?.message || "Wallet connection was cancelled.");
  }
}

async function ensureChain() {
  const id = parseInt(await state.eth.request({ method: "eth_chainId" }), 16);
  if (id === 4663) return;
  try {
    await state.eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1237" }] });
  } catch (e: any) {
    if (e?.code !== 4902 && !/unrecognized|not added|unknown chain/i.test(e?.message || "")) throw e;
    await state.eth.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: "0x1237", chainName: "Robinhood Chain", rpcUrls: [RPC], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: [EXPLORER] }],
    });
  }
}

/* ------------------------------------------------------------------ step 2: coin */
async function pick(address: Address) {
  if (!state.address || state.busy) return;
  setError("");
  document.querySelectorAll<HTMLButtonElement>("[data-coin]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.coin!.toLowerCase() === address.toLowerCase())));
  status("s2", "Reading your balance…", "on");
  ($("pay") as HTMLButtonElement).disabled = true;
  try {
    const [symbol, decimals, balance] = await Promise.all([
      pc.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
      pc.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
      pc.readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [state.address] }),
    ]);
    const coin: Coin = { address, symbol, decimals, balance };
    if (isUsdg(address)) {
      coin.need = 10_000n;
      coin.fee = 0n;
    } else {
      const q = await (await fetch(FACILITATOR + "/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenIn: address, amount: "10000" }) })).json();
      if (q.error) coin.error = q.error;
      else { coin.need = BigInt(q.estimatedAmountIn); coin.fee = BigInt(q.fee); }
    }
    state.coin = coin;
    renderCoin();
  } catch (e: any) {
    state.coin = undefined;
    status("s2", "That address isn't a token on Robinhood Chain.", "err");
  }
}

function renderCoin() {
  const c = state.coin!;
  $("c-sym").textContent = c.symbol;
  $("c-bal").textContent = `${fmt(c.balance, c.decimals)} ${c.symbol}`;
  if (c.error) {
    $("c-cost").textContent = "Not spendable";
    $("c-fee").textContent = "–";
    status("s2", `${c.symbol} can't be routed to USDG right now: ${c.error}`, "err");
    return;
  }
  $("c-cost").textContent = isUsdg(c.address) ? "0.01 USDG" : `≈ ${fmt(c.need!, c.decimals)} ${c.symbol}`;
  $("c-fee").textContent = isUsdg(c.address) ? "None, gas covered by Tender" : `${fmt(c.fee!, 6)} USDG incl. gas`;
  if (c.balance < c.need!) {
    status("s2", `You need about ${fmt(c.need!, c.decimals)} ${c.symbol} to pay. Pick another coin or top up.`, "err");
    return;
  }
  status("s2", `Paying with ${c.symbol}`, "done");
  ($("pay") as HTMLButtonElement).disabled = false;
}

/* ------------------------------------------------------------------ step 3: pay */
async function pay() {
  const c = state.coin;
  if (!c || !state.address || state.busy) return;
  state.busy = true;
  setError("");
  const btn = $("pay") as HTMLButtonElement;
  btn.disabled = true;
  try {
    status("s3", "Asking the API for its price…");
    const first = await fetch(API);
    if (first.status !== 402) throw new Error(`The API answered ${first.status} instead of asking for payment.`);
    const hdr = first.headers.get("PAYMENT-REQUIRED");
    const required = hdr ? unb64<any>(hdr) : await first.json();

    const wallet = createWalletClient({ account: state.address, chain, transport: custom(state.eth) });
    if (!isUsdg(c.address)) {
      status("s3", `One-time setup: approve ${c.symbol} for Permit2 in your wallet…`);
      await ensurePermit2Approval({ wallet: wallet as any, publicClient: pc, token: c.address, permit2: ROBINHOOD.permit2, facilitator: FACILITATOR });
    }

    status("s3", "Sign the payment in your wallet. It's a signature, not a transaction.");
    const account = {
      address: state.address,
      type: "local",
      signTypedData: (td: any) => wallet.signTypedData({ account: state.address!, ...td }),
    } as any;
    const payload = await buildPayment(pc, { account, chain, payWith: isUsdg(c.address) ? undefined : c.address, maxFeePerCall: 100_000n }, required, 1_000_000n);

    status("s3", "Settling on Robinhood Chain…");
    const paid = await fetch(API, { headers: { "PAYMENT-SIGNATURE": b64(payload) } });
    const body = await paid.text();
    if (!paid.ok) {
      let msg = body;
      try { const j = JSON.parse(body); msg = j.error || j.errorReason || j.message || body; } catch {}
      throw new Error(`Payment didn't go through: ${msg}`);
    }
    const resp = paid.headers.get("PAYMENT-RESPONSE");
    const receipt = resp ? unb64<any>(resp) : {};
    status("s3", "Paid. The API answered.", "done");
    showResult(JSON.parse(body), receipt.transaction as string | undefined, c);
  } catch (e: any) {
    const m = e?.shortMessage || e?.message || String(e);
    status("s3", /rejected|denied|cancel/i.test(m) ? "Cancelled in your wallet." : "Something went wrong.", "err");
    setError(/rejected|denied|cancel/i.test(m) ? "" : m);
    btn.disabled = false;
  } finally {
    state.busy = false;
  }
}

function showResult(data: any, tx: string | undefined, c: Coin) {
  $("result").hidden = false;
  $("r-coin").textContent = c.symbol;
  $("r-out").textContent = "0.01 USDG";
  $("r-json").textContent = JSON.stringify(data, null, 2);
  const a = $("r-tx") as HTMLAnchorElement;
  if (tx) { a.textContent = short(tx); a.href = `${EXPLORER}/tx/${tx}`; } else { a.textContent = "see the live feed"; a.href = "/#ledger"; }
  const share = $("r-share") as HTMLAnchorElement;
  const text = `Just paid an x402 API with ${c.symbol} on Robinhood Chain through @tenderpays. The API got exact USDG.${tx ? `\n\n${EXPLORER}/tx/${tx}` : ""}\n\npaywithtender.com/try`;
  share.href = "https://x.com/intent/post?text=" + encodeURIComponent(text);
  $("result").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ------------------------------------------------------------------ wire up */
$("connect").addEventListener("click", connect);
$("pay").addEventListener("click", pay);
document.querySelectorAll<HTMLButtonElement>("[data-coin]").forEach((b) => b.addEventListener("click", () => pick(b.dataset.coin as Address)));
$("other").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = (($("other-ca") as HTMLInputElement).value || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) { setError("That isn't a contract address. It starts with 0x and is 42 characters long."); return; }
  pick(v as Address);
});
