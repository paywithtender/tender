// Builds the local SDK and puts it where the MCP server resolves "@paywithtender/sdk",
// so the MCP tests run against this repo's SDK instead of the version published on npm.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
execSync("node build-npm.mjs", { cwd: path.join(root, "packages/sdk"), stdio: "inherit" });
const dest = path.join(root, "packages/mcp/node_modules/@paywithtender/sdk");
// Never clear through a link (an npm workspace link would point back at packages/sdk itself).
if (fs.existsSync(dest) && fs.lstatSync(dest).isSymbolicLink()) {
  console.log("MCP already links to the local SDK; nothing to copy");
  process.exit(0);
}
fs.mkdirSync(dest, { recursive: true });
for (const f of fs.readdirSync(dest)) if (f !== "node_modules") fs.rmSync(path.join(dest, f), { recursive: true, force: true, maxRetries: 5 });
fs.cpSync(path.join(root, "packages/sdk/npm"), dest, { recursive: true });
console.log("MCP now uses the local SDK build");
