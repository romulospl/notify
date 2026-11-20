// Schema of the `stellytics` database: Better Auth tables (users, sessions, accounts
// and verifications) and the tenant model from the E2 spec, section 3
// (docs/specs/e2-tenants-and-access-control.md).
// The views read by the gateway and the collector and the privileges of the
// stellytics_ingest and stellytics_collector users are in hand-written SQL, in
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
  // The SCF operator has a global view. Only assigned by the administration command (#19).
  role: userRole("role").notNull().default("tenant"),
  ...timestamps,
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    // Always null: the portal does not store the IP (see databaseHooks in lib/auth.ts).
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

// `pending` is reserved for sign-up with approval (#49); the MVP uses only
// `active` and `removed`.
export const tenantStatus = pgEnum("tenant_status", ["active", "removed", "pending"]);
export const memberRole = pgEnum("member_role", ["owner", "member"]);

// Drizzle 0.45 has no ready-made `bytea` column.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const tenant = pgTable("tenant", {
  // It is the `tenant.id` written in the API metrics.
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  status: tenantStatus("status").notNull().default("active"),
  statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
  // Operator who changed the status; null on creation.
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
    // D1: each user belongs to a single tenant. Dropping this index allows
    // several tenants per user without changing the rest of the model.
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
    // The site's ID in Umami; it is what the tracking script sends.
    umamiWebsiteId: uuid("umami_website_id").notNull().unique(),
    createdAt: timestamps.createdAt,
    // An archived site stops receiving events and disappears from the dashboards.
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
    // Name shown on the dashboards. D5: the `service.name` sent by the client is ignored.
    name: text("name").notNull(),
    createdAt: timestamps.createdAt,
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    unique("api_service_tenant_id_name_key").on(t.tenantId, t.name),
    // Target of the composite foreign key of `ingest_key`.
    unique("api_service_id_tenant_id_key").on(t.id, t.tenantId),
  ],
);

export const ingestKey = pgTable(
  "ingest_key",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiServiceId: uuid("api_service_id").notNull(),
    // Repeated so the collector resolves the tenant without a join. The composite
    // foreign key guarantees it is the same tenant as the service's.
    tenantId: uuid("tenant_id").notNull(),
    // Public part of the `ntf_<prefix>_<secret>` key (spec, section 5).
    prefix: text("prefix").notNull().unique(),
    // SHA-256 of the full key. The key itself is never stored.
    keyHash: bytea("key_hash").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamps.createdAt,
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Updated at most once a day.
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

// SCF read key (#48, ADR 0006): gives read access to the global metrics
// through the `/api/v1` API. Only an operator creates one. It stays out of the
// views of stellytics_ingest and stellytics_collector, which have no privilege
// on this table.
export const operatorApiKey = pgTable(
  "operator_api_key",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Label given by whoever created it, to know whose key each one is.
    name: text("name").notNull(),
    // Public part of the `nrk_<prefix>_<secret>` key.
    prefix: text("prefix").notNull().unique(),
    // SHA-256 of the full key. The key itself is never stored.
    keyHash: bytea("key_hash").notNull(),
    // The key is only valid while whoever created it is an operator.
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamps.createdAt,
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Updated at most once a day.
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

// Insert-only: a trigger rejects UPDATE and DELETE (0002_ingest_views.sql and
// 0009_erasure.sql). The only accepted change replaces actor_user_id with the
// '[erased]' marker on account erasure (#154). No foreign key, so the record
// survives the erasure of the user or the tenant.
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    // Null when the action comes from the administration script.
    actorUserId: text("actor_user_id"),
    // E.g. tenant.removed, tenant.reactivated, operator.created, ingest_key.revoked.
    action: text("action").notNull(),
    // Null for global actions.
    tenantId: uuid("tenant_id"),
    // Never contains a key, a password or an IP.
    details: jsonb("details").notNull().default({}),
  },
  (t) => [index("audit_log_tenant_id_at_idx").on(t.tenantId, t.at)],
);
