import { listActiveProjects } from "@/lib/data/operator/projects";
import { handleRead } from "@/lib/read-api";

export const dynamic = "force-dynamic";

// GET /api/v1/projects: active projects (id, name, slug and counts).
export function GET(request: Request) {
  return handleRead(request, async (ctx) => ({ projects: await listActiveProjects(ctx) }));
}
