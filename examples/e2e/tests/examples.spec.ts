// The three examples record page views in Umami, going through the gateway with
// the JS execution proof (#27). The check is done in the Umami database.
import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";

const umami = postgres(process.env.UMAMI_DATABASE_URL ?? "postgresql://umami:umami@127.0.0.1:5432/umami");
test.afterAll(() => umami.end());

function site(name: "SITE_STATIC" | "SITE_SPA" | "SITE_NEXT" | "SITE_WALLET"): string {
  const id = process.env[name];
  if (!id) throw new Error(`${name} not set: run through run.mjs`);
  return id;
}

// Paths of the site's page views, in alphabetical order.
async function pageviews(website: string): Promise<string[]> {
  const rows = await umami<{ url_path: string }[]>`
    SELECT url_path FROM website_event WHERE website_id = ${website} AND event_type = 1`;
  return rows.map((r) => r.url_path).sort();
}

async function expectPageviews(website: string, want: string[]) {
  await expect.poll(() => pageviews(website), { timeout: 30_000 }).toEqual([...want].sort());
}

// Marks the window; if the page reloads, the mark is gone.
async function mark(page: Page) {
  await page.evaluate(() => Object.assign(window, { __noReload: true }));
}
async function expectNoReload(page: Page) {
  expect(await page.evaluate(() => (window as { __noReload?: boolean }).__noReload)).toBe(true);
}

test("Static HTML: one page view per loaded page", async ({ page }) => {
  const website = site("SITE_STATIC");
  await page.goto("http://127.0.0.1:4001/");
  await expectPageviews(website, ["/"]);
  await page.getByRole("link", { name: "Documentation" }).click();
  await expect(page).toHaveURL(/\/docs\.html$/);
  await expectPageviews(website, ["/", "/docs.html"]);
});

test("SPA: counts each route change without reloading", async ({ page }) => {
  const website = site("SITE_SPA");
  await page.goto("http://127.0.0.1:4002/");
  await expectPageviews(website, ["/"]);
  await mark(page);

  // The script merges navigations less than 300 ms apart into a single page
  // view, the one for the final route. Like a person, the test waits for each
  // route to be counted.
  await page.getByRole("link", { name: "Pricing" }).click();
  await expect(page).toHaveTitle("SPA: pricing");
  await expectPageviews(website, ["/", "/pricing"]);
  await page.getByRole("link", { name: "Contact" }).click();
  await expect(page).toHaveTitle("SPA: contact");
  await expectPageviews(website, ["/", "/pricing", "/contact"]);
  await page.goBack();
  await expect(page).toHaveURL(/\/pricing$/);

  await expectNoReload(page);
  await expectPageviews(website, ["/", "/pricing", "/contact", "/pricing"]);
});

test("Next.js with SSR: the tag ships in the server HTML and router navigation counts", async ({ page, request }) => {
  const website = site("SITE_NEXT");
  const html = await (await request.get("http://127.0.0.1:4003/")).text();
  expect(html).toMatch(/<script[^>]+src="[^"]+\/s\/v\d+\.\d+\.\d+\/n\.js"/);
  expect(html).toContain('integrity="sha384-');
  expect(html).toContain(`data-site="${website}"`);

  await page.goto("http://127.0.0.1:4003/");
  await expectPageviews(website, ["/"]);
  await mark(page);
  await page.getByRole("link", { name: "Documentation" }).click();
  await expect(page).toHaveURL(/\/docs$/);
  await expectNoReload(page);
  await expectPageviews(website, ["/", "/docs"]);
});

// The site's custom events: names in alphabetical order, and the stored properties.
async function customEvents(website: string): Promise<string[]> {
  const rows = await umami<{ event_name: string }[]>`
    SELECT event_name FROM website_event WHERE website_id = ${website} AND event_type = 2`;
  return rows.map((r) => r.event_name).sort();
}

async function eventData(website: string): Promise<string[]> {
  const rows = await umami<{ data_key: string; string_value: string | null }[]>`
    SELECT data_key, string_value FROM event_data WHERE website_id = ${website}`;
  return rows.map((r) => `${r.data_key}=${r.string_value}`).sort();
}

test("dApp: custom events and wallets through the adapter, no address (#50)", async ({ page }) => {
  const website = site("SITE_WALLET");
  await page.goto("http://127.0.0.1:4004/");
  await expectPageviews(website, ["/"]);

  await page.getByRole("button", { name: "Submit swap" }).click();
  await expect.poll(() => customEvents(website), { timeout: 30_000 }).toEqual(["swap_submitted"]);

  // No wallet extension in CI: a fake kit with the kit 2.8.0 behavior, which
  // reports the remembered wallet on subscribe (must not count).
  const address = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
  await page.evaluate((address) => {
    const handlers: Record<string, ((e: unknown) => void)[]> = {};
    const kit = {
      on(type: string, handler: (e: unknown) => void) {
        (handlers[type] ??= []).push(handler);
        if (type === "WALLET_SELECTED") handler({ eventType: type, payload: { id: "freighter" } });
        return () => {};
      },
    };
    const w = window as unknown as { stellytics: { wallets: (kit: unknown, types: unknown) => void } };
    w.stellytics.wallets(kit, { STATE_UPDATED: "STATE_UPDATE", WALLET_SELECTED: "WALLET_SELECTED", DISCONNECT: "DISCONNECT" });
    for (const h of handlers.STATE_UPDATE ?? []) h({ eventType: "STATE_UPDATE", payload: { address } });
    for (const h of handlers.WALLET_SELECTED ?? []) h({ eventType: "WALLET_SELECTED", payload: { id: "xbull" } });
    for (const h of handlers.DISCONNECT ?? []) h({ eventType: "DISCONNECT", payload: {} });
  }, address);

  await expect
    .poll(() => customEvents(website), { timeout: 30_000 })
    .toEqual(["swap_submitted", "wallet_disconnected", "wallet_selected"]);
  expect(await eventData(website)).toEqual(["pair=XLM/USDC", "wallet=xbull"]);
  expect(JSON.stringify(await eventData(website))).not.toContain(address);
});
