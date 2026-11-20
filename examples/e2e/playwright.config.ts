import { defineConfig, devices } from "@playwright/test";

// Run through run.mjs (pnpm --filter @stellytics/examples-e2e e2e), which
// creates the sites and fills SITE_STATIC, SITE_SPA, SITE_NEXT and SITE_WALLET.
const gateway = process.env.STELLYTICS_GATEWAY_URL ?? "http://127.0.0.1:3002";

function server(name: string, port: number, command: string, cwd: string, site?: string) {
  return {
    name,
    command,
    cwd,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: { PORT: String(port), STELLYTICS_WEBSITE_ID: site ?? "", STELLYTICS_GATEWAY_URL: gateway, NEXT_TELEMETRY_DISABLED: "1" },
  };
}

export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  // No retry: each site is created once per run, and the page views of a
  // failed attempt would stay in the database and break the next one.
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
  webServer: [
    server("static-html", 4001, "node ../serve.mjs .", "../static-html", process.env.SITE_STATIC),
    server("spa", 4002, "node ../serve.mjs . spa", "../spa", process.env.SITE_SPA),
    server(
      "nextjs-ssr",
      4003,
      "node_modules/.bin/next build && node_modules/.bin/next start --hostname 127.0.0.1 --port 4003",
      "../nextjs-ssr",
      process.env.SITE_NEXT,
    ),
    // dApp with the Stellar Wallets Kit (#50): bundles the app and serves the public folder.
    server("wallet-dapp", 4004, "node build.mjs && node ../serve.mjs public", "../wallet-dapp", process.env.SITE_WALLET),
  ],
});
