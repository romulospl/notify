// Bundles scripts/operator.mjs and its dependencies (postgres, nodemailer,
// better-auth/crypto) into dist/operator.mjs for the portal image (ADR 0017).
// The Next standalone output inlines those packages into its own chunks, so the
// script could not import them from the image's node_modules.
import { build } from "esbuild";

await build({
  entryPoints: ["scripts/operator.mjs"],
  outfile: "dist/operator.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // nodemailer is CommonJS and calls require() for Node built-ins.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  legalComments: "external",
  logLevel: "warning",
});
