# Postgres de produção (#14, ADR 0004): a mesma versão do ambiente local
# (17.11), na variante Debian, porque os binários do WAL-G usam glibc, mais o
# WAL-G para o backup contínuo no Object Storage da Hetzner.
#
# Imagem e WAL-G fixados por digest e por hash. Para subir de versão, troque os
# três valores juntos e confira os hashes na página da release do WAL-G.
FROM postgres:17.11-bookworm@sha256:665dc7b37ac52a17e298511414c21d23ffa4e6a6ef6225b3e5d59c7afb35e994

ARG WALG_VERSION=v3.0.9
ARG WALG_SHA256_AMD64=4f03ee4679db7f660bfd1b2b8291ac5df247cd2ec48074b60c112f4897299f24
ARG WALG_SHA256_ARM64=20191a37ad091a880c25f4cc907e6f0deb7f12bdd8a53fd62dbc7fcbf2eac712
ARG TARGETARCH

RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) arch=amd64; sum="$WALG_SHA256_AMD64" ;; \
      arm64) arch=aarch64; sum="$WALG_SHA256_ARM64" ;; \
      *) echo "arquitetura sem WAL-G: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    name="wal-g-pg-22.04-$arch"; \
    curl -fsSL -o /tmp/walg.tar.gz "https://github.com/wal-g/wal-g/releases/download/$WALG_VERSION/$name.tar.gz"; \
    echo "$sum  /tmp/walg.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/walg.tar.gz -C /tmp; \
    install -m 0755 "/tmp/$name" /usr/local/bin/wal-g; \
    rm -rf /tmp/walg.tar.gz "/tmp/$name"; \
    apt-get purge -y curl; apt-get autoremove -y; rm -rf /var/lib/apt/lists/*; \
    wal-g --version

COPY --chmod=0755 backup.sh /usr/local/bin/notify-backup
COPY --chmod=0755 restore.sh /usr/local/bin/notify-restore
