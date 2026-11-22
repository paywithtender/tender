// Prints ETH + USDG balances on Robinhood Chain for the given addresses.
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const addrs = process.argv.slice(2);
const rpc = async (method, params) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
for (const a of addrs) {
  const eth = BigInt(await rpc("eth_getBalance", [a, "latest"]));
  const usdg = BigInt(await rpc("eth_call", [{ to: USDG, data: "0x70a08231" + a.slice(2).toLowerCase().padStart(64, "0") }, "latest"]));
  const nonce = BigInt(await rpc("eth_getTransactionCount", [a, "latest"]));
  console.log(`${a}\n   ETH  ${Number(eth) / 1e18}\n   USDG ${Number(usdg) / 1e6}\n   transactions sent ${nonce}\n`);
}
