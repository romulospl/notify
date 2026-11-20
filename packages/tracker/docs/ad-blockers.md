# Script and endpoints against ad blockers (#23)

The script and the gateway endpoints must not be blocked by the lists that come enabled by default in uBlock Origin. This page records how that is tested, the latest result and the steps to check it by hand in the browser.

## What is tested

Three requests, made by a tenant's page:

| Request | Type | Who makes it |
| --- | --- | --- |
| `GET https://<gateway>/s/vX.Y.Z/n.js` (all versions in `published/sri.json`) | `script` | the tenant's `<script>` tag |
| `POST https://<gateway>/e` | `xmlhttprequest` (`fetch`) | the script, on every event |
| `GET https://<gateway>/c?s=<website-id>` | `xmlhttprequest` (`fetch`) | the script, to get the JS proof challenge |

Each one is evaluated from a third-party page (`www.tenant-site.example.net`, the common case) and from a page on the same domain as the gateway (`www.example.com`).

## Lists

The lists enabled by default in uBlock Origin, downloaded on the spot on every run (nothing is committed):

- EasyList — `https://easylist.to/easylist/easylist.txt`
- EasyPrivacy — `https://easylist.to/easylist/easyprivacy.txt`
- uBlock filters (with the `!#include` lines), privacy, badware, quick-fixes and unbreak — `https://ublockorigin.github.io/uAssets/filters/*.txt`
- Peter Lowe's Ad and tracking server list — `https://pgl.yoyo.org/adservers/`

The Online Malicious URL Blocklist, also enabled by default, is left out: it only has malware domains.

## How it runs

```bash
pnpm --filter @stellytics/tracker check:adblock                    # example host gw.example.com
pnpm --filter @stellytics/tracker check:adblock e.your-domain.org  # also checks a real host
```

The script (`scripts/check-adblock.ts`) uses the network rule matcher of [`@ghostery/adblocker`](https://github.com/ghostery/adblocker) (MPL-2.0), which understands the uBlock Origin and Adblock Plus syntax. Only network rules matter here; cosmetic ones hide page elements and do not affect requests.

The verdict comes from all lists together, as in the browser (an exception in one list applies to the others); when something is blocked, the output shows the rule and the source list. Before it counts, the result goes through controls that must be blocked (`/umami.js` and `/api/collect` on the gateway host and Google's `analytics.js`). If any control passes, the matcher or the lists are broken and the check fails. It also fails if a list comes back empty or does not download.

The `.github/workflows/adblock.yml` workflow runs the check on PRs that touch the script or the gateway routes, on every push to `main` that touches them and once a day. It is kept out of the `ci` aggregator on purpose: the lists change every day, and a new rule must not turn red a PR that has nothing to do with it. A failure with no code change means a new rule caught the script or an endpoint: look at the rule in the output and decide between asking for a fix in the list or changing the name.

Each list must turn into at least 20 network rules once parsed; an error or captcha page returned with `200` fails the check instead of passing unnoticed. The check loads the rules from all `!#if` branches (Firefox, mobile etc.), so it is a little stricter than uBlock Origin in a single browser: it may give a false red, never a false green.

## Result

Run of 14 November 2026 (lists: EasyList 202611140151, EasyPrivacy 202611140158, uBlock filters of 9 November 2026, privacy, badware and quick-fixes of 13 November 2026, unbreak of 6 November 2026), matcher `@ghostery/adblocker` 2.20.3:

- **None of the three requests is blocked** on `gw.example.com`, in the two published versions (v1.0.0 and v1.1.0), from a third-party page or from the same domain.
- Umami's default paths are blocked on the same host: `/umami.js` by the rule `/umami.js` and `/api/collect` by the rule `/api/collect|$ping,xhr`. That is why the gateway uses `/s/`, `/e` and `/c`, and relays to Umami's `/api/send` only on the server side.
- Today no default list blocks by subdomain name: `analytics.`, `track.`, `tracking.`, `collect.`, `umami.`, `stats.`, `metrics.`, `telemetry.`, `insights.`, `events.`, `ingest.` and `stellytics.` on `example.com` pass.

## Host recommendation

Use a short, neutral subdomain for the gateway, without `analytics`, `track`, `tracking`, `collect`, `umami`, `stats`, `metrics` or `telemetry` (for example `e.<domain>` or `gw.<domain>`). The default lists do not block these names today, but:

- lists that many people enable beyond the default ones (AdGuard Tracking Protection, DNS filters such as Pi-hole's and NextDNS's) were not tested here and may block by hostname pattern, and these terms would be the first targets;
- a new generic rule in the default lists would catch all tenants at once, and changing the host requires changing the HTML of every site.

The same goes for the registrable domain: it enters the lists as soon as it is associated with tracking, regardless of the subdomain. When choosing the production host, run the check with it as an argument.

## Manual steps with uBlock Origin

To check in the browser, with the local environment (`docker compose up -d --wait`) or with the production gateway:

1. Install uBlock Origin in a clean Firefox or Chrome profile and keep the default lists (in the dashboard, "Filter lists" tab, click "Update now").
2. Register a site in the portal and copy the installation snippet.
3. Serve an HTML page with the snippet on a host different from the gateway (for example `python3 -m http.server 8080` and open `http://localhost:8080`; the JS proof requires HTTPS or `localhost`).
4. Open the uBlock Origin logger (uBO icon → list icon, "Open the logger") and reload the page.
5. Check that `n.js`, `/c?s=...` and `/e` show up without a red background (blocked) and, in the Network tab of the developer tools, that `/e` answered `204`.
6. Check that the pageview shows up in the site's dashboard in the portal.

Write down the date, the browser and the uBlock Origin version when recording the result here.

## Do not use `sendBeacon`

The browser classifies `navigator.sendBeacon` as a request of type `ping`, and EasyPrivacy blocks every third-party `ping` (rule `$ping,3p`). That is why the script sends events with `fetch` and `keepalive: true`, which is of type `xmlhttprequest` and passes. The check shows this case in the informational part of the output. If someone switches the sending to `sendBeacon`, the events of everyone using uBlock Origin disappear.
