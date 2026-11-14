import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Camada única de acesso a dados (#18, spec do E2, seção 4, ADR 0003):
// - só src/lib/data/ usa o cliente do banco para ler e gravar dados dos tenants;
// - só src/lib/umami/ chama o Umami;
// - o resto do código usa as funções dessas duas pastas, que recebem um
//   contexto criado por src/lib/access.ts.
// Exceções: src/lib/db/ (o próprio cliente e as migrações), access.ts (cria o
// contexto a partir da sessão) e auth.ts (adaptador do Better Auth).
// Esquecer o filtro por tenant fora da camada vira erro de lint.

const dbClient = {
  // Pega `@/lib/db`, `../db`, `./db/index` e `db/migrate`. O esquema (db/schema)
  // fica liberado: só define tabelas e tipos, sem conexão.
  regex: "(^|/)db(/(index|migrate))?$",
  message: "Só src/lib/data/ acessa o banco. Use uma função de lá, passando o contexto de lib/access.ts.",
};
const dbDrivers = {
  group: ["postgres", "drizzle-orm/postgres-js", "drizzle-orm/postgres-js/*"],
  message: "O cliente do banco fica em src/lib/db/. Use as funções de src/lib/data/.",
};
const umamiHttp = {
  // read.ts lê pelo ID do Umami, sem conferir o tenant: também é interno.
  group: ["@/lib/umami/http", "**/umami/http", "@/lib/umami/read", "**/umami/read"],
  message: "Só src/lib/umami/ chama o Umami. Use as funções públicas de lá.",
};

const restrict = (...patterns) => ({
  rules: { "no-restricted-imports": ["error", { patterns }] },
});

const dataLayer = ["src/lib/data/**", "src/lib/access.ts", "src/lib/auth.ts"];

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: [".next/**", "next-env.d.ts", "drizzle/**"] },
  // Páginas, rotas, componentes e o resto de src/: nem banco nem Umami.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [...dataLayer, "src/lib/umami/**", "src/lib/db/**"],
    ...restrict(dbClient, dbDrivers, umamiHttp),
  },
  // Camada de dados: banco sim, Umami só pelas funções de src/lib/umami/.
  { files: dataLayer, ...restrict(dbDrivers, umamiHttp) },
  // Cliente do Umami: lê o banco só pelas funções de src/lib/data/.
  { files: ["src/lib/umami/**"], ...restrict(dbClient, dbDrivers) },
];

export default config;
