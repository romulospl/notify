// No `next build` os módulos são avaliados sem as variáveis de produção.
// Nessa fase usamos valores inertes; nada conecta ao banco durante o build.
const isBuild = process.env.NEXT_PHASE === "phase-production-build";

const buildPlaceholders: Record<string, string> = {
  DATABASE_URL: "postgresql://build:build@127.0.0.1:1/build",
  BETTER_AUTH_SECRET: "build-placeholder-secret-not-used-at-runtime",
};

function required(name: string): string {
  const value = process.env[name];
  if (value) return value;
  const placeholder = buildPlaceholders[name];
  if (isBuild && placeholder) return placeholder;
  throw new Error(`Variável de ambiente ${name} não definida`);
}

export const env = {
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  get authSecret() {
    return required("BETTER_AUTH_SECRET");
  },
  get authUrl() {
    return process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  },
};
