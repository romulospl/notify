-- Written by hand (drizzle-kit generate --custom). E5 spec, section 4 (#33).
--
-- API metrics: api_metric_1m (written by the collector), api_metric_1h and
-- api_metric_1d (rolled up by the #34 job). All three have the same columns,
-- are partitioned by month on bucket_start and have a default partition, so
-- a point is never rejected.
--
-- duration_buckets counts the durations in the 15 buckets of the spec (D2),
-- with the upper bounds, in seconds, from the OpenTelemetry recommendation for
-- http.server.request.duration and a last bucket above 10 s.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_metric_1m', 'api_metric_1h', 'api_metric_1d'] LOOP
    EXECUTE format($sql$
      CREATE TABLE %1$I (
        bucket_start timestamptz NOT NULL,
        tenant_id uuid NOT NULL,
        api_service_id uuid NOT NULL,
        route text NOT NULL CHECK (octet_length(route) BETWEEN 1 AND 256),
        method text NOT NULL CHECK (octet_length(method) BETWEEN 1 AND 16),
        status_code smallint NOT NULL CHECK (status_code BETWEEN 0 AND 999),
        request_count bigint NOT NULL CHECK (request_count >= 0),
        duration_sum double precision NOT NULL CHECK (duration_sum >= 0),
        duration_buckets bigint[] NOT NULL CHECK (cardinality(duration_buckets) = 15),
        PRIMARY KEY (tenant_id, api_service_id, route, method, status_code, bucket_start)
      ) PARTITION BY RANGE (bucket_start)$sql$, t);
    EXECUTE format('CREATE TABLE %I PARTITION OF %I DEFAULT', t || '_default', t);
    -- Dashboards: a tenant's period, filtered afterwards by service and route.
    EXECUTE format('CREATE INDEX %I ON %I (tenant_id, bucket_start)', t || '_tenant_time', t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- Upper bounds of the duration buckets, in seconds (spec, D2).
CREATE FUNCTION api_metric_bounds() RETURNS double precision[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN ARRAY[0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10]::double precision[];
--> statement-breakpoint

-- Adds two bucket arrays position by position. Used in the collector's
-- ON CONFLICT and in the aggregate below.
CREATE FUNCTION api_metric_add_buckets(a bigint[], b bigint[]) RETURNS bigint[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN CASE
  WHEN a IS NULL THEN b
  WHEN b IS NULL THEN a
  ELSE ARRAY(SELECT x + y FROM unnest(a, b) AS u(x, y))
END;
--> statement-breakpoint

-- Sums the buckets of several rows: api_metric_sum_buckets(duration_buckets).
CREATE AGGREGATE api_metric_sum_buckets(bigint[]) (
  SFUNC = api_metric_add_buckets,
  STYPE = bigint[],
  PARALLEL = SAFE
);
--> statement-breakpoint

-- Percentile q (0 to 1) from the buckets, interpolating linearly inside the
-- bucket where it falls. In the last bucket (above 10 s) it returns 10. Null
-- with no requests.
CREATE FUNCTION api_metric_quantile(buckets bigint[], q double precision) RETURNS double precision
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  bounds double precision[] := api_metric_bounds();
  total bigint;
  target double precision;
  acc bigint := 0;
  lower double precision := 0;
BEGIN
  IF buckets IS NULL OR q IS NULL OR q < 0 OR q > 1 THEN
    RETURN NULL;
  END IF;
  SELECT sum(b) INTO total FROM unnest(buckets) AS b;
  IF total IS NULL OR total = 0 THEN
    RETURN NULL;
  END IF;
  target := q * total;
  FOR i IN 1 .. cardinality(buckets) LOOP
    IF buckets[i] > 0 AND acc + buckets[i] >= target THEN
      IF i > cardinality(bounds) THEN
        RETURN bounds[cardinality(bounds)];
      END IF;
      RETURN lower + (bounds[i] - lower) * (target - acc) / buckets[i];
    END IF;
    acc := acc + buckets[i];
    IF i <= cardinality(bounds) THEN
      lower := bounds[i];
    END IF;
  END LOOP;
  RETURN bounds[cardinality(bounds)];
END
$$;
--> statement-breakpoint

-- Creates the monthly partitions (UTC) for the current month and the next
-- `months` in the three tables. If the default partition already has rows for
-- the month (the job ran late), they are moved to the new partition.
-- Idempotent; the #34 job calls it every day.
CREATE FUNCTION api_metric_ensure_partitions(months integer DEFAULT 2) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  t text;
  part text;
  lo timestamptz;
  hi timestamptz;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_metric_1m', 'api_metric_1h', 'api_metric_1d'] LOOP
    FOR m IN 0 .. months LOOP
      lo := (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => m)) AT TIME ZONE 'UTC';
      hi := (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => m + 1)) AT TIME ZONE 'UTC';
      part := t || '_p' || to_char(lo AT TIME ZONE 'UTC', 'YYYYMM');
      CONTINUE WHEN to_regclass(part) IS NOT NULL;
      EXECUTE format('CREATE TABLE %I (LIKE %I INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', part, t);
      EXECUTE format(
        'WITH moved AS (DELETE FROM %I WHERE bucket_start >= $1 AND bucket_start < $2 RETURNING *) '
        'INSERT INTO %I SELECT * FROM moved', t || '_default', part) USING lo, hi;
      EXECUTE format('ALTER TABLE %I ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)', t, part, lo, hi);
    END LOOP;
  END LOOP;
END
$$;
--> statement-breakpoint
SELECT api_metric_ensure_partitions(2);
--> statement-breakpoint

-- Privileges (spec, section 4). The collector only writes the 1-minute bucket,
-- through INSERT ... ON CONFLICT DO UPDATE, which also requires SELECT on the
-- columns it reads. The rollups and the maintenance belong to the owner (stellytics).
REVOKE ALL ON api_metric_1m, api_metric_1h, api_metric_1d FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON api_metric_1m TO stellytics_collector;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION api_metric_ensure_partitions(integer) FROM PUBLIC;
