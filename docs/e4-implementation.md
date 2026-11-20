# E4: what was implemented

Record of the implementation of epic [E4 (#4)](https://github.com/romulospl/stellytics/issues/4), web analytics dashboards, started on **14 November 2026**. E4 has no spec of its own: it runs entirely inside the portal and uses contracts that already exist, the isolation of [ADR 0003](decisions.md#0003-portal-isolation) and of section 4 of the [E2 spec](specs/e2-tenants-and-access-control.md), and the Umami 3.4.1 API checked in [ADR 0001](decisions.md#0001-base-tool).

## 1. Status

| Issue | What it is | PR | Commit |
|---|---|---|---|
| [#28 (4.1)](https://github.com/romulospl/stellytics/issues/28) | Tenant web dashboard with the 7 minimum metrics | [#89](https://github.com/romulospl/stellytics/pull/89) | `9755566` |
| [#29 (4.2)](https://github.com/romulospl/stellytics/issues/29) | SCF global web dashboard, with comparison between projects | — | In review |

## 2. #28: tenant web dashboard

**Where:** `/sites/[siteId]` (`apps/portal/src/app/(private)/sites/[siteId]/`). The site name in `/sites` and the "Web analytics" list in `/dashboard` lead to the dashboard.

**What it shows, for the chosen period:**

| Metric | Where it comes from |
|---|---|
| Page views | `/stats` → `pageviews` |
| Unique visitors | `/stats` → `visitors` |
| Average visit duration | `/stats` → `totaltime / visits` |
| Bounce rate | `/stats` → `bounces / visits` |
| Referrers | `/metrics?type=referrer` |
| Country | `/metrics?type=country` |
| Device and browser | `/metrics?type=device` and `?type=browser` |

In addition: the change of each indicator against the previous period of the same length (`comparison` from `/stats`), the page views over the period (`/pageviews`) and the first 10 rows of each list.

**Reading from Umami:** `getSiteDashboard` in `src/lib/umami/stats.ts`. It receives the `TenantContext` and the portal's site ID, checks that the site belongs to the tenant (`getSite`) and only then makes the 6 calls to Umami, in parallel. A site of another tenant or an archived one returns null without any call.

**Choices:**

- **Periods** fixed in `src/lib/period.ts`: last 24 hours (by hour), 7, 30 and 90 days (by day) and 12 months (by month). The default is 7 days, and any value outside the list in the URL becomes the default. The period ends now and starts at the beginning of a bucket, always in **UTC**, like the other dates in the portal: "Last 7 days" is the 6 previous full days plus today up to now, not exactly 168 hours. It is the same convention as Umami's own periods, and the chart subtitle says the current bucket is included. There is no custom period.
- **Empty buckets:** Umami only returns the buckets with data; the portal fills the others with zero, so the chart has one point per hour, day or month.
- **The lists count visitors**, not page views: that is what the `y` of `/metrics` counts in Umami 3.4.1. The column is called "Visitors".
- **Names:** country through `Intl.DisplayNames` (Umami stores the ISO code), browser through a table of Umami's identifiers (`ios` becomes "Safari (iOS)"), with the identifier itself as a fallback.
- **Change:** in percent for page views, visitors and duration; in percentage points for the bounce rate, where going up is bad (red). Without data in the previous period, "No data for the previous period" appears. The colours for good and bad increases always come with an arrow and text.
- **Chart:** columns of a single series, with the colour validated for light and dark modes (`dataviz` skill), a tooltip on mouse hover or keyboard focus and an equivalent table under "Show as table".
- **Removed project** sees only the notice, without calling Umami (E2 spec, section 6). **Umami down** shows a notice on the page; the error detail stays only in the log.

**Tests:**

- `test/web-dashboard.test.ts`: periods, formatting, parameters sent to Umami and bucket filling; the rendered page (`renderToStaticMarkup`), checking the 7 metrics, the change, the active period, one column and one table row per bucket; site of another tenant, removed project and Umami down. Checked that removing a list or zeroing a metric on the page makes the test fail;
- `test/isolation.test.ts`: two dashboard cases (#21);
- the fake Umami (`test/fake-umami.ts`) gained `/pageviews` and `/metrics`, in the 3.4.1 format.

**Independent review** by a Codex worker: no isolation failure; the two points raised (the period convention and page tests that did not render the components) were addressed.

**Checked in the browser** with the local Umami 3.4.1 and about 160 test page views: light and dark, desktop and 390px wide, periods of 7 and 30 days and of 12 months.

## 3. #29: SCF global web dashboard

**Where:** `/operator/web` (`apps/portal/src/app/(private)/operator/web/`), with links in the operator header ("Web analytics") and in `/operator`. Whoever is not an operator gets 404.

**What it shows:**

- a table with all **active** projects: sites, page views (with a proportional bar), visitors, average duration and bounce rate, plus the change against the previous period;
- a filter by name or slug, sorting by clicking the header and the same period selector as the tenant dashboard;
- checkboxes to compare 2 to 4 projects side by side, with the 7 metrics (the lists bring the first 5 rows).

Everything through GET (links and forms): it works without JavaScript, and the URL keeps the state, which allows sending a comparison to someone else. The selected projects that the filter hides stay in the comparison.

**Reading from Umami:** `src/lib/umami/overview.ts`.

- `getWebOverview` reads only the `/stats` of each site;
- `compareProjects` makes 5 calls per site of the chosen projects;
- both go through a single limiter, which counts **HTTP calls** (not sites): at most 8 reads from the global dashboards at the same time in the process, adding up the table, the comparison and other operators with the page open;
- the Umami IDs come from `listActiveTenantSites` (`src/lib/data/operator/sites.ts`), never from the URL. An unknown, repeated, removed or pending `tenantId` is discarded before any call.

**Choices:**

- **No ADR was needed:** the table makes one call per site, not six, which fits ADR 0002 (reading through the Umami API) at the scale of the pilots. With hundreds of sites, reading the Umami database directly or storing a summary changes ADR 0002 and becomes a new ADR.
- **A project with several sites sums the sites.** Visitors too, because Umami counts sessions per site: whoever visits two sites of the same project counts twice. In the comparison lists, each site contributes its first 10 rows, so the sum is approximate when an item falls outside the top 10 of some site.
- **A removed or pending project does not appear**, as the E2 spec requires (section 6); the operator can still open it at `/operator/tenants/[tenantId]`. An active project without a site appears with zeros.
- **Partial failure:** if some site of a project does not respond, the whole project appears as "Unavailable" (instead of partial numbers), and the others carry on. The log records only the count.
- **New lint rule:** `src/lib/umami/read.ts` reads by the Umami ID without checking the tenant, so only `src/lib/umami/` can import it, like `http.ts` (E2 spec, section 4). `test/lint-boundaries.test.ts` covers the rule.
- The period selector and the change text became components (`src/components/`), used by both dashboards.

**Tests:** `test/operator-web.test.ts` covers:

- which projects are included and the sum of the sites;
- the partial failure;
- each project receiving the numbers of its own sites (the fake Umami returns different numbers per site);
- the limit of 8 simultaneous calls, measured in the fake Umami, in the table, in the comparison and in the whole page;
- the comparison: summed lists, discarded IDs and the limit of 4 projects;
- the rendered page: filter, sorting, active period, comparison, selection preserved by the filter and the notice with a single project.

The isolation suite gained two cases: the tenant member gets 404 on the global dashboard, and the removed project leaves the list. Checked that removing the active-project filter, or accepting any ID in the comparison, makes the tests fail.

**Independent review** by a Codex worker: no access or URL validation failure. It pointed out two bugs, fixed with tests: the limit counted sites instead of calls (in the comparison, 8 sites became 40 calls), and the filter removed from the comparison the projects it hid.

**Checked in the browser** with two projects with data in the local Umami 3.4.1: comparison, filter, sorting, dark mode and a project whose site disappeared from Umami, which appears as unavailable.

## 4. Limits and pending items

- **No cache:** each opening of the tenant dashboard makes 6 calls to Umami, and that of the global dashboard, one per site. For the pilots this is enough.
- **Custom period and the user's time zone** were left out; everything is UTC.
- Custom events (#50) and filters by page or referrer are left for after the MVP.
