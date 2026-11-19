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
    print("Criei .env.production com segredos aleatórios e permissão 0600.")


def validate(path):
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise SystemExit(f"deploy: {path} permite leitura por grupo/outros (modo {mode:04o}); rode sudo chmod 600 {path}")

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
        "ACME_EMAIL", "SMTP_URL", "MAIL_FROM",
        "WALG_S3_PREFIX", "WALG_S3_ENDPOINT", "WALG_S3_REGION",
        "WALG_S3_ACCESS_KEY", "WALG_S3_SECRET_KEY", "WALG_LIBSODIUM_KEY",
    )
    missing = [key for key in required if not values.get(key)]
    if missing:
        raise SystemExit("deploy: preencha estes campos em .env.production: " + ", ".join(missing))

    if values["POSTGRES_PASSWORD"] in {"postgres", "password", "CHANGE_ME"}:
        raise SystemExit("deploy: POSTGRES_PASSWORD ainda usa um valor inseguro")


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
