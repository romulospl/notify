# 0004. Hospedagem na Hetzner, OpenTofu e backup com WAL-G

- **Status:** Aceito
- **Data:** 14/11/2026
- **Issue:** [#14](https://github.com/romulospl/notify/issues/14)
- **Depende de:** [ADR 0002](0002-arquitetura-e-stack.md)

## Contexto

O ADR 0002 fixou a forma da produção: uma VM na União Europeia, Terraform para a VM, o firewall e o DNS, Ansible para o deploy com Docker Compose, Caddy para TLS e backup contínuo do Postgres (WAL-G ou pgBackRest) em object storage. Ficaram abertos o provedor, o local, a ferramenta de backup e alguns detalhes que só aparecem ao escrever a IaC.

Restrições que pesam:

- **toda dependência precisa de licença aprovada pela OSI** (CLAUDE.md);
- outra equipe da comunidade precisa conseguir recriar a produção só com o repositório e os segredos;
- o MVP cabe numa VM (ADR 0002), e o custo tem de ser baixo, porque o produto é gratuito para tenants e para o SCF;
- os dados precisam ter residência declarada na UE.

## Decisão

1. **Hetzner Cloud, em Nuremberg (`nbg1`), Alemanha.** VM, volume de dados e Object Storage do backup ficam no mesmo local. O local é uma variável (`nbg1`, `fsn1` ou `hel1`), todos na UE com Object Storage.
2. **OpenTofu no lugar do Terraform.** O Terraform passou a usar a licença BUSL a partir da versão 1.6, que não é aprovada pela OSI. O OpenTofu (MPL-2.0) é o fork mantido pela Linux Foundation, lê os mesmos arquivos `.tf` e usa os mesmos providers. Isso substitui só a ferramenta do ADR 0002; o resto continua valendo.
3. **O que o OpenTofu cria** (`infra/opentofu/`): a VM, o firewall da Hetzner (SSH só das redes de administração; 80 e 443 abertos), um volume separado para os dados, a chave SSH e o bucket do backup. O volume e o bucket têm proteção contra exclusão.
4. **DNS fora da IaC por enquanto.** O domínio ainda não existe. Os hosts do portal e da ingestão são variáveis, e o OpenTofu mostra os IPs para os registros A e AAAA. Quando houver domínio, o registro pode entrar na IaC com o provider do DNS escolhido.
5. **Backup com WAL-G**, dentro da imagem do Postgres (`infra/compose/postgres/Dockerfile`):
   - WAL contínuo pelo `archive_command`, com `archive_timeout` de 60 segundos;
   - backup base diário por um timer do systemd, mantendo os 7 mais novos;
   - compressão brotli e **cifra no cliente** (libsodium), com a chave guardada fora da VM;
   - restauração até o último WAL ou até um horário (`notify-restore`), testada no CI a cada PR com os comandos do `docs/deploy.md`.
6. **Deploy com Ansible**, só com módulos `ansible.builtin`, sem coleções extras. O deploy confere a assinatura de cada imagem com cosign antes de subir, contra a identidade do workflow de release.
7. **Postgres de produção na variante Debian** (`postgres:17.11-bookworm`), com a mesma versão do ambiente local (que usa Alpine): os binários do WAL-G usam glibc.

## Alternativas consideradas

| Alternativa | Prós | Contras |
|---|---|---|
| Scaleway (França) | Provider oficial, Object Storage S3, Postgres gerenciado | Mais caro para uma VM só |
| OVHcloud (França) | Empresa europeia grande | IaC pelo provider do OpenStack, mais verbosa |
| Terraform | Mais conhecido | Licença BUSL, não aprovada pela OSI |
| pgBackRest | Mais recursos (backup paralelo, verificação) | Mais configuração (repositório, stanza) sem ganho para uma VM só |
| Postgres gerenciado do provedor | Backup pronto | Sai do PostgreSQL próprio e do Compose; amarra ao provedor e dificulta a transferência |
| DNS na IaC desde já | Recriação completa num comando | Ainda não há domínio nem provedor de DNS escolhido |

## Consequências

- **Data residency:** VM, volume com o Postgres e backups ficam na Alemanha (`nbg1`). O IP completo nunca é gravado (ADR 0002), e os backups saem da VM cifrados.
- **Recriar do zero** exige só o repositório e os segredos (token da Hetzner, chaves do Object Storage, senhas e a chave do backup); o passo a passo está em [`docs/deploy.md`](../deploy.md).
- **A chave do backup (`WALG_LIBSODIUM_KEY`) é crítica:** sem ela, nenhum backup pode ser restaurado. Ela fica no cofre de senhas do time, fora da VM.
- **Limites do WAL-G encontrados:** com `WALG_DOWNLOAD_FILE_RETRIES` baixo, o contador de novas tentativas fica negativo e ele tenta para sempre (v3.0.9). O padrão (15 tentativas) fica como está.
- **Privacidade nos logs:** o Caddy não grava IP, cabeçalhos nem URL dos pedidos em nenhum log, nem nos de erro (que ele grava mesmo sem access log).
- **Volume obrigatório:** o volume é montado com `nofail`, para a VM subir mesmo sem ele, mas o Docker e o backup exigem `/srv/notify` montado (`RequiresMountsFor`). Sem isso, um reboot com o volume ausente criaria um banco vazio no disco da VM, e a retenção acabaria apagando os backups bons.
- **IPv6:** a rede do Compose tem IPv4 e IPv6, porque com o `userland-proxy` desligado o Caddy só atende o registro AAAA assim. O gateway confia no `X-Forwarded-For` dos dois IPs fixos do Caddy.
- **Restauração:** o `notify-restore` descarta os alvos de recuperação que vêm dentro de um backup feito depois de outra restauração. Para voltar a um horário, o ponto de partida é o último backup concluído antes dele (`docs/deploy.md`).
- **Pontos únicos de falha:** a VM e o volume. Alta disponibilidade fica para o pós-MVP ([#52](https://github.com/romulospl/notify/issues/52)).
- **Subir versões:** imagens e binários fixados por digest ou hash (Postgres, Caddy, Umami, WAL-G, cosign, OpenTofu e providers). O Renovate cobre os arquivos do Compose e os Dockerfiles; WAL-G e cosign são atualizados à mão, conferindo o hash da release.
