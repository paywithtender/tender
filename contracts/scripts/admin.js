// Owner actions. Examples:
//   ACTION=set-router ROUTER=0x... PERMIT2_MODE=false npx hardhat run scripts/admin.js --network robinhood
//   ACTION=set-relayer RELAYER=0x... ALLOWED=true      npx hardhat run scripts/admin.js --network robinhood
//   ACTION=fee-exempt TOKEN=0x... EXEMPT=true           (e.g. the Tender coin after launch)
//   ACTION=set-fee BPS=50
//   ACTION=set-max USDG=1000                            (max USDG per payment)
//   ACTION=set-max-gas USDG=1                           (max gas fee a payer can be charged)
//   ACTION=pause | ACTION=unpause
//   ACTION=status
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const read = await ethers.getContractAt("TenderSettlement", dep.TenderSettlement);
  const ownerAddr = await read.owner();
  const signer = (await ethers.getSigners()).find((x) => x.address.toLowerCase() === ownerAddr.toLowerCase());
  const tender = signer ? read.connect(signer) : read; // changes need the owner key
  const e = process.env;
  const yes = (v) => v === undefined || v === "true";
  const send = async (p) => console.log("tx", (await (await p).wait()).hash);

  switch (e.ACTION) {
    case "set-router":
      return send(tender.setRouter(e.ROUTER, yes(e.ALLOWED), e.PERMIT2_MODE === "true"));
    case "set-relayer":
      return send(tender.setRelayer(e.RELAYER, yes(e.ALLOWED)));
    case "fee-exempt":
      return send(tender.setFeeExempt(e.TOKEN, yes(e.EXEMPT)));
    case "set-fee":
      return send(tender.setFeeBps(Number(e.BPS)));
    case "set-max":
      return send(tender.setMaxAmountOut(ethers.parseUnits(e.USDG, 6)));
    case "set-max-gas":
      return send(tender.setMaxGasFee(ethers.parseUnits(e.USDG, 6)));
    case "pause":
      return send(tender.setPaused(true));
    case "unpause":
      return send(tender.setPaused(false));
    case "status":
    default:
      console.log({
        address: dep.TenderSettlement,
        owner: await tender.owner(),
        treasury: await tender.treasury(),
        feeBps: Number(await tender.feeBps()),
        maxAmountOutUSDG: ethers.formatUnits(await tender.maxAmountOut(), 6),
        maxGasFeeUSDG: ethers.formatUnits(await tender.maxGasFee(), 6),
        paused: await tender.paused(),
        relayer: `${dep.relayer} allowed=${await tender.relayers(dep.relayer)}`,
      });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
