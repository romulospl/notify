import "server-only";
import { umamiRequest } from "./http";

// Creates the site in Umami and then writes the link in `stellytics` (E2 spec,
// section 7). If the write fails, it deletes the newly created site in Umami.
// The portal creates only sites, never users or teams (ADR 0003).
//
// It takes the write as a function so that the Umami ID never leaves here
// without being tied to a site of the tenant. Called only by src/lib/data/sites.ts.
export async function provisionUmamiWebsite<T>(
  input: { name: string; domain: string },
  persist: (umamiWebsiteId: string) => Promise<T>,
): Promise<T> {
  const website = await umamiRequest<{ id: string }>("/api/websites", {
    method: "POST",
    body: { name: input.name, domain: input.domain },
  });
  try {
    return await persist(website.id);
  } catch (error) {
    await umamiRequest(`/api/websites/${website.id}`, { method: "DELETE" }).catch((cleanup) => {
      // An orphan site is left in Umami; the consistency test finds it.
      console.error("Failed to undo the site in Umami", website.id, cleanup);
    });
    throw error;
  }
}
