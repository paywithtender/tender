// Puts the $TENDER contract address (and optional buy link) into the site config.
//   node site/set-token.mjs 0x<CA> [https://buy-link]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const [ca, buy = ""] = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{40}$/.test(ca || "")) { console.error("That doesn't look like a contract address (0x + 40 hex characters)."); process.exit(1); }
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.html");
let s = fs.readFileSync(file, "utf8");
s = s.replace(/  token: "[^"]*",/, `  token: "${ca}",`).replace(/  tokenBuyUrl: "[^"]*",/, `  tokenBuyUrl: "${buy}",`);
fs.writeFileSync(file, s);
console.log(`Site now shows $TENDER ${ca}${buy ? ` (Buy -> ${buy})` : ""}`);
