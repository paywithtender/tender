/**
 * Adds the Tender MCP server to Claude Desktop, using the test agent wallet in .wallets/agent.json.
 * The key is copied from that file into Claude Desktop's config on this PC; it is never printed.
 * Keeps any other MCP servers you already have, and saves a backup of the old config first.
 *
 *   node scripts/setup-claude-desktop.mjs            add / update the "tender" server
 *   node scripts/setup-claude-desktop.mjs --remove   take it out again
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TENDER = "0xda4a075417d613ec018c8959fea6ab5ac5d5b78c";

const configDir =
  process.platform === "win32"
    ? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Claude")
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "Claude")
      : path.join(os.homedir(), ".config", "Claude");
const configFile = path.join(configDir, "claude_desktop_config.json");

let config = {};
if (fs.existsSync(configFile)) {
  const raw = fs.readFileSync(configFile, "utf8");
  try {
    config = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    console.error(`Your Claude Desktop config isn't valid JSON, so I won't touch it:\n  ${configFile}`);
    process.exit(1);
  }
  const backup = configFile + ".before-tender.bak";
  if (!fs.existsSync(backup)) fs.copyFileSync(configFile, backup);
}
config.mcpServers ??= {};

if (process.argv.includes("--remove")) {
  delete config.mcpServers.tender;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  console.log("Removed the Tender MCP server from Claude Desktop. Restart Claude Desktop to apply.");
  process.exit(0);
}

const agent = JSON.parse(fs.readFileSync(path.join(ROOT, ".wallets", "agent.json"), "utf8"));
if (!/^0x[0-9a-fA-F]{64}$/.test(agent.privateKey ?? "")) {
  console.error("Couldn't read the test agent key from .wallets/agent.json");
  process.exit(1);
}

const payWith = process.argv[2] && /^0x[0-9a-fA-F]{40}$/.test(process.argv[2]) ? process.argv[2] : TENDER;
config.mcpServers.tender = {
  command: process.platform === "win32" ? "npx.cmd" : "npx",
  args: ["-y", "@paywithtender/mcp"],
  env: {
    TENDER_PRIVATE_KEY: agent.privateKey,
    TENDER_PAY_WITH: payWith,
    // small limits for a demo wallet
    TENDER_MAX_PER_CALL_USD: "0.05",
    TENDER_MAX_FEE_USD: "0.10",
    TENDER_DAILY_LIMIT_USD: "0.50",
  },
};

fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
console.log(`Added the Tender MCP server to Claude Desktop.
  Agent wallet: ${agent.address}
  Pays with:    ${payWith === TENDER ? "$TENDER" : payWith}
  Limits:       $0.05 per call, $0.50 per day
  Config:       ${configFile}

Now fully quit Claude Desktop (right-click its tray icon > Quit) and open it again.`);
