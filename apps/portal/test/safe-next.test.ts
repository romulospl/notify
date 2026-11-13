import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";

describe("safeNext", () => {
  it("aceita caminhos internos", () => {
    expect(safeNext("/operator")).toBe("/operator");
    expect(safeNext("/dashboard?range=7d")).toBe("/dashboard?range=7d");
  });

  it("recusa destinos externos ou ambíguos", () => {
    for (const value of ["https://evil.example", "//evil.example", "/\\evil.example", "evil", ""]) {
      expect(safeNext(value)).toBe("/dashboard");
    }
  });

  it("usa o padrão sem valor ou com valor repetido", () => {
    expect(safeNext(undefined)).toBe("/dashboard");
    expect(safeNext(["/a", "/b"])).toBe("/dashboard");
  });
});
