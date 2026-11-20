# 0017. Operator invites by email, created only by the admin script

- **Status:** Accepted
- **Date:** 20/11/2026
- **Issue:** none (maintainer request, 20/11/2026)

## Context

SCF operators see every project. Since #19 (E2 spec, D3) the portal has no admin role and no screen to create operators: only `scripts/operator.mjs`, run by someone with access to the server and the database, creates, promotes or demotes them. That keeps control of who is an operator with whoever holds server access: an operator cannot make other operators.

What D3 left awkward was the first password. `operator:create` asks the person running the script for the new operator's password, so that person knows it and has to pass it on. `operator:promote` avoids that, but the new operator must first sign up as a regular user and stop before creating a project. The maintainer asked for an invite instead: a few named people run the script, it asks for the email twice, emails a link valid for 3 days, and the invited person picks their own password.

## Decision

- `operator.mjs invite` asks for the email twice (or takes `--email`), refuses an email that already has an account, and stores a pending invite in `operator_invite`: the email, the SHA-256 of a 32-byte random token and `expires_at = now() + 3 days`. It sends the link `<PORTAL_URL>/invite/<token>` through the portal's SMTP inside the same transaction, so a failed email leaves no invite. The token is printed nowhere and stored nowhere.
- The public page `/invite/[token]` (`loadOperatorInvite` in `access.ts`, `acceptOperatorInvite` in `src/lib/data/operator-invite.ts`) asks for a name and a password and creates the account as an operator, email already verified, like `operator:create`. Any problem with the link (bad format, unknown, used, revoked, expired) shows the same message.
- One row per email, and it exists only while the invite is pending: accepting, `uninvite`, a new invite to the same email or `operator:create` delete it, and the script purges expired ones. No email stays in the table after use. Like `operator_api_key` (0007), the ingestion roles cannot read it.
- `audit_log` gets `operator.invited` and `operator.invite_revoked` (null actor: the script) and `operator.invite_accepted` (actor: the new operator), with the invite ID only.
- `operator.mjs list` shows the operators and the pending invites, so the people holding server access can check who has the role.
- The command runs on the server, inside the portal container, through `operator.sh` at the repository root: the container already has `DATABASE_URL`, `SMTP_URL`, `MAIL_FROM` and `BETTER_AUTH_URL` (the link's base), so no tunnel is needed and no secret leaves the server. Since the Next standalone output inlines `postgres`, `nodemailer` and `better-auth` into its chunks, the image carries the script bundled with `esbuild` (`scripts/build-operator.mjs`, same pinned version the tracker already uses). Run from a workstation with the admin tunnel, the script still works with `SMTP_URL` and `PORTAL_URL` set by hand.
- D3 stays: the portal still has no screen to create or invite operators. Who may invite is whoever can SSH into the server with sudo; giving or removing that access (one SSH key per person) is how the maintainer controls the group.

## Alternatives considered

| Alternative | Pros | Cons |
|---|---|---|
| Invite screen in `/operator` | No server access needed | Any operator could create operators, which is what D3 avoids |
| `operator:create` with a random password, then "Forgot password" | No new code | The reset link lasts 30 minutes, and the person invited gets a "reset your password" email they did not ask for |
| `operator:promote` after a normal sign-up | No new code | The new operator signs up as a regular user first and must not create a project (D2) |
| Link valid longer than 3 days | Fewer expired invites | A link that grants global access stays usable longer if the email leaks |

## Consequences

- The people who can invite are the people with SSH and sudo on the server. That is a broader power than inviting (they can do anything in production), so the maintainer picks them as infrastructure admins and gives each one their own SSH key.
- The portal image grows by the bundled script (about 0.6 MB) and the portal gets `esbuild` as a build-time dependency.
- A leaked invite email grants operator access until the link is used, revoked or expires. `operator.mjs uninvite` and `demote` are the containment steps.
- The RFP does not ask for invites; the maintainer asked for them on 20/11/2026 as part of operating the platform's access control.
