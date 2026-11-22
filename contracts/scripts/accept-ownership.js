// Run after deploy: the owner wallet accepts control of the contract.
//   npx hardhat run scripts/accept-ownership.js --network robinhood
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const tender = await ethers.getContractAt("TenderSettlement", dep.TenderSettlement);
  const pending = await tender.pendingOwner();
  if (pending === ethers.ZeroAddress) return console.log("No pending owner. Current owner:", await tender.owner());
  const signer = (await ethers.getSigners()).find((s) => s.address.toLowerCase() === pending.toLowerCase());
  if (!signer) throw new Error(`No key for pending owner ${pending} (check .wallets/wallets.json)`);
  const bal = await ethers.provider.getBalance(signer.address);
  if (bal === 0n) throw new Error(`Owner ${signer.address} has no ETH. Send ~0.0005 ETH on Robinhood Chain first.`);
  await (await tender.connect(signer).acceptOwnership()).wait();
  console.log("Owner is now", await tender.owner());
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
