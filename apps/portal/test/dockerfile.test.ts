// The development accounts (drizzle-dev, known passwords) do not go into the
// production image and are not enabled outside the dev Compose (#153).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repo = path.join(import.meta.dirname, "..", "..", "..");
const read = (file: string) => readFileSync(path.join(repo, file), "utf8");

// Dockerfile stages, in order; the last one is the default build target.
function stages(dockerfile: string) {
  return dockerfile
    .split(/^(?=FROM\s)/m)
    .filter((s) => s.startsWith("FROM"))
    .map((s) => ({ name: /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(s)?.[1], body: s }));
}

describe("development accounts out of production", () => {
  const all = stages(read("apps/portal/Dockerfile"));

  it("the default portal image does not copy drizzle-dev", () => {
    const last = all.at(-1)!;
    expect(last.name).toBeUndefined();
    expect(last.body).not.toMatch(/drizzle-dev/);
    // The last stage starts from the runner, which must not carry drizzle-dev either.
    expect(last.body).toMatch(/^FROM\s+runner\s*$/m);
    const runner = all.find((s) => s.name === "runner")!;
    expect(runner.body).not.toMatch(/drizzle-dev/);
  });

  it("only the dev stage carries drizzle-dev, and only the dev Compose uses it", () => {
    const withDev = all.filter((s) => /drizzle-dev/.test(s.body)).map((s) => s.name);
    expect(withDev).toEqual(["dev"]);
    expect(read("infra/compose/dev.yaml")).toMatch(/dockerfile: apps\/portal\/Dockerfile\n\s+#.*\n\s+target: dev/);
  });

  it("no production Compose sets SEED_DEV_DATA", () => {
    const compose = readdirSync(path.join(repo, "infra/compose")).filter((f) => /^prod.*\.ya?ml$/.test(f));
    expect(compose.length).toBeGreaterThan(0);
    for (const f of compose) expect(read(`infra/compose/${f}`), f).not.toMatch(/SEED_DEV_DATA/);
    expect(read(".env.production.example")).not.toMatch(/SEED_DEV_DATA/);
  });
});
