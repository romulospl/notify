export const dynamic = "force-dynamic";

// GET /api/health: liveness of the portal process, for the container
// healthcheck and the external monitoring probe. It reads nothing, so it
// answers even when the database or Umami is down; those have their own checks.
export function GET() {
  return Response.json({ ok: true });
}
