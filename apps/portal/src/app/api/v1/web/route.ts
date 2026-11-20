import { getWebOverview } from "@/lib/umami/overview";
import { handleRead, periodBody } from "@/lib/read-api";

export const dynamic = "force-dynamic";

// GET /api/v1/web?period=7d: web metrics of each active project, the same as
// the /operator/web dashboard. `totals` and `previous` are null when Umami did
// not answer for one of the project's sites.
export function GET(request: Request) {
  return handleRead(request, async (ctx, period) => {
    const { projects, unavailable } = await getWebOverview(ctx, period);
    return {
      period: periodBody(period),
      unavailable,
      projects: projects.map((p) => ({
        id: p.tenantId,
        name: p.name,
        slug: p.slug,
        websites: p.sites,
        totals: p.totals,
        previous: p.previous,
      })),
    };
  });
}
