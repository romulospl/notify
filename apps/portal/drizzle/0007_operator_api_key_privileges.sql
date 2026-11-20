-- Written by hand (drizzle-kit generate --custom). #48, ADR 0006.
--
-- operator_api_key stores the hash of the SCF read keys. Only the owner (the
-- portal user) reads and writes. The gateway (stellytics_ingest) and the collector
-- (stellytics_collector) cannot see the table: a read key is never valid
-- for ingestion, and ingestion never sees the SCF keys.
REVOKE ALL ON "operator_api_key" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON "operator_api_key" FROM stellytics_ingest, stellytics_collector;
