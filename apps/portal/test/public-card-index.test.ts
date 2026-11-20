import { afterEach, expect, it } from "vitest";
import PublicCardIndexPage from "@/app/p/page";

// /p alone is linked from outside (the SCF submission): it must reach the one
// public card, with the same slug as the demo tabs, instead of a 404.
function target(): string {
  try {
    PublicCardIndexPage();
  } catch (error) {
    return String((error as { digest?: string }).digest);
  }
  throw new Error("expected a redirect");
}

afterEach(() => {
  delete process.env.DEMO_TENANT_SLUG;
});

it("redirects /p to the sample project's card", () => {
  delete process.env.DEMO_TENANT_SLUG;
  expect(target()).toContain(";/p/stellytics;");
});

it("redirects /p to the demo tenant's card", () => {
  process.env.DEMO_TENANT_SLUG = "pigfi";
  expect(target()).toContain(";/p/pigfi;");
});
