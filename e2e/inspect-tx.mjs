// Explains a Robinhood Chain transaction: gas, replays (incl. with the real gas price), and the node's call trace.
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const hash = process.argv[2];
const rpc = async (method, params) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json());
const tx = (await rpc("eth_getTransactionByHash", [hash])).result;
const rc = (await rpc("eth_getTransactionReceipt", [hash])).result;
if (!tx || !rc) { console.log("Transaction not found"); process.exit(1); }
console.log(`status ${rc.status === "0x1" ? "success" : "REVERTED"}  type ${tx.type}`);
console.log(`gas limit ${BigInt(tx.gas)}  used ${BigInt(rc.gasUsed)}`);
console.log(`maxFee ${tx.maxFeePerGas ? Number(BigInt(tx.maxFeePerGas)) / 1e9 : "-"} gwei  priority ${tx.maxPriorityFeePerGas ? Number(BigInt(tx.maxPriorityFeePerGas)) / 1e9 : "-"} gwei  effective ${Number(BigInt(rc.effectiveGasPrice)) / 1e9} gwei`);
const block = "0x" + (BigInt(rc.blockNumber) - 1n).toString(16);
const base = { from: tx.from, to: tx.to, data: tx.input, value: tx.value, gas: tx.gas };
const show = (label, r) => console.log(`${label}: ${r.error ? `REVERTS ${r.error.message} ${r.error.data ?? ""}` : "succeeds"}`);
show("replay, no gas price", await rpc("eth_call", [base, block]));
show("replay, real gas price", await rpc("eth_call", [{ ...base, gasPrice: rc.effectiveGasPrice }, block]));
if (tx.maxFeePerGas) show("replay, real 1559 fees", await rpc("eth_call", [{ ...base, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas }, block]));
const tr = await rpc("debug_traceTransaction", [hash, { tracer: "callTracer" }]);
if (tr.error) { console.log("trace unavailable:", tr.error.message); process.exit(0); }
const walk = (c, d = 0) => {
  const mark = c.error ? `  <-- ${c.error}${c.revertReason ? " (" + c.revertReason + ")" : ""}${c.output && c.output !== "0x" ? " out " + c.output.slice(0, 74) : ""}` : "";
  if (d < 6) console.log(`${"  ".repeat(d)}${c.type} ${c.to} ${c.input?.slice(0, 10)}${mark}`);
  (c.calls || []).forEach((x) => walk(x, d + 1));
};
walk(tr.result);
