// Periods of the web dashboard (#28). All in UTC, like the other dates in the
// portal. The period ends now and starts at the beginning of a bucket (hour,
// day or month), so the chart buckets match the ones Umami returns. It is the
// same convention as Umami's own periods: "Last 7 days" is the 6 whole previous
// days plus today up to now, not exactly 168 hours.

export const PERIODS = {
  "24h": { label: "Last 24 hours", unit: "hour", count: 24 },
  "7d": { label: "Last 7 days", unit: "day", count: 7 },
  "30d": { label: "Last 30 days", unit: "day", count: 30 },
  "90d": { label: "Last 90 days", unit: "day", count: 90 },
  "12m": { label: "Last 12 months", unit: "month", count: 12 },
} as const;

export type PeriodKey = keyof typeof PERIODS;
export type PeriodUnit = (typeof PERIODS)[PeriodKey]["unit"];

export const DEFAULT_PERIOD: PeriodKey = "7d";

export type Period = {
  key: PeriodKey;
  label: string;
  unit: PeriodUnit;
  startAt: Date;
  endAt: Date;
  // Start of each bucket, from oldest to newest; the last one contains endAt.
  buckets: Date[];
};

// Value coming from the URL: anything outside the list becomes the default.
export function parsePeriodKey(raw: unknown): PeriodKey {
  return typeof raw === "string" && Object.hasOwn(PERIODS, raw) ? (raw as PeriodKey) : DEFAULT_PERIOD;
}

function startOf(unit: PeriodUnit, d: Date): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (unit === "month") return new Date(Date.UTC(y, m, 1));
  if (unit === "day") return new Date(Date.UTC(y, m, d.getUTCDate()));
  return new Date(Date.UTC(y, m, d.getUTCDate(), d.getUTCHours()));
}

function add(unit: PeriodUnit, d: Date, n: number): Date {
  if (unit === "month") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  return new Date(d.getTime() + n * (unit === "day" ? 86_400_000 : 3_600_000));
}

export function resolvePeriod(key: PeriodKey, now: Date = new Date()): Period {
  const { label, unit, count } = PERIODS[key];
  const last = startOf(unit, now);
  const startAt = add(unit, last, -(count - 1));
  const buckets = Array.from({ length: count }, (_, i) => add(unit, startAt, i));
  return { key, label, unit, startAt, endAt: now, buckets };
}
