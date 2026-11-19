# Contributing

Thanks for your interest in stellytics. This guide explains how to set up the environment, run the tests and submit changes.

## Before you start

- **Bugs and questions:** open an [issue](https://github.com/romulospl/stellytics/issues/new/choose) using the matching template.
- **Vulnerabilities:** do not open a public issue; follow [`SECURITY.md`](SECURITY.md).
- **Large or architectural changes:** open an issue before writing code. Architecture decisions become an ADR in [`docs/adr/`](docs/adr/README.md), based on the [template](docs/adr/template.md). An accepted ADR is never rewritten: create a new one and mark the old one as superseded.

## Environment

Requirements: Node.js 24 or newer, pnpm 10 (`corepack enable`), Go 1.26 and Docker with Compose v2.

```bash
pnpm install                 # TypeScript dependencies
docker compose up -d --wait  # local Postgres and Umami
```

The step-by-step local setup, with ports and credentials, is in the [README](README.md#running-locally).

## Tests

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For the Go code, from inside `services/`:

```bash
gofmt -l .
go vet ./...
go test -race ./...
```

Integration tests use a real Postgres, read from `DATABASE_URL` (locally, `postgresql://stellytics:stellytics@localhost:5432/stellytics`). CI runs all of this on every PR.

Rules the tests must cover:

- **Tenant isolation:** every new data access needs a test showing that one tenant cannot see another tenant's data.
- **Privacy:** the full IP address is never persisted; no cookies or browser storage.
- **Route normalization:** every rule with positive and negative cases.

## Dependencies

- Dependencies must use an [OSI](https://opensource.org/licenses)-approved license; specific, temporary exceptions for build tools are recorded in `scripts/licenses/allowed.json` and reviewed on the stated date.
- Pin exact versions and commit the lockfile (`pnpm-lock.yaml`, `services/go.sum`). CI fails if the lockfile is out of date.
- Only adopt releases that are at least 14 days old, except for the narrow exception for critical or high security fixes described in the [runbook](docs/runbooks/vulnerabilidades.md). pnpm enforces `minimumReleaseAge`; Renovate still depends on being installed and on GitHub alerts.
- GitHub Actions pinned by SHA, with the tag in a comment.

### Dependency and license alerts

The `dependencies` workflow (`.github/workflows/dependencies.yml`) runs on PRs that touch manifests or lockfiles, on `main` and daily. It is not part of the `ci` check, because a new advisory changes the result without any code change; a red run on `main` needs someone to look at it. To run the checks locally:

```bash
# from services/: reachable vulnerabilities. Pin the Go version used by the images: read it
# from `FROM golang:X.Y.Z` in services/*/Dockerfile (currently 1.26.9) and use it in GOTOOLCHAIN
GOTOOLCHAIN=go1.26.9 go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 ./...
# from the root: pnpm vulnerabilities (high and critical fail; exits 2 if the query failed; also lists devDependencies ones, without failing)
node scripts/deps/audit-pnpm.mjs
# from the root, after pnpm install: licenses
pnpm licenses list --json --prod > /tmp/npm-licenses.json
(cd services && go run github.com/google/go-licenses/v2@v2.0.1 report ./... --template ../scripts/licenses/go-licenses.tpl --ignore github.com/romulospl/stellytics/services) > /tmp/go-licenses.tsv
node scripts/deps/check-licenses.mjs --npm /tmp/npm-licenses.json --go /tmp/go-licenses.tsv
node --test scripts/deps/*.test.mjs   # tests for the checkers
```

**Vulnerability.** Read the package, the fixed version and the path (the report shows which dependency pulls it in). Prefer upgrading, respecting the 14-day wait. If the fix is not yet 14 days old, wait for the date it becomes eligible (the `govulncheck` job stays red until the image is bumped, which is expected and short) and consider a mitigation in the meantime; the 14-day rule is not relaxed. For a transitive dependency, upgrade the one that pulls it in or use `pnpm.overrides` with an exact version. `moderate` and `low` findings from `pnpm audit` do not fail the job but show up in the log: handle them when a fix exists. Never silence a `high` or `critical` alert, or change the `audit` threshold, to turn the job green. A red job with "Nao consegui consultar" is not a vulnerability: it is an endpoint or network failure, run it again.

**License not on the list.** The allowlist is `scripts/licenses/allowed.json` (SPDX ids). An `OR` expression (dual license) passes if one alternative is on the list; with `AND`, all must be; `X WITH exception` counts as `X`. No license, `UNLICENSED`, `Unknown` and `SEE LICENSE IN ...` always fail. What to do, in order:

1. Replace the dependency with one under an allowed license.
2. If the license is [OSI](https://opensource.org/licenses)-approved and permissive, add the SPDX id to `allowed` in the PR, with the justification in the description. Copyleft (LGPL, GPL, AGPL; MPL-2.0 is already allowed) does not go on the general list: it becomes a per-package exception (`package` may end in `*` for npm, as in `@img/sharp-libvips-*`). For libvips, the current decision is not to distribute it: image optimization is disabled and sharp/libvips are removed from the standalone build. Distributing LGPL code in the future requires analyzing and meeting the applicable obligations before re-enabling the feature.
3. If it is a one-off case (for example, a build dependency without an OSI license), add an entry to `exceptions` with `ecosystem` (`npm` or `go`), `package` (npm name or Go module path), `license` (exactly what the checker printed), `reason`, `date` and `expires` (at most 183 days, about six months; dates in YYYY-MM-DD, invalid ones fail the job). The exception applies only to that package and that license, in any version, and it **expires**: after the date the job fails again, to force a review. An unused exception shows up as a warning and should be removed.

## Commits and pull requests

Commits follow [Conventional Commits 1.0.0-beta.4](https://www.conventionalcommits.org/en/v1.0.0-beta.4/):

```
<type>[optional scope]: <description>

[optional body]

[optional footer]
```

- Types: `feat`, `fix`, `docs`, `chore`, `style`, `refactor`, `perf`, `test`, `ci`, `build` and `improvement`.
- Scope: the part of the code affected, for example `feat(collector):`, `fix(tracker):`, `docs(adr):`.
- Description in the imperative, short and lowercase: `feat(collector): add Stellar address normalization`.
- Breaking changes: `BREAKING CHANGE: <description>` in the body or footer, or `!` before the colon.
- Close the issue from the footer: `closes #32`.

Pull requests:

- One topic per PR, with a title following the same pattern as commits.
- Describe what changed and how you tested it.
- CI must be green to merge.

Everything in the repository is written in English: code, comments, documentation, ADRs, issues, commits and pull requests.

## License

By contributing, you agree that your contribution will be licensed under the project's [MIT license](LICENSE).
