import "server-only";
import { umamiRequest, UmamiError } from "./http";

// Deletes a site in Umami (right to erasure, #154). Only this module speaks
// DELETE with Umami; src/lib/data/erasure.ts orchestrates the erasure.
//
// 404 counts as success: repeating an erasure that failed after the site had
// already left Umami must not get stuck again.
export async function deleteUmamiWebsite(umamiWebsiteId: string): Promise<void> {
  try {
    await umamiRequest(`/api/websites/${umamiWebsiteId}`, { method: "DELETE" });
  } catch (error) {
    if (error instanceof UmamiError && error.status === 404) return;
    throw error;
  }
}
