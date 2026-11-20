#!/usr/bin/env bash
set -euo pipefail

# Bootstrap script for the stellytics local development environment.
# Sets up the .env, dependencies, Umami service account credentials
# and starts the full stack through Docker Compose.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

FORCE_REGEN=false
for arg in "$@"; do
  case "$arg" in
    --force)
      FORCE_REGEN=true
      ;;
    -h|--help)
      echo "Usage: ./scripts/bootstrap.sh [--force]"
      echo ""
      echo "Options:"
      echo "  --force    Generates a new Umami key even if one already exists in the .env (does not revoke the previous one)"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

echo "=== [1/5] Checking prerequisites ==="
for cmd in docker pnpm node curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: '$cmd' is not installed or was not found in the PATH." >&2
    exit 1
  fi
done

if ! docker compose version >/dev/null 2>&1; then
  echo "Error: Docker Compose (v2) was not found." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Error: The Docker daemon is not running." >&2
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Dependencies (node_modules) not found. Running 'pnpm install'..."
  pnpm install
fi

echo "=== [2/5] Setting up environment variables (.env) ==="
if [ ! -f .env ]; then
  echo "Creating .env from .env.example..."
  cp .env.example .env
else
  echo ".env already exists."
fi

# Parse the simple dotenv syntax used by Compose, including quoted values and
# inline comments. Do not source .env as shell code.
ENV_VALUES="$(node --input-type=module -e '
  import fs from "node:fs";
  const values = {};
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?(UMAMI_PORT|UMAMI_API_KEY)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (value.startsWith("\"") || value.startsWith("\047")) {
      const q = value[0];
      const end = value.indexOf(q, 1);
      value = end < 0 ? value.slice(1) : value.slice(1, end);
    } else value = value.replace(/\s+#.*$/, "").trim();
    values[m[1]] = value;
  }
  console.log(JSON.stringify(values));
')"
UMAMI_PORT="$(node -e 'const e=JSON.parse(process.argv[1]); console.log(e.UMAMI_PORT || "3001")' "$ENV_VALUES")"
CURRENT_API_KEY="$(node -e 'const e=JSON.parse(process.argv[1]); console.log(e.UMAMI_API_KEY || "")' "$ENV_VALUES")"
case "$UMAMI_PORT" in ''|*[!0-9]*) echo "Error: UMAMI_PORT must be a numeric port." >&2; exit 1 ;; esac
[ "$UMAMI_PORT" -ge 1 ] && [ "$UMAMI_PORT" -le 65535 ] || { echo "Error: UMAMI_PORT is outside the valid range." >&2; exit 1; }

NEED_KEY_GEN=false
if [ -z "$CURRENT_API_KEY" ] || [ "$FORCE_REGEN" = true ]; then
  NEED_KEY_GEN=true
fi

if [ "$NEED_KEY_GEN" = true ]; then
  echo "=== [3/5] Starting base dependencies to set up the API key ==="
  docker compose -f compose.yaml -f infra/compose/umami-port.yaml up -d --wait postgres mailpit umami

  echo "Waiting for Umami to respond at http://127.0.0.1:${UMAMI_PORT}/api/heartbeat..."
  max_retries=30
  retry_count=0
  until curl -fsS "http://127.0.0.1:${UMAMI_PORT}/api/heartbeat" >/dev/null 2>&1; do
    retry_count=$((retry_count + 1))
    if [ "$retry_count" -ge "$max_retries" ]; then
      echo "Error: Timed out waiting for Umami." >&2
      exit 1
    fi
    sleep 1
  done

  echo "=== [4/5] Setting up the Umami service account ==="
  echo "Generating the service key for the portal..."
  if [ -z "${UMAMI_ADMIN_PASSWORD:-}" ]; then
    if [ -t 0 ]; then
      read -r -s -p "Umami administrator password: " UMAMI_ADMIN_PASSWORD
      echo
    else
      echo "Set UMAMI_ADMIN_PASSWORD to authenticate with Umami." >&2
      exit 1
    fi
  fi
  NEW_KEY="$(UMAMI_ADMIN_PASSWORD="$UMAMI_ADMIN_PASSWORD" UMAMI_URL="http://127.0.0.1:${UMAMI_PORT}" node apps/portal/scripts/umami-service-account.mjs | tr -d '\r\n ')"

  if [ -z "$NEW_KEY" ]; then
    echo "Error: Failed to get the Umami service key." >&2
    exit 1
  fi

  # Write safely to the .env using Node (avoids sed delimiter and escaping problems)
  node -e '
    const fs = require("node:fs");
    const key = process.argv[1];
    let env = fs.readFileSync(".env", "utf8");
    const regex = /^UMAMI_API_KEY=.*$/m;
    if (regex.test(env)) {
      env = env.replace(regex, () => "UMAMI_API_KEY=" + key);
    } else {
      env += (env.endsWith("\n") || env.length === 0 ? "" : "\n") + "UMAMI_API_KEY=" + key + "\n";
    }
    const tmp = `.env.tmp-${process.pid}`;
    fs.writeFileSync(tmp, env, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, ".env");
  ' "$NEW_KEY"

  echo "Service key saved to the .env."
else
  echo "=== [3/5] Base dependencies already set up ==="
  echo "=== [4/5] UMAMI_API_KEY already present in the .env (use --force to regenerate) ==="
fi

echo "=== [5/5] Starting the full development stack ==="
docker compose up -d --wait

echo ""
echo "=========================================================="
echo "🚀 stellytics environment ready and running!"
echo "=========================================================="
echo "Web portal:            http://localhost:3000"
echo "  - Fixed accounts: used only by the local seed; change the passwords before exposing the portal."
echo "Web gateway:           http://localhost:3002"
echo "API collector (OTLP):  http://localhost:4318 (HTTP) | localhost:4317 (gRPC)"
echo "Mailpit (emails):      http://localhost:8025"
echo "PostgreSQL:            localhost:5432 (stellytics/stellytics and umami/umami)"
echo "=========================================================="
echo "Tip: To stop the services, run: docker compose down"
echo "To reset the data from scratch:  docker compose down -v"
