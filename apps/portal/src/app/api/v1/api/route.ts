import { getApiOverview } from "@/lib/data/operator/api";
import { handleRead, periodBody } from "@/lib/read-api";

export const dynamic = "force-dynamic";

// GET /api/v1/api?period=7d: API metrics of each active project, the same as
// the /operator/api dashboard. Latencies in seconds (p50, p95), null with no requests.
export function GET(request: Request) {
  return handleRead(request, async (ctx, period) => ({
    period: periodBody(period),
    projects: (await getApiOverview(ctx, period)).map((p) => ({
      id: p.tenantId,
      name: p.name,
      slug: p.slug,
      apiServices: p.services,
      totals: p.totals,
    })),
  }));
}
