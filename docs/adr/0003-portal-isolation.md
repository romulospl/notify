# 0003. Isolation between tenants is the portal's responsibility

- **Status:** Accepted
- **Date:** 13/11/2026
- **Issue:** [#18](https://github.com/romulospl/stellytics/issues/18)
- **Partly changes:** [ADR 0001](0001-base-tool.md) (rationale 3 and first consequence)

## Context

ADR 0001 chose Umami partly because it already has teams and sites, and stated that "isolation starts from something ready-made". It also expected the portal to create a user, team and site in Umami for each tenant.

ADR 0002 changed the picture:

- the portal is the only entry point for tenants and operators;
- Umami is used as a headless engine and stays only on the internal network (issue [#62](https://github.com/romulospl/stellytics/issues/62));
- the portal reads the statistics with a service account that sees all sites;
- the API metrics live in the `stellytics` database, outside Umami.

Under these conditions, Umami's access control is never exercised by a tenant: whoever calls Umami is always the portal, with full access. Isolation needs a clear owner, because it is an RFP evaluation criterion and requires automated tests (issue [#21](https://github.com/romulospl/stellytics/issues/21)).

## Decision

The **portal is solely responsible for isolation between tenants**, both for web data (read from Umami) and for API data (read from the `stellytics` database).

- The tenant is **always resolved from the session**, on the server. No value sent by the client chooses the tenant.
- All data access goes through a **single layer**, which only accepts an access context created from the session. The ID of a site in Umami is only obtained through this layer, after checking that the site belongs to the tenant.
- The portal creates **only sites** in Umami, all owned by the service account. It does not create users or teams in Umami.
- Umami is not reachable from outside the internal network.

The detailed contract is in the [E2 spec](../specs/e2-tenants-and-access-control.md).

## Alternatives considered

| Alternative | Pros | Cons |
|---|---|---|
| One user and one team in Umami per tenant, with the portal reading with each tenant's token | A second barrier: Umami itself would refuse reading another tenant | The portal would have to store one Umami credential per tenant; two user registries to keep in sync; does not cover the API metrics |
| PostgreSQL Row-Level Security in the `stellytics` database | A barrier in the database, independent of the portal's code | Requires setting the tenant on each pool connection; does not cover the Umami data. It can be added later, without changing this decision |
| Exposing the Umami interface to tenants | Ready-made web dashboard | Goes against ADR 0002; gives no comparative dashboard, no API dashboard and no open sign-up |

## Consequences

- ADR 0001's argument that isolation starts from Umami's team model no longer holds for reading. The other reasons for choosing Umami remain.
- A bug in the portal can expose another tenant's data, with no second barrier. For that reason:
  - the single layer is enforced by a lint rule;
  - the isolation suite (#21) runs in CI and grows with each new dashboard;
  - the gateway and the collector use their own database users, with minimum permission.
- Sign-up becomes simpler: one site in Umami per tenant site, without syncing users.
- The Umami service account becomes a critical credential. It stays only in the portal, in an environment variable.
- Issue [#58](https://github.com/romulospl/stellytics/issues/58) creates only sites in Umami.
