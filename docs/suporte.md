# Support process

Reference: [issue #52](https://github.com/romulospl/stellytics/issues/52). Dione and Rômulo, the repository's creators, are responsible for support. The commitment is to resolve requests within **10 business days**. A first response within 5 business days is a tracked target; support hours are still to be defined.

## Intake and triage

- For questions and failures without sensitive information, use the [project issues](https://github.com/romulospl/stellytics/issues) with the existing templates. Do not post credentials, personal data or vulnerability details.
- Vulnerabilities follow their own deadlines and the private channel in [SECURITY.md](../SECURITY.md), not this flow.
- At triage, record the link, requester, opening date and time in UTC, owner, priority, description, next step and deadline. Acknowledge the request and ask for missing information without disclosing sensitive data.

## Proposed measurement

A first response is a human reply that acknowledges the request and states the next step; an automatic message does not count. Resolution is the confirmation of a fix, or a reasoned answer that concludes the request, communicated to the requester. Closing an issue without communicating the outcome does not count as resolution.

Clocks start at receipt. Business days use the `America/Los_Angeles` time zone, including daylight saving changes, and exclude Saturdays, Sundays and observed US federal holidays. Day 1 is the first full business day after receipt: a request received at 23:59 on Friday (or at 09:00 on Friday) has Monday as day 1, so the 5-day first-response target ends at the close of the following Friday, and the 10-day deadline at the close of the Friday after that (without holidays). Record the start and end of any wait for information from the requester or a third party. Do not discount those waits until a pause rule is approved and published. Reopened requests keep their history and are tracked again; they do not erase the time of the previous resolution.

Review the queue on every support day, flag deadlines at risk and record blockers and communication. In the monthly report, give the number of requests received and resolved, times per request or their distribution, targets met and pending requests. Do not publish private information. The report template is in [relatorios/modelo-sla.md](relatorios/modelo-sla.md).
