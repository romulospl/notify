import "server-only";
import type { OperatorContext } from "../access";
import { listUmamiLinks } from "../data/operator/sites";
import { umamiRequest } from "./http";

// Consistency test from the E2 spec, section 7: every `site.umami_website_id`
// exists in Umami, and every Umami site has a row in `site`. A global check,
// only for the operator; it returns IDs only.

type WebsitePage = { data: { id: string }[]; count: number };

const PAGE_SIZE = 100;

async function listUmamiWebsiteIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let page = 1; ; page++) {
    const { data, count } = await umamiRequest<WebsitePage>(
      `/api/websites?page=${page}&pageSize=${PAGE_SIZE}`,
    );
    for (const website of data) ids.add(website.id);
    if (data.length === 0 || page * PAGE_SIZE >= count) return ids;
  }
}

export async function findUmamiInconsistencies(ctx: OperatorContext) {
  const inUmami = await listUmamiWebsiteIds();
  const links = await listUmamiLinks(ctx);
  const inPortal = new Set(links.map((l) => l.umamiWebsiteId));
  return {
    // `site` IDs whose site disappeared from Umami.
    missingInUmami: links.filter((l) => !inUmami.has(l.umamiWebsiteId)).map((l) => l.siteId),
    // Umami sites with no row in `site` (for example, a rollback that failed).
    orphanedInUmami: [...inUmami].filter((id) => !inPortal.has(id)),
  };
}
