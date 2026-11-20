// Proxy rule for the disabled image optimizer (#151, #153): 404 on
// /_next/image, also with a trailing slash or percent-encoding.
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";

const run = (pathname: string) => proxy(new NextRequest(new URL(pathname, "http://localhost:3000")));

describe("proxy", () => {
  it.each(["/_next/image", "/_next/image/", "/_next/image//", "/_next/%69mage", "/_next/image?url=%2Fx.png&w=64&q=75"])(
    "%s answers 404",
    (pathname) => {
      expect(run(pathname).status).toBe(404);
    },
  );

  it("other paths pass through", () => {
    expect(run("/demo").status).toBe(200);
  });
});
