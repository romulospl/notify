CREATE TABLE "operator_invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operator_invite_email_unique" UNIQUE("email"),
	CONSTRAINT "operator_invite_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "operator_invite_hash_length" CHECK (octet_length("operator_invite"."token_hash") = 32),
	CONSTRAINT "operator_invite_email_lowercase" CHECK ("operator_invite"."email" = lower("operator_invite"."email"))
);
--> statement-breakpoint
-- Added by hand (ADR 0017): like operator_api_key (0007), only the portal user
-- reads and writes invites. The gateway and the collector cannot see them.
REVOKE ALL ON "operator_invite" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON "operator_invite" FROM stellytics_ingest, stellytics_collector;
