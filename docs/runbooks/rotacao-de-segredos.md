# Runbook: rotação de segredos

A ordem exata para trocar um segredo (editar o `.env.production`, rodar `sudo ./deploy.sh`, atualizar a senha no banco, reiniciar) está em [`docs/deploy.md`](../deploy.md), seção "Atualizar a aplicação", bloco **Trocar um segredo**. Siga-o; **não** trocar só o `.env.production`: os usuários do banco guardam a senha antiga. Este runbook diz o que cada segredo afeta e como conferir.

## Quando rotacionar

- Suspeita ou confirmação de vazamento (log, repositório, máquina de quem administra, ex-colaborador): rotacione na hora, antes de investigar.
- Saída de alguém com acesso ao `.env.production` ou à VPS.
- Rotina: sem calendário definido no repositório; defina um (por exemplo, anual) e registre aqui.

## Os segredos e o efeito de cada troca

Os da produção ficam no `.env.production` (modelo em `.env.production.example`); os do monitoramento, no arquivo passado a `infra/monitoring/configure.sh`.

| Segredo | Efeito da troca | Passo extra além do `docs/deploy.md` |
|---|---|---|
| `POSTGRES_PASSWORD`, `STELLYTICS_DB_PASSWORD`, `UMAMI_DB_PASSWORD` | O Postgres é recriado; portal, Umami e gateway ficam sem banco até o `ALTER ROLE` | `ALTER ROLE ... PASSWORD` e `restart portal umami ingest-web` (no guia). **Não digite a senha na linha de comando**: ela iria para o histórico do shell e, se `log_statement` estiver ligado, para o log do Postgres. Leia a senha sem eco (`read -rs NOVA`), desligue o histórico da sessão (`unset HISTFILE`) e passe o comando por `psql` lendo da entrada padrão, por exemplo `printf "ALTER ROLE stellytics PASSWORD '%s'
" "$NOVA" \| docker compose -f prod.yaml exec -T postgres psql -U postgres` (não testado). Os eventos web do intervalo são descartados: faça fora do pico |
| `STELLYTICS_INGEST_DB_PASSWORD`, `STELLYTICS_COLLECTOR_DB_PASSWORD` | Idem para o gateway | Reaplicar `02-ingest-roles.sh` (idempotente), como no guia |
| `PORTAL_AUTH_SECRET` | Todas as sessões do portal caem, e também os links de confirmação de e-mail e de recuperação de senha em andamento deixam de valer (efeito esperado) | Avise os usuários |
| `UMAMI_APP_SECRET` | As sessões do Umami caem; a chave de API pode deixar de valer | Se o portal receber 401 do Umami, gere nova com o túnel aberto: `UMAMI_URL=http://127.0.0.1:13001 pnpm --filter @stellytics/portal umami:service-account` (senha de admin em `UMAMI_ADMIN_PASSWORD`; o script usa `127.0.0.1:3001` por padrão, por isso a variável) e ponha em `UMAMI_API_KEY`. Com `--revoke-old` o script apaga as outras chaves do usuário de serviço |
| `UMAMI_API_KEY` | O portal usa a nova chave ao ser recriado | Rode `sudo ./deploy.sh` de novo; revogue a antiga com `--revoke-old` (acima) ou pela interface do Umami (túnel) |
| Senha de `admin` do Umami | Só vale pela interface, pelo túnel | Troque pela interface; ela nunca fica no `.env.production` |
| `INGEST_PROOF_SECRET` | Os desafios em circulação perdem a validade; os navegadores pedem um novo em `GET /c` no próximo evento | Nenhuma ação (mínimo de 32 caracteres) |
| `SMTP_URL` | Confirmação de e-mail e recuperação de senha dependem dele | Teste com um cadastro ou `/forgot-password` depois |
| `WALG_S3_ACCESS_KEY`, `WALG_S3_SECRET_KEY` | O arquivamento de WAL e o backup usam a nova credencial ao recriar o Postgres | Crie a credencial nova no provedor do S3 antes, rode `sudo ./deploy.sh` e confirme `backup-list`; só então revogue a antiga ([backup e restauração](backup-e-restauracao.md)) |
| `WALG_LIBSODIUM_KEY` | **Não é rotacionável**: o `docs/deploy.md` diz que ela não pode ser trocada, porque os backups antigos deixariam de abrir (o `prod.yaml` aceita uma chave só) | Não troque por rotina. Se ela vazar, veja "Chave de cifra" em [backup e restauração](backup-e-restauracao.md) |
| `SMTP_PASSWORD` do monitoramento | Alertas por e-mail | `infra/monitoring/configure.sh <env-file>`, reinicie o `alertmanager` e teste um alerta (ver `docs/deploy.md`, "Monitoramento") |
| Chave SSH de administração | Acesso à VPS e ao host de monitoramento | Procedimento (não testado): 1) acrescente a chave nova no `authorized_keys` da VPS **e** do host de monitoramento; 2) teste o login com a nova em ambos, em outra sessão; 3) remova a antiga dos dois `authorized_keys`; 4) se o provedor guarda chaves SSH para máquinas novas, troque lá também |
| Chaves de ingestão dos tenants (`ntf_...`) | Ficam com o tenant | [Vulnerabilidades: chave de ingestão vazada](vulnerabilidades.md#chave-de-ingestão-vazada) |

## Diagnóstico depois da troca

```bash
# na VPS, na pasta do checkout
docker compose -f prod.yaml ps
docker compose -f prod.yaml logs --tail 100 portal ingest-web umami
```

Erros de autenticação de banco (`password authentication failed`) indicam que o `ALTER ROLE` ou o `02-ingest-roles.sh` não rodou ou usou outro valor.

## Verificação

Passo 3 ("Check production") de `docs/deploy.md` (curls de fora e `docker compose ps`), entrar no portal, abrir o painel de um site, receber um e-mail de confirmação, e `wal-g backup-list` se a credencial do backup mudou.

## Quando escalar

- O Postgres não volta com a senha nova: restaure o `.env.production` anterior (guarde cópia antes) e repita com calma.
- Credencial vazada que dá acesso ao bucket de backup: trate como incidente de segurança ([vulnerabilidades](vulnerabilidades.md)) além de rotacionar.

## Não testado

Nenhuma troca foi feita em produção. A seção "Rotating a secret" do `docs/deploy.md` foi escrita a partir dos arquivos de infra, não executada; o comportamento de `UMAMI_API_KEY` depois de trocar o `UMAMI_APP_SECRET` também não foi observado.
