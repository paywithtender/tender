// npx hardhat run scripts/deploy.js --network robinhood
// Env: DEPLOYER_PRIVATE_KEY, TREASURY_ADDRESS, RELAYER_ADDRESS, OWNER_ADDRESS (optional, e.g. a fresh cold wallet)
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

function saved() {
  try {
    return require("../../.wallets/wallets.json").wallets;
  } catch {
    return null;
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const w = saved();
  const treasury = process.env.TREASURY_ADDRESS || (w && w.treasury.address);
  const relayer = process.env.RELAYER_ADDRESS || (w && w.relayer.address);
  if (!treasury || !relayer) throw new Error("Set TREASURY_ADDRESS and RELAYER_ADDRESS (or run new-wallets.bat first)");
  const finalOwner = process.env.OWNER_ADDRESS || (w && w.owner.address) || deployer.address;
  if (w && deployer.address !== w.deployer.address) throw new Error("Deployer key does not match .wallets deployer");
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer balance: ${ethers.formatEther(bal)} ETH`);
  if (bal === 0n) throw new Error("Deployer has no ETH on this network");

  console.log(`Network ${network.name} (${network.config.chainId}), deployer ${deployer.address}`);
  const code = await ethers.provider.getCode(PERMIT2);
  if (code === "0x") throw new Error("Permit2 not found on this chain");

  const Settlement = await ethers.getContractFactory("TenderSettlement");
  const tender = await Settlement.deploy(deployer.address, PERMIT2, USDG, treasury);
  await tender.waitForDeployment();
  const address = await tender.getAddress();
  console.log("TenderSettlement:", address);

  await (await tender.setRelayer(relayer, true)).wait();
  console.log("Relayer allowed:", relayer);

  await (await tender.setMaxAmountOut(25_000_000n)).wait(); // start small: 25 USDG per payment
  console.log("Per-payment cap: 25 USDG");

  if (finalOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    await (await tender.transferOwnership(finalOwner)).wait();
    console.log(`Ownership offered to ${finalOwner}. Fund the owner with ~0.0005 ETH, then run accept-ownership.bat.`);
  }

  const out = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify({ TenderSettlement: address, permit2: PERMIT2, usdg: USDG, treasury, relayer, owner: finalOwner, deployedAt: new Date().toISOString() }, null, 2)
  );
  console.log("Saved", out);
  console.log(`\nExplorer: https://explorer.mainnet.chain.robinhood.com/address/${address}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
