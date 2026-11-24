// Builds site/try/tender-try.js, the browser bundle for paywithtender.com/try.
//   npx esbuild@0 --version >nul && node tools/try/build.mjs
import { build } from "esbuild";
await build({
  entryPoints: [new URL("./entry.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
  bundle: true,
  format: "iife",
  minify: true,
  target: "es2020",
  outfile: "site/try/tender-try.js",
});
console.log("built site/try/tender-try.js");
