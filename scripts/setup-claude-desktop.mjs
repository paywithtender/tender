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

// Where Claude Desktop keeps its config. The Microsoft Store install reads a private copy
// under %LOCALAPPDATA%\\Packages\\Claude_*\\LocalCache\\Roaming\\Claude, so write there too.
function configDirs() {
  if (process.platform === "darwin") return [path.join(os.homedir(), "Library", "Application Support", "Claude")];
  if (process.platform !== "win32") return [path.join(os.homedir(), ".config", "Claude")];
  const dirs = [path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Claude")];
  const pkgs = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Packages");
  try {
    for (const d of fs.readdirSync(pkgs)) {
      if (/^Claude_/i.test(d)) dirs.push(path.join(pkgs, d, "LocalCache", "Roaming", "Claude"));
    }
  } catch {}
  // Newer desktop versions keep their config in %LOCALAPPDATA%\\Claude-Data\\claude_*
  const data = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Claude-Data");
  try {
    for (const d of fs.readdirSync(data)) {
      if (/^claude_/i.test(d) && fs.existsSync(path.join(data, d, "claude_desktop_config.json"))) dirs.push(path.join(data, d));
    }
  } catch {}
  return dirs;
}

const remove = process.argv.includes("--remove");
let agent = {};
if (!remove) {
  agent = JSON.parse(fs.readFileSync(path.join(ROOT, ".wallets", "agent.json"), "utf8"));
  if (!/^0x[0-9a-fA-F]{64}$/.test(agent.privateKey ?? "")) {
    console.error("Couldn't read the test agent key from .wallets/agent.json");
    process.exit(1);
  }
}
const payWith = process.argv[2] && /^0x[0-9a-fA-F]{40}$/.test(process.argv[2]) ? process.argv[2] : TENDER;

const written = [];
for (const configDir of configDirs()) {
  const configFile = path.join(configDir, "claude_desktop_config.json");
  let config = {};
  if (fs.existsSync(configFile)) {
    const raw = fs.readFileSync(configFile, "utf8");
    try {
      config = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      console.error(`Skipping a Claude Desktop config that isn't valid JSON:\n  ${configFile}`);
      continue;
    }
    const backup = configFile + ".before-tender.bak";
    if (!fs.existsSync(backup)) fs.copyFileSync(configFile, backup);
  }
  config.mcpServers ??= {};
  if (remove) {
    delete config.mcpServers.tender;
  } else {
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
  }
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  written.push(configFile);
}

// Claude Code keeps user-scope MCP servers in ~/.claude.json (created on its first run).
const claudeCode = path.join(os.homedir(), ".claude.json");
if (fs.existsSync(claudeCode)) {
  try {
    const cc = JSON.parse(fs.readFileSync(claudeCode, "utf8"));
    const backup = claudeCode + ".before-tender.bak";
    if (!fs.existsSync(backup)) fs.copyFileSync(claudeCode, backup);
    cc.mcpServers ??= {};
    if (remove) delete cc.mcpServers.tender;
    else
      cc.mcpServers.tender = {
        type: "stdio",
        // Claude Code on Windows needs npx wrapped in cmd /c
        command: process.platform === "win32" ? "cmd" : "npx",
        args: process.platform === "win32" ? ["/c", "npx", "-y", "@paywithtender/mcp"] : ["-y", "@paywithtender/mcp"],
        env: {
          TENDER_PRIVATE_KEY: agent.privateKey,
          TENDER_PAY_WITH: payWith,
          TENDER_MAX_PER_CALL_USD: "0.05",
          TENDER_MAX_FEE_USD: "0.10",
          TENDER_DAILY_LIMIT_USD: "0.50",
        },
      };
    fs.writeFileSync(claudeCode, JSON.stringify(cc, null, 2));
    written.push(claudeCode + " (Claude Code)");
  } catch (e) {
    console.error(`Couldn't update Claude Code's config (${claudeCode}): ${e.message}`);
  }
}

if (remove) {
  console.log(`Removed the Tender MCP server from Claude Desktop (${written.length} config file(s)). Restart Claude Desktop to apply.`);
  process.exit(0);
}
console.log(`Added the Tender MCP server to Claude Desktop.
  Agent wallet: ${agent.address}
  Pays with:    ${payWith === TENDER ? "TENDER" : payWith}
  Limits:       $0.05 per call, $0.50 per day
  Config:       ${written.join("\n                ")}

Now open Claude Desktop again (it must have been fully quit before running this).`);
