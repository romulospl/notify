import { expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

// The container healthcheck and the external probe only need a 2xx.
it("GET /api/health answers 200 with ok", async () => {
  const res = GET();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
