# Residency and erasure

Where the data lives, how long it stays and how to delete it.

## Where it lives

All data stays in the region of the server and backup bucket the operator chooses. The operator declares that region before receiving data. Backups leave the server encrypted.

## How long it stays

| Data | Kept for |
|---|---|
| Web events | 183 days |
| API metrics per minute | 35 days |
| API metrics per hour and per day | 25 months |
| Sites, services and keys | Until the project is erased |
| Backups | Until they leave the backup window (7 full backups by default) |

## Delete your data

- **A project:** whoever operates the instance can erase a removed project. Its sites, services, keys and collected data are deleted.
- **Old events:** deleted automatically after the periods above.

## Individual visitors

There is no way to match one visitor's request to stored rows: no cookie or identifier ties them to their data. Their data leaves with the 183-day retention, or with the whole site.

## What stays

- The audit log keeps the history of actions; when an account is deleted, its user is replaced by `[erased]`.
- Erased data stays in backups until they rotate out.

Full details in [the privacy document](../privacy.md).
