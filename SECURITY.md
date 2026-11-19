# Security policy

stellytics receives usage data from several projects (tenants). Vulnerabilities that let someone read another tenant's data, bypass the ingestion key, persist personal data (such as the full IP address) or inflate metrics are treated as a priority.

## How to report a vulnerability

**Do not open a public issue** for vulnerabilities.

Use GitHub private vulnerability reporting: in the repository's **Security** tab, click **Report a vulnerability**. The report is visible only to the maintainers until the fix is published.

Private reporting was enabled on 19 November 2026. Do not publish vulnerability details in public issues.

If possible, include:

- the affected component (portal, tracking script, gateway, collector, infrastructure);
- steps to reproduce and the expected impact;
- the version (commit, script version `/s/vX.Y.Z/` or release tag).

## Response times

| Step | Deadline |
|---|---|
| Acknowledgement | within 3 business days |
| Initial assessment and severity of a potentially critical or high report | within 48 consecutive hours |
| Initial assessment and severity of other reports | within 7 calendar days |
| Fix for critical severity | within 7 calendar days |
| Fix for high severity | within 14 calendar days |
| Fix for medium or low severity | within 90 calendar days |

Deadlines run from receipt of the report or from discovery by the project, and include nights, weekends and holidays; they do not restart after classification. Severity follows CVSS 3.1. These commitments assume the two maintainers, without continuous on-call coverage. The RFP target of 24 hours for critical and high issues remains an external target, not a commitment; we aim to contain critical issues within 72 hours. If no fix is available for a dependency or a deadline is at risk, we apply containment, record the risk and inform the reporter; containment does not count as a fix.

Critical or high security fixes may skip the 14-day dependency waiting period when the risk of waiting outweighs the risk of updating. The exception is specific to the dependency and version, recorded and reviewed in the PR, with the tests and signed release described in the [runbook](docs/runbooks/vulnerabilidades.md). After the fix is published, we publish a GitHub advisory and credit the reporter, if they wish.

## Supported versions

| Component | Supported |
|---|---|
| Hosted platform (`main`) | Yes, always the version in production |
| Tracking script | The latest version of each major version. Published versions are immutable: fixes ship in a new version, and affected tenants are notified |
| Older repository releases | No |

## Scope

Out of scope: attacks that require physical access or already compromised tenant credentials, volumetric denial of service, and automated scanner reports without proof of impact.
