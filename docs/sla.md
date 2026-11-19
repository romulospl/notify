# Metas e compromissos de disponibilidade e de correção de vulnerabilidades

Issue [#52](https://github.com/romulospl/stellytics/issues/52). Decisão de arquitetura em [ADR 0009](adr/0009-alta-disponibilidade.md).

> **Leitura obrigatória.** A arquitetura de produção **de hoje não sustenta 99,99% na ingestão** (e não garante 99,90% nos painéis): é uma VM só, com Postgres único (ADR 0004, [ADR 0009](adr/0009-alta-disponibilidade.md)). Este documento separa o que é **meta** do RFP do que é **compromisso** do projeto, e não promete o primeiro como se fosse o segundo. A produção também ainda não foi implantada numa conta real (`docs/deploy.md`), então não há nenhuma medição.

## 1. As metas do RFP

Fonte: RFP `scf-web-api-analytics` ("Web and API Analytics for Stellar Ecosystem Projects"), Stellar Light, via MCP stellar-raven (`scout.getRfps`), consultado em **15/11/2026** (trimestre q4-2026, situação `open`; URL `https://stellarlight.xyz/ideas/scf-web-api-analytics`). Texto, seção "Hosting and Handover": a proponente hospeda e dá suporte por 12 meses após a última tranche, com "targets: 99.99% ingestion and 99.90% dashboard availability, critical and high vulnerabilities patched within 24 hours". Não confirmei se o regulamento oficial do SCF (fora do Stellar Light) usa os mesmos valores nem se são metas contratuais; trate o texto acima como a fonte.

| Item | Meta do RFP | Orçamento de erro (30 dias) |
|---|---|---|
| Ingestão (web e API) | 99,99% | 4,32 min |
| Painéis | 99,90% | 43,2 min |
| Vulnerabilidades críticas e altas | corrigidas em 24 h | n/a |
| Chamados de suporte | resposta em 5 dias úteis, resolução em 10 | n/a |

## 2. Meta, compromisso e o que a arquitetura sustenta

| Item | Meta do RFP | Compromisso do projeto hoje | O que a arquitetura de hoje sustenta | O que exigiria (ADR 0009) |
|---|---|---|---|---|
| Ingestão web | 99,99% | **Nenhum número comprometido.** Melhor esforço, medido e relatado (seção 3) | Uma VM e um banco únicos: não sustenta 99,99%, e a 99,9% só depois de medir | Degrau 1 (ingestão replicada) para 99,9%; 99,99% exige banco com failover (três nós), deploy sem interrupção, medição e ensaios; não prometido |
| Ingestão de API | 99,99% | Coletor e `rollup` no `prod.yaml`, numa VM só, atrás do Caddy (ADR 0013); nunca aplicado numa conta real | Teste externo do host OTLP (`monitor_api_url`) | Réplica do coletor e medição numa produção real |
| Painéis (portal e API de leitura) | 99,90% | **Nenhum número comprometido**, relato de medição | Uma VM: orçamento de 43 min/mês é consumido por um deploy ruim ou uma queda de VM | Degrau 2 (réplica e failover do banco, portal replicado) |
| Vulnerabilidades críticas e altas | 24 h | **Avaliação em 48 h; correção em 7 dias corridos (crítica) e 14 (alta)** desde o recebimento ou identificação interna (`SECURITY.md`). Contenção de críticas em 72 h e as 24 h do RFP são metas, não compromissos; ver seção 5 | O processo técnico (release assinada, deploy por digest) pode ser rápido; prazos menores dependem de plantão | Plantão contínuo e ensaios antes de encurtar o compromisso |
| Chamados de suporte | 5 e 10 dias úteis | **Os mesmos 5 e 10 dias úteis**, pelas issues públicas ([`suporte.md`](suporte.md)) | Dois responsáveis (Dione e Rômulo) | n/a |

**Decisão:** com dois mantenedores e sem plantão contínuo, assumir avaliação de relatos possivelmente críticos ou altos em até 48 horas e correção em até 7 dias corridos (crítica) e 14 (alta), contados do recebimento ou da identificação interna. Contenção de críticas em 72 h é meta. A meta do RFP de 24 h não é garantida; encurtar o compromisso exige definir e ensaiar um plantão.

## 3. O que se mede e como

### 3.1 Indicador (SLI)

Disponibilidade de um endpoint = fração das sondagens, na janela, que passaram no módulo configurado: 2xx para web e painel, 401 para a sondagem OTLP autenticada sem credencial.

| Componente | Sondagem (`infra/monitoring`) | Status |
|---|---|---|
| Portal / painéis | `GET /api/auth/ok` no host do portal, módulo `http_2xx` do blackbox, a cada 15 s | Existe |
| Ingestão web | `GET /healthz` no host da ingestão | Existe |
| Ingestão de API | `monitor_api_url`, módulo `otlp_401` | Configurada no repositório; não verificada em produção |

Limites honestos do indicador atual:

- `/healthz` prova que o gateway responde, **não** que um evento é aceito de ponta a ponta (prova de JS, `ingest_site`, Umami, banco). Um gateway no ar com o Umami fora aparece como disponível. Uma sondagem sintética de `POST /e` com site de teste é melhoria necessária e **não existe**.
- A sondagem parte de **um** ponto de vista (VM em `fsn1`). Uma falha de rede do monitor pareceria queda da produção, e o contrário também.
- A resolução é de 15 s; quedas menores podem passar.

### 3.2 Cálculo (proposto, não executado)

Com os dados do Prometheus do monitor (retenção de **30 dias**, `--storage.tsdb.retention.time=30d` em `infra/monitoring/compose.yaml`), por componente:

```promql
avg_over_time(probe_success{job="endpoints", component="<componente>"}[30d])
```

Esta expressão e o rótulo `component` (usado em `alerts.yml`) **não foram executados** contra dados reais. Como a retenção é de 30 dias, um mês de 31 dias perde o primeiro dia: gere o relato no último dia do mês, ou aumente a retenção antes de assumir qualquer número. Os valores guardados no relato mensal são a evidência de longo prazo.

### 3.3 Janela e exclusões

- **Janela:** mês-calendário em UTC.
- **Exclusões propostas** (precisam ser registradas no relato, com horário e motivo): manutenção avisada com pelo menos 72 h de antecedência no portal ou em issue pública, limitada a um total de 60 min por mês; falha do cliente ou da rede do tenant; indisponibilidade comprovada do provedor de hospedagem (registro do status da Hetzner); queda causada por abuso (ataque de volume) enquanto o Caddy não tem limite por IP (ADR 0006). Falha de deploy, de migração ou de renovação de certificado **não** é exclusão.
- Queda da própria VM de monitoramento: o período sem dados é contado como desconhecido e declarado no relato, não como disponível.

### 3.4 Relato mensal

Até o 5º dia útil do mês seguinte, uma nota pública em `docs/` ou issue, com: disponibilidade por componente, minutos de indisponibilidade, cada incidente (início, fim, causa, correção), exclusões aplicadas, e as vulnerabilidades críticas e altas do mês com o tempo até a correção. Ainda **não existe** automação nem modelo; o primeiro relato exige criar ambos.

## 4. O que é preciso para cada meta

- **99,9% na ingestão:** degrau 1 do ADR 0009 (2 ou mais VMs de ingestão atrás de balanceador ou IP flutuante), deploy rotativo, pager além do e-mail.
- **99,9% nos painéis:** degrau 2 (réplica do Postgres e promoção ensaiada, portal replicado com uma só instância migrando).
- **99,99%:** degraus 1 e 2 mais banco com três nós, failover medido em segundos, ponto de vista de monitoramento múltiplo, 12 meses de experiência de medição. **Não é prometido.**

Variáveis do OpenTofu que preparam o provisionamento, desligadas por padrão: `ha_ingest_replicas`, `ha_floating_ip`, `ha_db_standby` (e `ha_ingest_location`, `ha_db_standby_location`). Ligar cria recursos pagos. O Ansible que configura a réplica do Postgres (replicação em streaming) e as VMs de ingestão extras existe, desligado por padrão, e foi testado em Docker local (`docs/deploy.md`, "Alta disponibilidade"); o **failover é manual** ([runbook](runbooks/failover-do-banco.md), RPO de frações de segundo a poucos segundos e RTO de 30 a 90 minutos, ambos estimativas sem medição em produção). Continuam fora: balanceador, IP flutuante na VM, TLS das réplicas de ingestão atrás de balanceador e failover automático. O monitoramento da réplica é opcional e não foi ensaiado na rede de produção. O gateway já pode servir a `ingest_site` vencida quando o banco falha (`SITE_STALE_TTL`, desligado por padrão e repassado pelos arquivos de produção; ver ADR 0009 para a janela de recusa tardia). Isso **não** muda o compromisso: nenhum número é prometido.

## 5. Resposta a vulnerabilidades críticas e altas

Processo existente, a reaproveitar: [`SECURITY.md`](../SECURITY.md) (relato privado pela aba Security do GitHub), [`docs/runbooks/vulnerabilidades.md`](runbooks/vulnerabilidades.md) (contenção, correção, release, verificação), release assinada com cosign e atestado de SBOM (`.github/workflows/release.yml`), e o deploy por digest verificado (`infra/ansible`, `docs/deploy.md`, "Atualizar a aplicação").

Roteiro para crítica, contado do recebimento ou da identificação interna, não da classificação (para alta, o fim é o 14º dia; a contenção deve ocorrer em até 72 h sempre que possível):

| Tempo | Passo |
|---|---|
| 0 a 48 h | Confirmar o recebimento, reproduzir e classificar (CVSS 3.1). Aplicar **contenção** do runbook (revogar chave, bloquear projeto, rebaixar operador, parar o serviço) |
| 48 h a 5 dias | Corrigir em branch privada ou advisory privado, com teste que falha antes; CI verde |
| até 6 dias | Release (`vX.Y.Z`) e imagens assinadas |
| até 7 dias | Deploy por digest, verificação do passo 6 de `docs/deploy.md` e nova checagem |
| depois | Divulgação (advisory) |

**Dependência externa.** Se não houver correção upstream, contenha o impacto e comunique o risco de não cumprir o prazo; contenção não conta como correção. Correções críticas ou altas podem dispensar a espera de 14 dias de forma específica e documentada, conforme o [runbook](runbooks/vulnerabilidades.md). O Renovate pode oferecer atualizações de segurança antes do prazo quando os alertas do GitHub estiverem ativos, mas não está instalado; o pnpm possui sua própria regra e exige exceção específica.
**Lacunas conhecidas:**
- Dois mantenedores, sem plantão definido; os prazos incluem noites, fins de semana e feriados.
- A release e o `cosign verify` nunca rodaram contra imagens reais (não há release publicada); o runbook diz o mesmo.
- Deploy numa VM só interrompe o serviço; o deploy rotativo depende do degrau 1.
- Retirar uma versão vulnerável do script de rastreamento não é trivial (ver o runbook).

## 6. Pendências e decisões em aberto

- Plantão, sondagem de ponta a ponta, relato mensal. Degraus 1 e 2 do ADR 0009: a configuração das réplicas existe (desligada), faltam balanceador ou IP flutuante, portal replicado e um ensaio de failover numa conta real. Alertas de replicação existem, opcionais e não testados em produção.

## 7. O que este documento ainda não faz

Nenhuma medição existe; nada aqui foi exercitado numa produção real. Não há sondagem sintética de ponta a ponta, relato mensal automatizado nem pager. Os valores de custo estão no ADR 0009 e são estimativas. O canal privado de vulnerabilidades foi ativado em 19/11/2026.
