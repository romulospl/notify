// As contas de desenvolvimento (drizzle-dev, senhas conhecidas) não vão para a
// imagem de produção nem são ligadas fora do Compose de dev (#153).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repo = path.join(import.meta.dirname, "..", "..", "..");
const read = (file: string) => readFileSync(path.join(repo, file), "utf8");

// Estágios do Dockerfile, na ordem; o último é o alvo padrão do build.
function stages(dockerfile: string) {
  return dockerfile
    .split(/^(?=FROM\s)/m)
    .filter((s) => s.startsWith("FROM"))
    .map((s) => ({ name: /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(s)?.[1], body: s }));
}

describe("contas de desenvolvimento fora da produção", () => {
  const all = stages(read("apps/portal/Dockerfile"));

  it("a imagem padrão do portal não copia o drizzle-dev", () => {
    const last = all.at(-1)!;
    expect(last.name).toBeUndefined();
    expect(last.body).not.toMatch(/drizzle-dev/);
    // O último estágio parte do runner, que também não pode levar o drizzle-dev.
    expect(last.body).toMatch(/^FROM\s+runner\s*$/m);
    const runner = all.find((s) => s.name === "runner")!;
    expect(runner.body).not.toMatch(/drizzle-dev/);
  });

  it("só o estágio dev leva o drizzle-dev, e só o Compose de dev o usa", () => {
    const withDev = all.filter((s) => /drizzle-dev/.test(s.body)).map((s) => s.name);
    expect(withDev).toEqual(["dev"]);
    expect(read("infra/compose/dev.yaml")).toMatch(/dockerfile: apps\/portal\/Dockerfile\n\s+#.*\n\s+target: dev/);
  });

  it("nenhum Compose de produção nem o Ansible definem SEED_DEV_DATA", () => {
    const compose = readdirSync(path.join(repo, "infra/compose")).filter((f) => /^prod.*\.ya?ml$/.test(f));
    expect(compose.length).toBeGreaterThan(0);
    for (const f of compose) expect(read(`infra/compose/${f}`), f).not.toMatch(/SEED_DEV_DATA/);
    expect(read("infra/ansible/roles/stellytics/templates/env.j2")).not.toMatch(/SEED_DEV_DATA/);
  });
});
