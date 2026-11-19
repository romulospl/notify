# Validation script for the tenant onboarding guide (#43)

This script has not been run yet. It was written from the guide, issues #43, #45 and #46, and the repository. Its companion for the deploy guide is [`deploy.md`](deploy.md).

## What it is for

Issue [#43](https://github.com/romulospl/stellytics/issues/43) has two acceptance criteria: "Covers web and API" and "Validated with a real pilot". The second depends on pilots [#45](https://github.com/romulospl/stellytics/issues/45) (three web analytics pilots) and [#46](https://github.com/romulospl/stellytics/issues/46) (one API analytics pilot). This script is what each pilot fills in while following the guide, and the report in section 6 is the evidence that stays in the repository for the criterion.

The script assumes the guide with script `v1.5.0`, prior approval and `<collector>` as a host. If the guide moves to a newer version, replace `v1.5.0` with it and its hash from `packages/tracker/published/sri.json`.

Section references below point to the numbered sections of the guide; "2.3" means item 3 of section 2.

## 1. Rules for running it

1. The pilot follows **only the guide** ([`docs/onboarding-de-tenant.md`](../onboarding-de-tenant.md)). The person observing takes notes; they do not explain or fix anything live. If the pilot gets stuck and needs help, the help is recorded (step, what was said, how long it took).
2. At the start, record the **guide commit** used (`git rev-parse HEAD`) and the instance address. The result only holds for that version of the guide.
3. Mark each step: **OK** (done without help), **OK with help** (needed help; becomes a finding), **Failed** (could not do it even with help) or **N/A** (does not apply to the pilot).
4. Note the **UTC time** of every step that involves waiting (email, approval, data in the dashboard). The guide gives some time limits; the script checks whether they hold.
5. **Do not record secrets or personal data** in the report: the ingest key appears only masked (`ntf_abcd1234_***`), emails and people's names are left out, screenshots crop anything that identifies visitors. The Website ID and project name only go in if the pilot agrees to publish them.
6. Steps marked ● are **required** for the validation; the others are optional and go in the report if done.

## 2. Before starting (for whoever runs the script)

| Item | Value |
|---|---|
| Instance (portal, `<gateway>`, `<collector>`) | |
| Guide commit | |
| Does the instance require prior approval (`signup_approval`)? | yes / no |
| Operator who approves and provides the addresses | |
| Pilot (project, web or API, SCF award, contact person) | |
| Start date and time (UTC) | |

## 3. Common steps (web and API)

| ID | What to do (guide section) | Expected result | Result | Notes and time (UTC) |
|---|---|---|---|---|
| C1 ● | Have the portal address, `<gateway>` and `<collector>` from the operator (Before you start) | The pilot knows whom to ask and gets all three | | |
| C2 ● | Open `/sign-up` and register name, email and a password of 12 characters or more (2.1) | The portal accepts it and mentions the email | | |
| C3 ● | Receive the confirmation email (2.2). Note how long it took | Arrives within minutes; the link is valid for 24 hours | | |
| C4 ● | Open the confirmation link (2.2) | Signed in and taken to the project (to be confirmed) | | |
| C5 | If the instance requires approval: see the waiting screen and wait for approval (2.3). Note how the pilot found out it was approved | `/dashboard` as the waiting screen; no notification email (to be confirmed) | | |
| C6 ● | In `/onboarding`, name the project (2.3) | Project created, pilot is `owner` | | |
| C7 ● | Open `/dashboard` (2.4) | Count of sites and services, with links to `/sites` and `/services` | | |
| C8 | Optional: `/forgot-password` (2) | Email with a single-use link, valid for 30 minutes | | |

## 4. Web pilot (#45)

Prerequisite: the pilot's site served over HTTPS and permission to edit the `<head>`.

| ID | What to do (guide section) | Expected result | Result | Notes and time (UTC) |
|---|---|---|---|---|
| W1 ● | In `/sites`, enter **Name** and **Domain** and add (3.1) | The site shows in the table with a **Website ID** (UUID) | | |
| W2 ● | Pick the snippet for the site type (static HTML, SPA or Next.js) and replace `<gateway>` and `<website-id>` (3.2) | Tag built with no doubt about where the values go | | |
| W3 ● | Check the hash: `curl -fsS https://<gateway>/s/v1.5.0/n.js \| openssl dgst -sha384 -binary \| openssl base64 -A` and compare with the value after `sha384-` in `integrity` (3.2, 3.3) | Equal to the one in `packages/tracker/published/sri.json` (to be confirmed) | | |
| W4 ● | Put the tag in the `<head>` and open a page of the site, with the ad blocker off, in an incognito window (3.2, 3.4) | No `integrity` or `crossorigin` error in the console | | |
| W5 | In the browser Network tab, look at `GET /c` and `POST /e` (3.4) | `GET /c` returns 200 and `POST /e` returns 204. 204 is also returned when the event is discarded, so it alone does not prove the event was stored | | |
| W6 ● | Generate a known number of visits (for example, 5 page views on different pages) and open the dashboard `/sites/[siteId]` (5.1). Note the time until it shows up | Page views appear in the dashboard; the guide gives no time limit, so this script measures it | | |
| W7 | SPA: navigate between 3 routes without reloading. Next.js: navigate with `<Link>` (3.2) | Each route change counts as a page view | | |
| W8 ● | Check the dashboard: Page views, Unique visitors, Average visit duration, Bounce rate, the chart and the Referrers, Countries, Devices and Browsers lists (5.1) | The four numbers and the four lists show up; the change against the previous period shows up | | |
| W9 | Change the period (24 hours to 12 months) and copy the URL with `?period=` (5) | The dashboard changes and the link opens the same period | | |
| W10 ● | Compare the dashboard number with the one generated in W6 | Difference noted and explained (for example, the pilot's own visits, blocking) | | |
| W11 | Cookies and storage: open the browser developer tools, Application tab, and look for a cookie or `localStorage` from the script (7) | No cookie, `localStorage` or `sessionStorage` from the script | | |
| W12 | Optional: `window.stellytics?.event("...", {...})` (3.4.1) | No error; the event shows in the **Custom events** card of the site dashboard (5.1) | | |
| W13 | Optional: `window.stellytics?.wallets(...)` on a site that uses the Stellar Wallets Kit (3.4.1) | No error; only `wallet_selected` and `wallet_disconnected`, shown in the **Wallet connections** card (5.1); a returning visit does not count as a new selection | | |
| W14 | If something failed, look for the cause in the common-problems table (6) | The cause was in the table, or the table did not help (note it) | | |

Evidence for #45: a screenshot of the dashboard with real page views from the pilot's site (period and time visible, no data identifying visitors), plus the identification of the project and of the SCF award, which #45 asks for.

## 5. API pilot (#46)

Prerequisite: an API that already exports telemetry with the OpenTelemetry SDK or an OTel Collector.

| ID | What to do (guide section) | Expected result | Result | Notes and time (UTC) |
|---|---|---|---|---|
| A1 ● | In `/services`, enter **Service name** and create (4.1) | The portal creates the service and the first ingest key | | |
| A2 ● | Copy the `ntf_...` key from the "Copy your ingest key now" notice and store it in a secrets manager (4.1) | The key is shown once; format `ntf_<8 characters>_<secret>` | | |
| A3 | In `/services/[serviceId]/keys`, look at prefix, date and status (4.1) | **Last used** column shows "Never" | | |
| A4 ● | Pick SDK (4.3) or Collector (4.4). Record the language and SDK version, or the Collector version | Dual-export configured without taking the current APM offline | | |
| A5 | If Collector: use `STELLYTICS_OTLP_ENDPOINT=https://<collector>` and check the exporter name for the Collector version (4.4) | Collector starts with no configuration error; the exporter name matches the version (to be confirmed: `otlp_http` from v0.164.0, `otlphttp` before) | | |
| A6 ● | Check the API sends the `http.server.request.duration` histogram (or HTTP server spans) with `http.request.method`, `http.response.status_code` and, if possible, `http.route` (4.2) | Signal and attributes checked | | |
| A7 | Check the endpoint without a key: `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' https://<collector>/v1/metrics` (4.2) | 401 (to be confirmed) | | |
| A8 ● | Generate traffic on the API and open `/services/[serviceId]` (4.5, 5.2). Note the time until it shows up | Requests show up within 1 to 2 minutes | | |
| A9 | If "No requests in this period yet" appears, follow the list in section 4.5 and the table in section 6 | The cause was in the guide, or the guide did not help (note it) | | |
| A10 | Check **Last used** in `/services/[serviceId]/keys` (4.1) | Today's date in UTC; it may take a few moments | | |
| A11 ● | Check the dashboard: Requests, Server errors (5xx), Median latency (p50), p95 latency, Endpoints and Status codes (5.2) | All blocks have data from the traffic generated | | |
| A12 ● | Compare the dashboard request count with the pilot's APM count over the same UTC interval | Difference noted as a percentage and explained (4.2: sampled traces count fewer) | | |
| A13 | Without `http.route`, check whether routes show up normalized (`{id}`, `{uuid}`, `{address}`, `{hash}`) and whether there is `{other}` (4.2) | Readable routes; `{other}` only above 500 routes per service per day | | |
| A14 | Rotate the key without losing data: create the new one, update the API, revoke the old one (4.1) | Dashboard keeps receiving; the revoked key returns 401 | | |
| A15 | Check the API does not send personal data in attributes (4.2) | No attribute carries personal data | | |

Evidence for #46: a screenshot of the service dashboard with real requests from the pilot's API (period and time visible) and the comparison from A12, plus the identification of the project.

## 6. Report template

Copy to `docs/validation/reports/onboarding-<pilot>-<YYYY-MM-DD>.md` or to a comment on issue #45 or #46. Fill in only what the pilot agreed to publish.

```markdown
# Validation report: tenant onboarding

- Pilot: <project name, or "anonymous">
- Type: web (#45) | API (#46)
- SCF award (web only, if public): <round or program>
- Instance: <portal>
- Guide validated: commit <sha> of docs/onboarding-de-tenant.md
- Script: commit <sha> of docs/validation/onboarding-de-tenant.md
- Period: <start UTC> to <end UTC>
- Observer: <name>

## Result

| Required steps | OK | OK with help | Failed |
|---|---|---|---|
| C1 to C7, W1 to W10 (web) or A1 to A12 (API) | n | n | n |

Conclusion: validated | validated with caveats | not validated
Total time from sign-up to the first data in the dashboard: <hh:mm>

## Steps

(Paste the filled step table, without keys, emails or people's names.)

## Findings in the guide

| # | Step | Guide excerpt | Problem | Severity (high, medium, low) | Proposed fix |
|---|---|---|---|---|---|

## Help received

| Step | What the pilot asked | What was answered | Already in the guide? |
|---|---|---|---|

## Evidence

- Dashboard screenshot: <file or link>, period <start> to <end> UTC, no visitor data
- Comparison with the pilot's APM (API only): <dashboard count> vs <APM count> (<difference in %>)
- Information the pilot agreed to publish: <list>

## Pilot's opinion

- Guide clarity, from 1 to 5:
- Where they got stuck or doubtful:
- A term they did not understand:
- What was missing:
```

## 7. How the result feeds the #43 criterion

Proposal, for the maintainers to confirm:

1. The criterion "Validated with a real pilot" counts as met when there is at least one web pilot report (#45) and one API pilot report (#46), each with all required steps (●) marked **OK**, for the current version of the guide.
2. A step marked **OK with help** counts as a guide failure: it becomes a finding, produces a fix PR, and the step is repeated (by the same pilot or another) before it counts.
3. Each finding becomes a fix in the guide and goes into the next report, so the validation closes the loop.
4. The reports stay in the repository, so #43 and epic #7 can point to the evidence.

## 8. Known limits

- No step has been executed. The "expected results" come from the text of the guide and the code; those marked "to be confirmed" depend on a real instance.
- The English portal labels (Name, Domain, Website ID, Service name, Ingest keys, Last used, Never, "No requests in this period yet", "Top 100 of N") have not all been checked in the code; only "Copy your ingest key now. It won't be shown again" and "Web analytics is unavailable right now" have been.
- The time until data shows up in the web dashboard is not in the guide; step W6 measures it.
