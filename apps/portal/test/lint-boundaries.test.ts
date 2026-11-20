// The lint rule of the single layer (#18): database only in src/lib/data/, Umami only
// in src/lib/umami/. Runs the portal's ESLint over code snippets.
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

describe("single data access layer", () => {
  it("pages and routes do not import the database, the driver or the Umami HTTP client", async () => {
    expect(await restrictedImports("src/app/(private)/x/page.tsx", DB)).toBe(1);
    expect(await restrictedImports("src/app/api/x/route.ts", DB_RELATIVE)).toBe(1);
    expect(await restrictedImports("src/app/x.ts", DRIVER)).toBe(1);
    expect(await restrictedImports("src/app/x.ts", UMAMI)).toBe(1);
    // Reads by the Umami ID are also internal to src/lib/umami/.
    expect(await restrictedImports("src/app/x.ts", UMAMI_READ)).toBe(1);
    expect(await restrictedImports("src/lib/data/x.ts", UMAMI_READ)).toBe(1);
    expect(await restrictedImports("src/lib/other.ts", DB)).toBe(1);
  });

  it("pages use the layer's functions and may read the schema", async () => {
    expect(await restrictedImports("src/app/x.ts", DATA)).toBe(0);
    expect(await restrictedImports("src/app/x.ts", SCHEMA)).toBe(0);
  });

  it("src/lib/data/ uses the database, but not the Umami HTTP client", async () => {
    expect(await restrictedImports("src/lib/data/x.ts", DB)).toBe(0);
    expect(await restrictedImports("src/lib/data/x.ts", UMAMI)).toBe(1);
  });

  it("src/lib/umami/ calls Umami, but reads the database only through src/lib/data/", async () => {
    expect(await restrictedImports("src/lib/umami/x.ts", UMAMI)).toBe(0);
    expect(await restrictedImports("src/lib/umami/x.ts", UMAMI_READ)).toBe(0);
    expect(await restrictedImports("src/lib/umami/x.ts", DB)).toBe(1);
    expect(await restrictedImports("src/lib/umami/x.ts", DATA)).toBe(0);
  });
});
