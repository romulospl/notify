// Esquema do banco `stellytics`: tabelas do Better Auth (usuários, sessões, contas e
// verificações) e o modelo de tenants do spec do E2, seção 3
// (docs/specs/e2-tenants-e-controle-de-acesso.md).
// As visões lidas pelo gateway e pelo coletor e as permissões dos usuários
// stellytics_ingest e stellytics_collector estão em SQL escrito à mão, em
// drizzle/0002_ingest_views.sql.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["tenant", "operator"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // Operador SCF tem visão global. Só é atribuído por comando de administração (#19).
  role: userRole("role").notNull().default("tenant"),
  ...timestamps,
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    // Sempre nulo: o portal não guarda IP (ver databaseHooks em lib/auth.ts).
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// ---------------------------------------------------------------------------
// Tenants (#16)
// ---------------------------------------------------------------------------

// `pending` fica reservado para o cadastro com aprovação (#49); o MVP usa só
// `active` e `removed`.
export const tenantStatus = pgEnum("tenant_status", ["active", "removed", "pending"]);
export const memberRole = pgEnum("member_role", ["owner", "member"]);

// O Drizzle 0.45 não tem coluna `bytea` pronta.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const tenant = pgTable("tenant", {
  // É o `tenant.id` gravado nas métricas de API.
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  status: tenantStatus("status").notNull().default("active"),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
  // Operador que mudou o status; nulo na criação.
  statusChangedBy: text("status_changed_by").references(() => user.id, { onDelete: "set null" }),
  statusReason: text("status_reason"),
  ...timestamps,
});

export const tenantMember = pgTable(
  "tenant_member",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull().default("member"),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    // D1: cada usuário pertence a um único tenant. Retirar este índice libera
    // vários tenants por usuário sem mudar o resto do modelo.
    uniqueIndex("tenant_member_user_id_key").on(t.userId),
  ],
);

export const site = pgTable(
  "site",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    name: text("name").notNull(),
    domain: text("domain").notNull(),
    // ID do site no Umami; é o que o script de rastreamento envia.
    umamiWebsiteId: uuid("umami_website_id").notNull().unique(),
    createdAt: timestamps.createdAt,
    // Site arquivado para de receber eventos e some dos painéis.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [unique("site_tenant_id_domain_key").on(t.tenantId, t.domain)],
);

export const apiService = pgTable(
  "api_service",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    // Nome mostrado nos painéis. D5: o `service.name` enviado pelo cliente é ignorado.
    name: text("name").notNull(),
    createdAt: timestamps.createdAt,
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    unique("api_service_tenant_id_name_key").on(t.tenantId, t.name),
    // Alvo da chave estrangeira composta de `ingest_key`.
    unique("api_service_id_tenant_id_key").on(t.id, t.tenantId),
  ],
);

export const ingestKey = pgTable(
  "ingest_key",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiServiceId: uuid("api_service_id").notNull(),
    // Repetido para o coletor resolver o tenant sem junção. A chave estrangeira
    // composta garante que é o mesmo tenant do serviço.
    tenantId: uuid("tenant_id").notNull(),
    // Parte pública da chave `ntf_<prefixo>_<segredo>` (spec, seção 5).
    prefix: text("prefix").notNull().unique(),
    // SHA-256 da chave completa. A chave em si nunca é gravada.
    keyHash: bytea("key_hash").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamps.createdAt,
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Atualizado no máximo uma vez por dia.
    lastUsedOn: date("last_used_on"),
  },
  (t) => [
    foreignKey({
      name: "ingest_key_api_service_fk",
      columns: [t.apiServiceId, t.tenantId],
      foreignColumns: [apiService.id, apiService.tenantId],
    }),
    index("ingest_key_api_service_id_idx").on(t.apiServiceId),
    check("ingest_key_prefix_format", sql`${t.prefix} ~ '^[a-z2-7]{8}$'`),
    check("ingest_key_hash_length", sql`octet_length(${t.keyHash}) = 32`),
  ],
);

// Chave de leitura do SCF (#48, ADR 0006): dá acesso de leitura às métricas
// globais pela API `/api/v1`. Só operador cria. Fica fora das visões de
// stellytics_ingest e stellytics_collector, que não têm permissão nesta tabela.
export const operatorApiKey = pgTable(
  "operator_api_key",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Rótulo dado por quem criou, para saber de quem é cada chave.
    name: text("name").notNull(),
    // Parte pública da chave `nrk_<prefixo>_<segredo>`.
    prefix: text("prefix").notNull().unique(),
    // SHA-256 da chave completa. A chave em si nunca é gravada.
    keyHash: bytea("key_hash").notNull(),
    // A chave só vale enquanto quem a criou for operador.
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamps.createdAt,
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Atualizado no máximo uma vez por dia.
    lastUsedOn: date("last_used_on"),
  },
  (t) => [
    check("operator_api_key_prefix_format", sql`${t.prefix} ~ '^[a-z2-7]{8}$'`),
    check("operator_api_key_hash_length", sql`octet_length(${t.keyHash}) = 32`),
    check("operator_api_key_name_length", sql`char_length(${t.name}) between 1 and 100`),
  ],
);

// Invite to become an SCF operator (ADR 0017). Only the admin script
// (scripts/operator.mjs invite) creates one; the invited person opens the
// emailed link, picks a name and password, and the account is created as an
// operator. Valid for 3 days and used once. A row only exists while the invite
// is pending: accepting, revoking or re-inviting deletes it, and the script
// purges expired ones, so no email stays here after use. The ingestion roles
// cannot see it (0010_operator_invite.sql).
export const operatorInvite = pgTable(
  "operator_invite",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Always lowercase. At most one invite per email.
    email: text("email").notNull().unique(),
    // SHA-256 of the token in the link. The token itself is never stored.
    tokenHash: bytea("token_hash").notNull().unique(),
    createdAt: timestamps.createdAt,
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("operator_invite_hash_length", sql`octet_length(${t.tokenHash}) = 32`),
    check("operator_invite_email_lowercase", sql`${t.email} = lower(${t.email})`),
  ],
);

// Só recebe inserções: um gatilho recusa UPDATE e DELETE (0002_ingest_views.sql
// e 0009_erasure.sql). A única mudança aceita troca actor_user_id pelo marcador
// '[apagado]' na exclusão de conta (#154). Sem chave estrangeira, para o
// registro sobreviver à exclusão do usuário ou do tenant.
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    // Nulo quando a ação vem do script de administração.
    actorUserId: text("actor_user_id"),
    // Ex.: tenant.removed, tenant.reactivated, operator.created, ingest_key.revoked.
    action: text("action").notNull(),
    // Nulo em ações globais.
    tenantId: uuid("tenant_id"),
    // Nunca contém chave, senha nem IP.
    details: jsonb("details").notNull().default({}),
  },
  (t) => [index("audit_log_tenant_id_at_idx").on(t.tenantId, t.at)],
);
