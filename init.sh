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
Uso: sudo ./init.sh

Prepara uma VPS Debian/Ubuntu para rodar a instalação mínima:
- instala Docker Engine e Docker Compose pelo repositório oficial;
- aplica a configuração de rede e rotação de logs usada pela stack;
- cria .env.production com segredos aleatórios, sem sobrescrever arquivo existente.

Depois, configure domínios e SMTP em .env.production e rode sudo ./deploy.sh.
Configure também o armazenamento S3 do backup (WALG_S3_*). Guarde uma cópia de
WALG_LIBSODIUM_KEY fora da VPS: sem ela, nenhum backup pode ser restaurado.
USAGE
  exit 0
fi

[[ $# -eq 0 ]] || fail "argumento não reconhecido; use --help"
[[ "$EUID" -eq 0 ]] || fail "execute com sudo: sudo ./init.sh"
command -v apt-get >/dev/null 2>&1 || fail "este script requer Debian ou Ubuntu com apt-get"

# Identifica a distribuição e arquitetura antes de configurar o repositório.
. /etc/os-release
case "${ID:-}" in
  debian|ubuntu) docker_repo_os="$ID" ;;
  *) fail "distribuição não suportada: ${ID:-desconhecida}; use Debian ou Ubuntu" ;;
esac
docker_arch="$(dpkg --print-architecture)"
case "$docker_arch" in
  amd64|arm64) ;;
  *) fail "arquitetura não suportada pelo repositório Docker" ;;
esac
[[ -n "${VERSION_CODENAME:-}" ]] || fail "não foi possível identificar o codinome da distribuição"

printf 'Instalando pré-requisitos do Docker...\n'
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg
install -d -m 0755 /etc/apt/keyrings
docker_key_tmp="$(mktemp)"
trap 'rm -f -- "$docker_key_tmp"' EXIT
curl -fsSL "https://download.docker.com/linux/$docker_repo_os/gpg" -o "$docker_key_tmp"
docker_key_fingerprint="$(gpg --show-keys --with-colons "$docker_key_tmp" | awk -F: '/^fpr:/ && !seen++ {print $10}')"
[[ "$docker_key_fingerprint" == "$DOCKER_KEY_FINGERPRINT" ]] || fail "a impressão digital da chave do repositório Docker não confere"
install -m 0644 "$docker_key_tmp" /etc/apt/keyrings/docker.asc
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
  "$docker_arch" "$docker_repo_os" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin python3

printf 'Configurando o Docker para esta stack...\n'
daemon_config_result="$(python3 "$ROOT_DIR/infra/scripts/configure-docker.py")" || fail "não foi possível atualizar a configuração do Docker"

if [[ "$daemon_config_result" == changed ]] && systemctl is-active --quiet docker; then
  systemctl restart docker
else
  systemctl enable --now docker
fi

docker compose version >/dev/null || fail "Docker Compose não ficou disponível"

python3 "$ROOT_DIR/infra/scripts/production-env.py" init "$ROOT_DIR/.env.production.example" "$ENV_FILE"

printf '\nDocker e Compose estão prontos. Configure domínios, SMTP e o S3 do backup em:\n%s\n' "$ENV_FILE"
printf 'Depois, execute: sudo %s/deploy.sh\n' "$ROOT_DIR"
