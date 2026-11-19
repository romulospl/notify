"""Check the production stack and publish the result for the external monitor.

Run every minute by the stellytics-check timer that deploy.sh installs. It
checks what the external probes cannot see from outside:

- every Compose service is running and, when it has a healthcheck, healthy
  (rollup turns unhealthy when the 1m -> 1h -> 1d rollup stops);
- Postgres is archiving WAL (pg_stat_archiver shows no failure after the last
  success);
- the newest WAL-G base backup is at most 26 hours old;
- the data disk is below the usage limit.

When all pass it writes <data-dir>/status/stack-ok; otherwise it removes the
file. Caddy answers GET /healthz/stack on the ingestion host with 200 or 503
from that file, and the monitoring host alerts on 503 (StackUnhealthy). The
reasons go to stdout (journalctl -u stellytics-check); none carries client
data.

    COMPOSE='docker compose --env-file .env.production -f infra/compose/prod.yaml' \
      python3 infra/scripts/stack-check.py /srv/stellytics

COMPOSE defaults to that value (run from the repository root).
STACK_CHECK_DISK_MAX_PERCENT changes the disk limit (default 90).
"""

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile

SERVICES = ("postgres", "umami", "portal", "ingest-web", "collector", "rollup", "caddy")
BACKUP_MAX_AGE = timedelta(hours=26)
DEFAULT_COMPOSE = "docker compose --env-file .env.production -f infra/compose/prod.yaml"


class CheckError(Exception):
    pass


def compose(*args, timeout=60):
    command = shlex.split(os.environ.get("COMPOSE", DEFAULT_COMPOSE)) + list(args)
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise CheckError(f"`{' '.join(args[:4])}` took over {timeout}s")
    if result.returncode != 0:
        detail = (result.stderr.strip().splitlines() or ["no output"])[-1]
        raise CheckError(f"`{' '.join(args[:4])}` failed: {detail}")
    return result.stdout


def check_services():
    out = compose("ps", "--all", "--format", "json").strip()
    # Compose prints a JSON array in older versions and one object per line in newer ones.
    rows = json.loads(out) if out.startswith("[") else [json.loads(line) for line in out.splitlines() if line]
    services = {row.get("Service"): row for row in rows}
    problems = []
    for name in SERVICES:
        row = services.get(name)
        if row is None:
            problems.append(f"{name}: not created")
        elif row.get("State") != "running":
            problems.append(f"{name}: {row.get('State')}")
        elif row.get("Health") not in ("", None, "healthy"):
            problems.append(f"{name}: {row.get('Health')}")
    return problems


def check_wal_archiving():
    failing = compose(
        "exec", "-T", "-u", "postgres", "postgres", "psql", "-XAt", "-d", "postgres", "-c",
        "select coalesce(last_failed_time > coalesce(last_archived_time, '-infinity'), false) from pg_stat_archiver",
    ).strip()
    return ["postgres: WAL archiving is failing (see pg_stat_archiver)"] if failing != "f" else []


def parse_time(value):
    # WAL-G writes nanoseconds; fromisoformat takes at most microseconds.
    value = re.sub(r"(\.\d{6})\d+", r"\1", value).replace("Z", "+00:00")
    return datetime.fromisoformat(value)


def check_base_backup(now):
    out = compose("exec", "-T", "-u", "postgres", "postgres", "wal-g", "backup-list", "--json", timeout=120).strip()
    backups = json.loads(out) if out.startswith("[") else []
    if not backups:
        return ["backup: no base backup in storage"]
    newest = max(parse_time(backup["time"]) for backup in backups)
    age = now - newest
    if age > BACKUP_MAX_AGE:
        return [f"backup: newest base backup is {age.total_seconds() / 3600:.0f}h old"]
    return []


def check_disk(data_dir, limit):
    usage = shutil.disk_usage(data_dir)
    percent = usage.used * 100 / usage.total
    return [f"disk: {data_dir} is {percent:.0f}% full (limit {limit}%)"] if percent >= limit else []


def publish(status_dir, healthy):
    status_dir.mkdir(mode=0o755, parents=True, exist_ok=True)
    target = status_dir / "stack-ok"
    if not healthy:
        target.unlink(missing_ok=True)
        return
    fd, temporary = tempfile.mkstemp(prefix=".stack-ok.", dir=status_dir)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write(datetime.now(timezone.utc).isoformat(timespec="seconds") + "\n")
    os.chmod(temporary, 0o644)
    os.replace(temporary, target)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data_dir", type=Path, help="STELLYTICS_DATA_DIR of the stack")
    args = parser.parse_args()
    limit = int(os.environ.get("STACK_CHECK_DISK_MAX_PERCENT", "90"))

    problems = []
    checks = (
        check_services,
        check_wal_archiving,
        lambda: check_base_backup(datetime.now(timezone.utc)),
        lambda: check_disk(args.data_dir, limit),
    )
    for check in checks:
        try:
            problems += check()
        except (CheckError, OSError, ValueError, KeyError) as error:
            problems.append(f"check failed: {error}")

    publish(args.data_dir / "status", not problems)
    for problem in problems:
        print(problem)
    if problems:
        raise SystemExit(1)
    print("stack ok")


if __name__ == "__main__":
    main()
