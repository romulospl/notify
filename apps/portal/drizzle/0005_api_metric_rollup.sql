-- Written by hand (drizzle-kit generate --custom). E5 spec, section 5 (#34).
--
-- Rollup of api_metric_1m into api_metric_1h and api_metric_1d and retention
-- by partition. The caller is the services/rollup service, as stellytics (owner
-- of the tables), through the api_metric_maintain() function.

-- Rolls up the closed hours starting at `since`: those that ended at least
-- 5 minutes before `until` (late batches from the collector). Then it rebuilds
-- the days of those hours from api_metric_1h. The ON CONFLICT replaces the
-- values with the recomputed sum, so running again over the same period gives
-- the same result. All in UTC.
CREATE FUNCTION api_metric_rollup(since timestamptz, until timestamptz DEFAULT now()) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  lo_hour timestamptz := date_trunc('hour', since, 'UTC');
  hi_hour timestamptz := date_trunc('hour', until - interval '5 minutes', 'UTC');
  lo_day timestamptz;
  hi_day timestamptz;
BEGIN
  IF lo_hour >= hi_hour THEN
    RETURN;
  END IF;

  INSERT INTO api_metric_1h AS m (bucket_start, tenant_id, api_service_id, route, method, status_code,
                                  request_count, duration_sum, duration_buckets)
  SELECT date_trunc('hour', bucket_start, 'UTC'), tenant_id, api_service_id, route, method, status_code,
         sum(request_count), sum(duration_sum), api_metric_sum_buckets(duration_buckets)
  FROM api_metric_1m
  WHERE bucket_start >= lo_hour AND bucket_start < hi_hour
  GROUP BY 1, 2, 3, 4, 5, 6
  ON CONFLICT (tenant_id, api_service_id, route, method, status_code, bucket_start) DO UPDATE SET
    request_count = EXCLUDED.request_count,
    duration_sum = EXCLUDED.duration_sum,
    duration_buckets = EXCLUDED.duration_buckets;

  -- The current day stays partial up to the last closed hour and is rebuilt on every run.
  lo_day := date_trunc('day', lo_hour, 'UTC');
  hi_day := date_trunc('day', hi_hour - interval '1 hour', 'UTC') + interval '1 day';

  INSERT INTO api_metric_1d AS m (bucket_start, tenant_id, api_service_id, route, method, status_code,
                                  request_count, duration_sum, duration_buckets)
  SELECT date_trunc('day', bucket_start, 'UTC'), tenant_id, api_service_id, route, method, status_code,
         sum(request_count), sum(duration_sum), api_metric_sum_buckets(duration_buckets)
  FROM api_metric_1h
  WHERE bucket_start >= lo_day AND bucket_start < hi_day
  GROUP BY 1, 2, 3, 4, 5, 6
  ON CONFLICT (tenant_id, api_service_id, route, method, status_code, bucket_start) DO UPDATE SET
    request_count = EXCLUDED.request_count,
    duration_sum = EXCLUDED.duration_sum,
    duration_buckets = EXCLUDED.duration_buckets;
END
$$;
--> statement-breakpoint

-- Retention (D3): drops the whole monthly partitions whose end is older
-- than 35 days (api_metric_1m) or 25 months (api_metric_1h and
-- api_metric_1d). It never deletes row by row nor the default partition.
-- Returns the names of the dropped partitions.
CREATE FUNCTION api_metric_drop_partitions(at timestamptz DEFAULT now()) RETURNS SETOF text
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  hi timestamptz;
  keep_after timestamptz;
BEGIN
  FOR r IN
    SELECT p.relname AS parent, c.relname AS child
    FROM pg_inherits i
    JOIN pg_class p ON p.oid = i.inhparent
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE p.relname IN ('api_metric_1m', 'api_metric_1h', 'api_metric_1d')
      AND c.relname ~ '_p[0-9]{6}$'
    ORDER BY c.relname
  LOOP
    hi := (to_date(right(r.child, 6), 'YYYYMM') + interval '1 month')::timestamp AT TIME ZONE 'UTC';
    keep_after := CASE WHEN r.parent = 'api_metric_1m' THEN at - interval '35 days' ELSE at - interval '25 months' END;
    IF hi <= keep_after THEN
      EXECUTE format('DROP TABLE %I', r.child);
      RETURN NEXT r.child;
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint

-- What the rollup service runs on every execution: future partitions,
-- rollup of the closed hours in `lookback` and retention.
CREATE FUNCTION api_metric_maintain(lookback interval DEFAULT interval '2 days') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM api_metric_ensure_partitions(2);
  PERFORM api_metric_rollup(now() - lookback);
  PERFORM api_metric_drop_partitions();
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION api_metric_rollup(timestamptz, timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION api_metric_drop_partitions(timestamptz) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION api_metric_maintain(interval) FROM PUBLIC;
