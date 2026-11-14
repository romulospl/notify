// A regra de lint da camada única (#18): banco só em src/lib/data/, Umami só
// em src/lib/umami/. Roda o ESLint do portal sobre trechos de código.
import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: path.join(import.meta.dirname, "..") });

async function restrictedImports(file: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath: path.join(import.meta.dirname, "..", file) });
  return result!.messages.filter((m) => m.ruleId === "no-restricted-imports").length;
}

const DB = 'import { db } from "@/lib/db";\nexport const x = db;\n';
const DB_RELATIVE = 'import { db } from "../../lib/db";\nexport const x = db;\n';
const DRIVER = 'import postgres from "postgres";\nexport const x = postgres;\n';
const UMAMI = 'import { umamiRequest } from "@/lib/umami/http";\nexport const x = umamiRequest;\n';
const UMAMI_READ = 'import { readStats } from "@/lib/umami/read";\nexport const x = readStats;\n';
const SCHEMA = 'import { site } from "@/lib/db/schema";\nexport const x = site;\n';
const DATA = 'import { listSites } from "@/lib/data/sites";\nexport const x = listSites;\n';

describe("camada única de acesso a dados", () => {
  it("páginas e rotas não importam o banco, o driver nem o cliente HTTP do Umami", async () => {
    expect(await restrictedImports("src/app/(private)/x/page.tsx", DB)).toBe(1);
    expect(await restrictedImports("src/app/api/x/route.ts", DB_RELATIVE)).toBe(1);
    expect(await restrictedImports("src/app/x.ts", DRIVER)).toBe(1);
    expect(await restrictedImports("src/app/x.ts", UMAMI)).toBe(1);
    // As leituras pelo ID do Umami também são internas a src/lib/umami/.
    expect(await restrictedImports("src/app/x.ts", UMAMI_READ)).toBe(1);
    expect(await restrictedImports("src/lib/data/x.ts", UMAMI_READ)).toBe(1);
    expect(await restrictedImports("src/lib/other.ts", DB)).toBe(1);
  });

  it("páginas usam as funções da camada e podem ler o esquema", async () => {
    expect(await restrictedImports("src/app/x.ts", DATA)).toBe(0);
    expect(await restrictedImports("src/app/x.ts", SCHEMA)).toBe(0);
  });

  it("src/lib/data/ usa o banco, mas não o cliente HTTP do Umami", async () => {
    expect(await restrictedImports("src/lib/data/x.ts", DB)).toBe(0);
    expect(await restrictedImports("src/lib/data/x.ts", UMAMI)).toBe(1);
  });

  it("src/lib/umami/ chama o Umami, mas lê o banco só por src/lib/data/", async () => {
    expect(await restrictedImports("src/lib/umami/x.ts", UMAMI)).toBe(0);
    expect(await restrictedImports("src/lib/umami/x.ts", UMAMI_READ)).toBe(0);
    expect(await restrictedImports("src/lib/umami/x.ts", DB)).toBe(1);
    expect(await restrictedImports("src/lib/umami/x.ts", DATA)).toBe(0);
  });
});
