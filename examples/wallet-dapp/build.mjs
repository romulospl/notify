// Bundles src/app.js (with the Stellar Wallets Kit) into public/app.js, which
// serve.mjs serves next to index.html.
import { build } from "esbuild";

await build({
  entryPoints: ["src/app.js"],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  outfile: "public/app.js",
  logLevel: "info",
});
