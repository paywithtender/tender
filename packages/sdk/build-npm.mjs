// Builds the public npm package @paywithtender/sdk into packages/sdk/npm
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "npm");
// Empty the folders instead of deleting them, so an open terminal inside them can't block the build.
function clean(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true, maxRetries: 5 });
}
clean(path.join(here, "dist"));
clean(out);
execSync("npx tsc -p tsconfig.build.json", { cwd: here, stdio: "inherit" });
fs.cpSync(path.join(here, "dist"), path.join(out, "dist"), { recursive: true });
fs.copyFileSync(path.join(here, "README.md"), path.join(out, "README.md"));
const pkg = {
  name: "@paywithtender/sdk",
  version: process.env.SDK_VERSION || "0.1.1",
  description: "Pay any x402 API with any token on Robinhood Chain. Merchants get exact USDG.",
  license: "MIT",
  homepage: "https://paywithtender.com",
  repository: { type: "git", url: "git+https://github.com/paywithtender/tender.git", directory: "packages/sdk" },
  keywords: ["x402", "robinhood-chain", "payments", "usdg", "permit2", "ai-agents", "uniswap"],
  type: "module",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
  files: ["dist", "README.md"],
  engines: { node: ">=20" },
  dependencies: { viem: "^2.21.0" },
  peerDependencies: { express: ">=4" },
  peerDependenciesMeta: { express: { optional: true } },
};
fs.writeFileSync(path.join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
console.log(`Built ${pkg.name}@${pkg.version} in ${out}`);
