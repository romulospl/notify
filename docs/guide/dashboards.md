# Dashboards

What each number on the dashboards means. Open the public demo at `/demo` to see them.

## Periods

- Last 24 hours, 7 days (default), 30 days, 90 days and 12 months.
- All times are **UTC**.
- The period is in the URL (`?period=30d`), so you can share the link.

## Site dashboard

- **Page views, unique visitors, average visit duration and bounce rate**, each compared with the previous period.
- A chart of page views over time.
- **Referrers, countries, devices and browsers.**
- **Custom events:** the 10 most frequent [custom events](custom-events.md).
- **Wallet connections:** wallets chosen and disconnections, when you use the [Wallets Kit](wallets-kit.md) adapter.

Unique visitors are an estimate made without cookies, not a count of people.

## API service dashboard

- **Requests, server errors (5xx), p50 and p95 latency.**
- Charts of requests (with 4xx and 5xx) and latency over time.
- **Endpoints:** the 100 busiest routes, with errors and latency.
- **Status codes:** the distribution by code.

## How to read the numbers

- **Latency is approximate.** It is stored in buckets from 5 ms to 10 s. Use it for trends, not for exact milliseconds.
- **Delay:** new API data shows up within 1 to 2 minutes.
- **Retention:** web events for 183 days; API metrics per minute for 35 days, per hour and day for 25 months.
