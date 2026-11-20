"""Prepare and validate the production environment file."""

import argparse
import os
from pathlib import Path
import secrets
import stat
import tempfile


SECRET_NAMES = {
    "POSTGRES_PASSWORD",
    "UMAMI_DB_PASSWORD",
    "STELLYTICS_DB_PASSWORD",
    "STELLYTICS_INGEST_DB_PASSWORD",
    "STELLYTICS_COLLECTOR_DB_PASSWORD",
    "UMAMI_APP_SECRET",
    "PORTAL_AUTH_SECRET",
    "INGEST_PROOF_SECRET",
    "WALG_LIBSODIUM_KEY",
}


def initialize(template, path):
    if path.exists():
        path.chmod(0o600)
        return

    lines = []
    for line in template.read_text(encoding="utf-8").splitlines(keepends=True):
        key, separator, value = line.rstrip("\n").partition("=")
        if separator and key in SECRET_NAMES and not value:
            line = f"{key}={secrets.token_hex(32)}\n"
        lines.append(line)

    # Publish the complete file without replacing a concurrent initialization.
    with tempfile.TemporaryDirectory(prefix=".env-production-", dir=path.parent) as directory:
        temporary = Path(directory) / path.name
        temporary.write_text("".join(lines), encoding="utf-8")
        temporary.chmod(0o600)
        try:
            os.link(temporary, path)
        except FileExistsError:
            path.chmod(0o600)
            return
    print("Created .env.production with random secrets and permission 0600.")


def validate(path):
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise SystemExit(f"deploy: {path} is readable by group/others (mode {mode:04o}); run sudo chmod 600 {path}")

    values = {}
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in line:
                continue
            key, value = line.rstrip("\n").split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            values[key.strip()] = value

    required = (
        "POSTGRES_PASSWORD", "UMAMI_DB_PASSWORD", "STELLYTICS_DB_PASSWORD",
        "STELLYTICS_INGEST_DB_PASSWORD", "STELLYTICS_COLLECTOR_DB_PASSWORD",
        "UMAMI_APP_SECRET", "PORTAL_AUTH_SECRET", "INGEST_PROOF_SECRET",
        "PORTAL_HOST", "PORTAL_ALIAS_HOST", "INGEST_HOST", "API_HOST",
        "ACME_EMAIL",
    )
    missing = [key for key in required if not values.get(key)]
    if missing:
        raise SystemExit("deploy: fill in these fields in .env.production: " + ", ".join(missing))

    # Backup (WAL-G): all of the bucket fields and the key, or none. With
    # none, deploy.sh runs the stack without backup (enough for the demo).
    backup = (
        "WALG_S3_PREFIX", "WALG_S3_ENDPOINT", "WALG_S3_REGION",
        "WALG_S3_ACCESS_KEY", "WALG_S3_SECRET_KEY",
    )
    if any(values.get(key) for key in backup):
        missing = [key for key in backup + ("WALG_LIBSODIUM_KEY",) if not values.get(key)]
        if missing:
            raise SystemExit(
                "deploy: backup is half configured; fill in " + ", ".join(missing)
                + " or empty every WALG_S3_* field to run without backup"
            )

    if values["POSTGRES_PASSWORD"] in {"postgres", "password", "CHANGE_ME"}:
        raise SystemExit("deploy: POSTGRES_PASSWORD still uses an insecure value")

    # The demo of a real project reads its web statistics through the Umami
    # API; without the service account key /demo and /operator fail.
    if values.get("DEMO_TENANT_SLUG") and not values.get("UMAMI_API_KEY"):
        raise SystemExit("deploy: DEMO_TENANT_SLUG needs UMAMI_API_KEY (docs/deploy.md, \"First start\"); leave it empty for sample data")

    # Release images: all four or none. deploy.sh builds from the checkout when
    # none is set and pulls them, without building, when all four are.
    images = ("PORTAL_IMAGE", "INGEST_WEB_IMAGE", "COLLECTOR_IMAGE", "ROLLUP_IMAGE")
    chosen = [key for key in images if values.get(key)]
    if chosen and len(chosen) != len(images):
        raise SystemExit("deploy: set all of " + ", ".join(images) + " or none of them")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("init")
    create.add_argument("template", type=Path)
    create.add_argument("path", type=Path)
    check = commands.add_parser("validate")
    check.add_argument("path", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "init":
            initialize(args.template, args.path)
        else:
            validate(args.path)
    except OSError as error:
        parser.exit(1, f"{args.command}: {error}\n")


if __name__ == "__main__":
    main()
