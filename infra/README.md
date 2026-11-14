# infra

Infraestrutura recriável a partir deste repositório, com hospedagem na União Europeia.

| Pasta | Ferramenta | Papel |
|---|---|---|
| [`compose/`](compose/) | Docker Compose | Ambiente local ([#12](https://github.com/romulospl/notify/issues/12)), incluído pelo `compose.yaml` da raiz, e a produção (`prod.yaml`, [#14](https://github.com/romulospl/notify/issues/14)) |
| [`compose/postgres/`](compose/postgres/) | Postgres + WAL-G | Scripts de criação dos bancos e, na produção, a imagem com backup contínuo (`Dockerfile`, `notify-backup`, `notify-restore`) |
| [`compose/test/`](compose/test/) | Docker Compose | Teste da pilha de produção com S3 local (`prod-stack-test.sh`, job `infra` do CI) |
| [`opentofu/`](opentofu/) | OpenTofu | VMs da produção e do monitoramento, firewalls, volume de dados e bucket do backup na Hetzner ([ADR 0004](../docs/adr/0004-hospedagem-e-backup.md)) |
| [`ansible/`](ansible/) | Ansible | Deploy: `site.yml` na produção (Docker, volume, imagens conferidas com cosign, pilha e backup) e `monitoring.yml` no monitoramento |
| [`caddy/`](caddy/) | Caddy | TLS e proxy reverso; única porta de entrada |
| [`scripts/`](scripts/) | SSH | Túnel de administração para o Postgres e o Umami da produção |
| [`monitoring/`](monitoring/) | Prometheus, blackbox, Alertmanager | Monitoramento externo numa VM separada: testa portal e ingestão de fora e alerta por e-mail ([#15](https://github.com/romulospl/notify/issues/15), [ADR 0005](../docs/adr/0005-monitoramento-externo.md)) |

Passo a passo da produção (provisionar, publicar, restaurar o banco): [`docs/deploy.md`](../docs/deploy.md).

## Umami só na rede interna

O Umami não pode ser alcançável de fora ([#62](https://github.com/romulospl/notify/issues/62), [docs/umami.md](../docs/umami.md)): quem chegasse ao `/api/send` dele contornaria o anti-bot e o truncamento de IP do gateway.

- O serviço `umami` não publica porta em nenhum arquivo do Compose usado em deploy. O `compose/umami-port.yaml` publica em `127.0.0.1` e é só para desenvolvimento e CI.

Na produção ([#14](https://github.com/romulospl/notify/issues/14)) valem mais duas regras, conferidas a cada PR pelo `compose/test/prod-stack-test.sh`:

- **O Caddy não tem rota para o Umami**, nem para a interface nem para a API. Publica só o gateway `ingest-web` (`/e`, `/c`, `/s/` e `/healthz`) e o portal.
- O firewall da VM (`opentofu/main.tf`) abre só 22 (redes de administração), 80 e 443. Para administrar o Umami, use o túnel SSH (`scripts/admin-tunnel.sh`).
