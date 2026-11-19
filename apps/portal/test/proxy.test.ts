// Regra do proxy para o otimizador de imagem desligado (#151, #153): 404 em
// /_next/image, também com barra final ou percent-encoding.
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";

const run = (pathname: string) => proxy(new NextRequest(new URL(pathname, "http://localhost:3000")));

describe("proxy", () => {
  it.each(["/_next/image", "/_next/image/", "/_next/image//", "/_next/%69mage", "/_next/image?url=%2Fx.png&w=64&q=75"])(
    "%s responde 404",
    (pathname) => {
      expect(run(pathname).status).toBe(404);
    },
  );

  it("percent-encoding inválido não quebra e não vira 404", () => {
    const res = run("/sites/%E0%A4%A");
    expect(res.status).toBe(307);
  });

  it("sem cookie de sessão, página privada redireciona para /sign-in", () => {
    const res = run("/sites/abc");
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("next")).toBe("/sites/abc");
  });
});
