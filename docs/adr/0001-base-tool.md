# 0001. Umami as the base tool for web analytics

- **Status:** Accepted
- **Date:** 13/11/2026
- **Issue:** [#10](https://github.com/romulospl/stellytics/issues/10)

## Context

The Stellar Community Fund RFP "Web and API Analytics for Stellar Ecosystem Projects" requires the platform to be built on **Umami** or **GoatCounter** and the proposal to justify the choice. The justification is one of the evaluation criteria.

RFP requirements that weigh on the choice:

- multi-tenant with strict isolation and a global view for SCF operators;
- API metrics stored in **PostgreSQL**;
- all code under an **OSI**-approved license;
- GDPR compliance without opt-in (no cookies);
- handover to another community team between the 6th and the 12th month of operation;
- a dashboard with page views, unique visitors, referrers, session duration, bounce rate, country, device and browser.

## Decision

Use **Umami**, pinned to version **v3.4.1** (exact image and tag in Docker Compose and in the IaC).

v3.5.0 was published on 12/11/2026, one day before this decision. Following the policy against supply chain attacks, we only adopt a release at least two weeks after it is published. The upgrade to 3.5.x will be made in its own PR, intentionally.

Umami will be used as a **headless engine** (ingestion, storage and statistics API), with as few changes to the original code as possible. The interface for tenants and operators lives in our own portal (see [ADR 0002](0002-architecture-and-stack.md)).

## Comparison

Data gathered on GitHub on 13/11/2026.

| Criterion | Umami | GoatCounter |
|---|---|---|
| License | **MIT** (OSI-approved) | **Modified** EUPL 1.2 (the appendix of compatible licenses was changed). A modified license is not, formally, the license approved by the OSI |
| Language and stack | TypeScript, Next.js 16, React 19, Prisma 7 | Go, single binary |
| Database | **PostgreSQL only** (since v3) | SQLite or PostgreSQL |
| Activity | Monthly releases (v3.3.1 in Aug 2026, v3.4.0 in Sep, v3.4.1 in Oct, v3.5.0 in Nov); last push on 12/11/2026 | Spaced-out releases (v2.5.0 in Dec 2023, v2.6.0 in Jun 2025, v2.7.0 in Dec 2025) |
| Maintainers | A team with 3 main maintainers and many contributors | Essentially one person (about 2,100 commits by the author against fewer than 5 by each other contributor) |
| Community | about 40 thousand stars | about 6 thousand stars |
| Multi-site and teams | Native: `Team`, `TeamUser` and `Website` models | Multi-site, with fewer ready-made team features |
| Statistics API | `/api/websites/{id}/stats` and `/metrics` endpoints, with authentication and API keys (`ApiKey`) | Simpler API |
| Cookies | Does not use them | Does not use them |
| Client IP | Reads the header set in `CLIENT_IP_HEADER`, which makes it possible to deliver the IP already truncated | Its own logic |
| Anti-adblock customization | `TRACKER_SCRIPT_NAME` and `COLLECT_API_ENDPOINT` | Possible, with fewer ready-made options |

## Rationale

1. **License:** MIT is OSI-approved without reservations. GoatCounter's modified EUPL opens a discussion that the RFP does not need to have.
2. **PostgreSQL:** the RFP requires Postgres for the API metrics, and Umami uses only Postgres. A single database simplifies operation, backup and the handover.
3. **Multi-tenant:** teams and sites already exist in Umami's data model and access control, so isolation starts from something ready-made.
4. **Continuity and handover:** Umami has a team of maintainers and frequent releases. GoatCounter depends on one person, which is a risk for 12 months of operation and for the delivery to another team.
5. **Minimum metrics:** Umami already computes views, visitors, visits, bounces and total time, as well as referrers, country, device and browser.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **GoatCounter** | Modified license, a single maintainer and fewer team features. It would only make sense if the priority were minimum hosting cost, which is not the case |
| **Heavy fork of Umami** | Makes security updates harder (the RFP asks for critical and high vulnerabilities to be fixed within 24 h). We prefer the original Umami, with minimal, documented patches |

## Consequences

- Umami **has no open sign-up**: user creation goes through `canCreateUser` and requires an administrator. Self-service sign-up lives in the portal, which creates the user, team and site through the Umami API with a service account.
- Umami **has no comparative dashboard across sites** and no API metrics: both live in the portal.
- Umami has features that **must stay off** for privacy, such as session recording (`SessionReplay`) and heatmaps, and this needs tests that confirm it.
- The IP reaches Umami **already truncated** by the ingestion gateway, through the `CLIENT_IP_HEADER` header. Umami never sees the full IP.
- The original tracking script has no proof of JS execution and no pinned version in the path. We will have our own script, compatible with the `/api/send` payload.
- The Umami version stays pinned and only goes up by PR, after reviewing the changelog.

## To be confirmed during implementation

- ~~That `/api/websites/{id}/stats` and `/metrics` in v3.4.1 return all the minimum metrics in the expected format.~~ **Confirmed in [#28](https://github.com/romulospl/stellytics/issues/28) (14/11/2026)**, against the local Umami 3.4.1 with events sent through `/api/send`: `/stats` returns `pageviews`, `visitors`, `visits`, `bounces` and `totaltime` (the average visit duration is `totaltime / visits` and the bounce rate is `bounces / visits`), plus the previous period of the same length in `comparison`; `/metrics?type=referrer|country|device|browser` returns sorted `{x, y}` lists, in which `y` counts **visitors** (unique sessions), not views, and accepts `limit`; the country comes as an ISO code, and the browser as the `detect-browser` identifier (`chrome`, `ios`, `edge-chromium`). The time series comes from `/pageviews?unit=hour|day|month&timezone=UTC`, with only the buckets that have data. An unknown `type` answers 400.
- ~~That Umami's API keys are enough for the portal's service account, without using the administrator password.~~ **Confirmed in [#58](https://github.com/romulospl/stellytics/issues/58) (13/11/2026):** in v3.4.1 without `CLOUD_MODE`, the API key (`Authorization: Bearer umami_...`) acts as the user who owns it. The service account is an ordinary user (role `user`, not administrator), which creates, lists, reads and deletes its own sites; the `/api/users`, `/api/admin`, `/api/auth` and `/api/me/api-keys` routes refuse the key. The administrator password is used only once, by the `apps/portal/scripts/umami-service-account.mjs` script, and the portal stores only the key. Limit: the key can also create teams (the `user` role has `team:create`); the portal does not use that route (ADR 0003), and only the client in `apps/portal/src/lib/umami/` calls Umami. The CI `compose` job repeats the check.
