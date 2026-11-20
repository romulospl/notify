// During `next build` the modules are evaluated without the production variables.
// In that phase we use inert values; nothing connects to the database during the build.
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
  throw new Error(`Environment variable ${name} is not set`);
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
  // Internal Umami, read only by src/lib/umami/ (ADR 0003).
  get umamiUrl() {
    return (process.env.UMAMI_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
  },
  // Public address of the web gateway, used in the installation tag shown on
  // each site's page. In production it is https://INGEST_HOST (prod.yaml).
  get ingestUrl() {
    return (process.env.INGEST_URL ?? "http://localhost:3002").replace(/\/$/, "");
  },
  // Public OTLP address of the API collector, shown with each service's ingest
  // keys so the tenant knows where to send metrics. In production it is
  // https://API_HOST (prod.yaml), serving OTLP/HTTP and gRPC on port 443.
  get collectorUrl() {
    return (process.env.COLLECTOR_URL ?? "http://127.0.0.1:4318").replace(/\/$/, "");
  },
  // Sign-up with prior approval (#49, ADR 0007): with `true` or `1`, a new
  // project starts as `pending` until an operator approves it. Off by default.
  // Read on every sign-up; changing the value requires restarting the portal.
  get signupApproval() {
    return ["1", "true"].includes((process.env.SIGNUP_APPROVAL ?? "").trim().toLowerCase());
  },
  // Public demo (/demo, /operator and the tracker tag on the home page):
  // slug of the one tenant those pages read. Empty (the default): the demo
  // shows sample data (src/lib/demo-sample.ts) and the home page carries no tracker.
  get demoTenantSlug() {
    return (process.env.DEMO_TENANT_SLUG ?? "").trim();
  },
  // SMTP for the confirmation and password reset e-mails (#60), e.g.
  // smtp://mailpit:1025 in Compose or smtps://user:password@host:465 in production.
  // Read only when sending, so the portal starts without it.
  get smtpUrl() {
    return required("SMTP_URL");
  },
  get mailFrom() {
    return process.env.MAIL_FROM ?? "stellytics <no-reply@stellytics.localhost>";
  },
  // API key of the service account (scripts/umami-service-account.mjs).
  // Read only when the portal calls Umami, so the portal starts without it.
  get umamiApiKey() {
    return required("UMAMI_API_KEY");
  },
};
