# Planning, backlog and project documents

## Backlog

- Issues in `romulospl/stellytics`, grouped in epics E1–E9 (issues #1–#9) and E10 (#63), with sub-issues numbered `[X.Y]` (#10–#62, #64, #65). Each issue has "What to do", acceptance criteria and "Depends on". The `[X.Y]` number is not the execution order: follow "Depends on".
- Board: GitHub Project `romulospl/projects/1`. Items in **Ready** are the MVP code (E1–E6) and the SCF proposal (E10); E7 (documentation), E8 (pilots) and E9 (post-MVP) stay in Backlog.
- Read the exact scope before implementing: `gh issue view <n> -R romulospl/stellytics`.

## Progress

`docs/andamento.md` (summary, commits and next steps) and `docs/e2-implementacao.md`, `docs/e4-implementacao.md`, `docs/e6-implementacao.md` (what was done, choices and pending items). Update them when closing issues.

## Specs and ADRs

- `docs/specs/`: one per epic with a contract between components. The spec fixes the contract (tables, roles, formats); a decision with alternatives goes to an ADR. Read `docs/specs/e2-tenants-e-controle-de-acesso.md` before E2 issues (#16–#21, #58–#60) and `docs/specs/e5-pipeline-de-api.md` before E5 issues (#30–#36). There is no E3 spec.
- `docs/adr/` (index in `docs/adr/README.md`). Read ADRs 0001 and 0002 before proposing stack or structure changes, and 0003 before touching data access. A new architecture decision becomes a new ADR from `docs/adr/template.md`. An accepted ADR is not rewritten: create a new one and mark the old one as superseded.

## Documents to keep up to date

- **Privacy (#40):** `docs/privacidade.md` (collected data, truncated IP, residency, retention, gaps). Update it when touching personal data, logs, cookies or retention.
- **Anti-bot and supply chain (#41):** `docs/anti-bot-e-cadeia-de-suprimentos.md` (gateway layers with limits and what they do not stop; supply-chain controls with their files). Update it when changing gateway limits, `release.yml`, `renovate.json` or the deploy.
- **Guides (#42, #43):** `docs/deploy.md` (audited against `infra/`, not yet tested by an outsider) and `docs/onboarding-de-tenant.md` (sign-up, script, dual-export and dashboards, no real pilot yet). Both issues stay open until those tests.
- **SLA (#52):** `docs/sla.md`.
- **SCF proposal (#64, #65):** drafts in `docs/proposta/` (`proposal.md`, `interest-form.md`), in English, with RFP facts from Raven and the rest marked as unverified. Budget, team, pilots and referral code are Romulo's; nothing was sent to SCF.

## Examples (`examples/`)

- `static-html`, `spa` and `nextjs-ssr` install the script as a tenant would; `examples/README.md` has the installation snippets used in the onboarding guide (#43). HTML and SPA run with `examples/serve.mjs`, which replaces `<!-- stellytics:script -->` with the tag (site in `STELLYTICS_WEBSITE_ID`).
- `examples/e2e` (Playwright): `pnpm --filter @stellytics/examples-e2e e2e` creates the sites in Umami and in `stellytics`, opens the three examples in Chromium and checks page views in the Umami database. Runs in the CI `compose` job. The script is named `e2e`, not `test`, so turbo does not run it in the `typescript` job.
- `examples/api-backend` (#35): Node backend with OTel and a dual-export guide (SDK and OTel Collector) in its `README.md`. In Compose through the override `infra/compose/api-example.yaml` (needs `STELLYTICS_INGEST_KEY`); `compose-check.sh` creates the key in the database and checks `api_metric_1m`.
