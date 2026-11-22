// Creates Tender's four wallets on THIS computer and saves them to tender/.wallets/ (git-ignored).
//   cd contracts && node scripts/new-wallets.js
// Never run it twice: it refuses to overwrite existing wallets.
const fs = require("fs");
const path = require("path");
const { Wallet } = require("ethers");

const dir = path.join(__dirname, "..", "..", ".wallets");
const file = path.join(dir, "wallets.json");

if (fs.existsSync(file)) {
  console.error(`Wallets already exist at ${file}. Not overwriting. Move that file away first if you really want new ones.`);
  process.exit(1);
}

const roles = {
  owner: "Cold wallet. Owns the contract (pause, fees, routers). Import into a wallet app, never put its key on a server.",
  treasury: "Receives all fees. Import into a wallet app.",
  deployer: "Deploys the contract once. Needs ~$5 of ETH, empty it afterwards.",
  relayer: "Hot wallet the facilitator server uses to settle payments. Keep only ~$5–20 of ETH on it.",
};

const out = { createdAt: new Date().toISOString(), chain: "Robinhood Chain (4663)", wallets: {} };
for (const [role, purpose] of Object.entries(roles)) {
  const w = Wallet.createRandom();
  out.wallets[role] = { address: w.address, privateKey: w.privateKey, recoveryPhrase: w.mnemonic.phrase, purpose };
}

fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(dir, ".gitignore"), "*\n");

const w = out.wallets;
const env = `# --- contracts (deploy) ---
DEPLOYER_PRIVATE_KEY=${w.deployer.privateKey}
TREASURY_ADDRESS=${w.treasury.address}
RELAYER_ADDRESS=${w.relayer.address}
OWNER_ADDRESS=${w.owner.address}

# --- facilitator (.env) ---
RELAYER_PRIVATE_KEY=${w.relayer.privateKey}
`;
fs.writeFileSync(path.join(dir, "env-snippets.txt"), env, { mode: 0o600 });

console.log("Created 4 wallets. Addresses (safe to share):\n");
for (const [role, v] of Object.entries(w)) console.log(`  ${role.padEnd(9)} ${v.address}`);
console.log(`
Saved privately to ${dir}
  wallets.json       addresses, private keys, recovery phrases
  env-snippets.txt   lines to paste into the deploy command and the facilitator .env

Next:
  1. Back up wallets.json somewhere offline (USB stick or password manager). Lose it and the fees are gone.
  2. Import owner and treasury into a wallet app (Rabby / MetaMask) with their recovery phrases.
  3. Fund ONLY deployer (~$5 ETH) and relayer (~$10 ETH) on Robinhood Chain, from a fresh exchange
     withdrawal, never from a wallet linked to your other projects.
  4. Owner and treasury need no ETH yet.`);
