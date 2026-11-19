// No `next build` os módulos são avaliados sem as variáveis de produção.
// Nessa fase usamos valores inertes; nada conecta ao banco durante o build.
const isBuild = process.env.NEXT_PHASE === "phase-production-build";

const buildPlaceholders: Record<string, string> = {
  DATABASE_URL: "postgresql://build:build@127.0.0.1:1/build",
  BETTER_AUTH_SECRET: "build-placeholder-secret-not-used-at-runtime",
  UMAMI_API_KEY: "umami_build-placeholder-not-used-at-runtime",
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
  // Umami interno, lido só por src/lib/umami/ (ADR 0003).
  get umamiUrl() {
    return (process.env.UMAMI_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
  },
  // Public address of the web gateway, used in the installation tag shown on
  // each site's page. In production it is https://INGEST_HOST (prod.yaml).
  get ingestUrl() {
    return (process.env.INGEST_URL ?? "http://localhost:3002").replace(/\/$/, "");
  },
  // Cadastro com aprovação prévia (#49, ADR 0007): com `true` ou `1`, projeto
  // novo nasce `pending` até um operador aprovar. Desligado por padrão. Lido a
  // cada cadastro; mudar o valor exige reiniciar o portal.
  get signupApproval() {
    return ["1", "true"].includes((process.env.SIGNUP_APPROVAL ?? "").trim().toLowerCase());
  },
  // SMTP para os e-mails de confirmação e de redefinição de senha (#60), ex.:
  // smtp://mailpit:1025 no Compose ou smtps://usuario:senha@host:465 em produção.
  // Lido só ao enviar, então o portal sobe sem ele.
  get smtpUrl() {
    return required("SMTP_URL");
  },
  get mailFrom() {
    return process.env.MAIL_FROM ?? "stellytics <no-reply@stellytics.localhost>";
  },
  // Chave de API da conta de serviço (scripts/umami-service-account.mjs).
  // Lida só quando o portal chama o Umami, então o portal sobe sem ela.
  get umamiApiKey() {
    return required("UMAMI_API_KEY");
  },
};
