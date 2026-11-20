#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT_DIR/.env.production"
readonly DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

fail() {
  printf 'init: %s\n' "$*" >&2
  exit 1
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
Usage: sudo ./init.sh

Prepares a Debian/Ubuntu VPS to run the minimal installation:
- installs Docker Engine and Docker Compose from the official repository;
- applies the network and log rotation configuration used by the stack;
- creates .env.production with random secrets, without overwriting an existing file.

Then set the domains and SMTP in .env.production and run sudo ./deploy.sh.
Also set the S3 storage for the backup (WALG_S3_*). Keep a copy of
WALG_LIBSODIUM_KEY outside the VPS: without it, no backup can be restored.
USAGE
  exit 0
fi

[[ $# -eq 0 ]] || fail "unknown argument; use --help"
[[ "$EUID" -eq 0 ]] || fail "run with sudo: sudo ./init.sh"
command -v apt-get >/dev/null 2>&1 || fail "this script requires Debian or Ubuntu with apt-get"

# Identify the distribution and architecture before configuring the repository.
. /etc/os-release
case "${ID:-}" in
  debian|ubuntu) docker_repo_os="$ID" ;;
  *) fail "unsupported distribution: ${ID:-unknown}; use Debian or Ubuntu" ;;
esac
docker_arch="$(dpkg --print-architecture)"
case "$docker_arch" in
  amd64|arm64) ;;
  *) fail "architecture not supported by the Docker repository" ;;
esac
[[ -n "${VERSION_CODENAME:-}" ]] || fail "could not identify the distribution codename"

printf 'Installing Docker prerequisites...\n'
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg
install -d -m 0755 /etc/apt/keyrings
docker_key_tmp="$(mktemp)"
trap 'rm -f -- "$docker_key_tmp"' EXIT
curl -fsSL "https://download.docker.com/linux/$docker_repo_os/gpg" -o "$docker_key_tmp"
docker_key_fingerprint="$(gpg --show-keys --with-colons "$docker_key_tmp" | awk -F: '/^fpr:/ && !seen++ {print $10}')"
[[ "$docker_key_fingerprint" == "$DOCKER_KEY_FINGERPRINT" ]] || fail "the Docker repository key fingerprint does not match"
install -m 0644 "$docker_key_tmp" /etc/apt/keyrings/docker.asc
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
  "$docker_arch" "$docker_repo_os" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin python3

printf 'Configuring Docker for this stack...\n'
daemon_config_result="$(python3 "$ROOT_DIR/infra/scripts/configure-docker.py")" || fail "could not update the Docker configuration"

if [[ "$daemon_config_result" == changed ]] && systemctl is-active --quiet docker; then
  systemctl restart docker
else
  systemctl enable --now docker
fi

docker compose version >/dev/null || fail "Docker Compose is not available"

python3 "$ROOT_DIR/infra/scripts/production-env.py" init "$ROOT_DIR/.env.production.example" "$ENV_FILE"

printf '\nDocker and Compose are ready. Set the domains, SMTP and the backup S3 in:\n%s\n' "$ENV_FILE"
printf 'Then run: sudo %s/deploy.sh\n' "$ROOT_DIR"
