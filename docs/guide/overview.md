# Overview

stellytics gives Stellar ecosystem projects web and API analytics from one shared, open-source platform. No cookies, no full IPs, and every project is measured the same way.

## Why it exists

Stellar Community Fund reviewers rely on usage numbers that each project reports about itself. stellytics is one analytics service run for the ecosystem, so the numbers come from the same pipeline for everyone and can be compared.

## Two layers, one platform

- **Web analytics:** page views, visitors, referrers, countries, devices, custom events and Stellar Wallets Kit connections, from one small script.
- **API analytics:** requests, status codes and p50/p95 latency per normalized route, from the OpenTelemetry metrics your API already produces.

You can use only one of them, or both.

## Who sees what

- Each project's data is kept apart from every other project's.
- **SCF operators** can read every project's numbers, side by side, through the [read API](read-api.md).
- This version of the portal is a public, read-only demo: open `/demo` to see the [dashboards](dashboards.md).

## Privacy by default

- No cookies and no browser storage on your visitors.
- The IP is truncated before anything is stored.
- Traces, spans and logs from your API are dropped; only counts and latency per route are kept.

Details in [Data collected](data-collected.md).

## Next

Start with the [Quickstart](quickstart.md).
