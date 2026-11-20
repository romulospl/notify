# Data collected

What stellytics stores, and what it never does.

## From your website visitors

- Website ID, hostname and path (plus only `utm_*` parameters).
- Referrer without query or fragment, page title, language and screen size.
- Country, browser, operating system and device, derived from the truncated IP and the User-Agent.

## Never collected from visitors

- **No cookies**, no `localStorage` or `sessionStorage`, no identifier kept in the browser.
- **No full IP.** The gateway truncates it before anything else (`203.0.113.77` becomes `203.0.113.0`; IPv6 keeps only the first /48).
- No session recording and no heatmaps.

## From your API

- Per minute: normalized route, method, status, request count and latency distribution.
- No IPs, request bodies, users or traces. Traces, spans and logs are dropped by the collector.

## What you control

- Paths, page titles, routes and custom event properties are defined by your project. Keep personal data out of them.
- Because the script uses no cookies, it needs no consent banner by itself. The legal decision is your project's.

The full analysis, including what is still open with legal counsel, is in [the privacy document](../privacy.md).
