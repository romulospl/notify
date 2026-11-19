# Metas e compromissos de disponibilidade e de correção de vulnerabilidades

Issue [#52](https://github.com/romulospl/stellytics/issues/52). Decisão de arquitetura em [ADR 0016](adr/0016-producao-em-vps.md) (produção numa VPS só, sem alta disponibilidade).

> **Leitura obrigatória.** A arquitetura de produção **de hoje não sustenta 99,99% na ingestão** (e não garante 99,90% nos painéis): é uma VPS só, com Postgres único e sem réplica ([ADR 0016](adr/0016-producao-em-vps.md)). A alta disponibilidade foi retirada do escopo porque o RFP não a exige: 99,99% e 99,90% são metas que a proponente assume, não requisitos de arquitetura. Este documento separa o que é **meta** do RFP do que é **compromisso** do projeto, e não promete o primeiro como se fosse o segundo. A produção também ainda não foi implantada numa conta real (`docs/deploy.md`), então não há nenhuma medição.

## 1. As metas do RFP

Fonte: RFP `scf-web-api-analytics` ("Web and API Analytics for Stellar Ecosystem Projects"), Stellar Light, via MCP stellar-raven (`scout.getRfps`), consultado em **15/11/2026** (trimestre q4-2026, situação `open`; URL `https://stellarlight.xyz/ideas/scf-web-api-analytics`). Texto, seção "Hosting and Handover": a proponente hospeda e dá suporte por 12 meses após a última tranche, com "targets: 99.99% ingestion and 99.90% dashboard availability, critical and high vulnerabilities patched within 24 hours". Não confirmei se o regulamento oficial do SCF (fora do Stellar Light) usa os mesmos valores nem se são metas contratuais; trate o texto acima como a fonte.

| Item | Meta do RFP | Orçamento de erro (30 dias) |
|---|---|---|
| Ingestão (web e API) | 99,99% | 4,32 min |
| Painéis | 99,90% | 43,2 min |
| Vulnerabilidades críticas e altas | corrigidas em 24 h | n/a |
| Chamados de suporte | resposta em 5 dias úteis, resolução em 10 | n/a |

## 2. Meta, compromisso e o que a arquitetura sustenta

| Item | Meta do RFP | Compromisso do projeto hoje | O que a arquitetura de hoje sustenta | O que exigiria (fora do escopo, ADR 0016) |
|---|---|---|---|---|
| Ingestão web | 99,99% | **Nenhum número comprometido.** Melhor esforço, medido e relatado (seção 3) | Uma VPS e um banco únicos: não sustenta 99,99%, e a 99,9% só depois de medir | Ingestão replicada para 99,9%; 99,99% exige banco com failover (três nós), deploy sem interrupção, medição e ensaios; nada disso existe nem é prometido |
| Ingestão de API | 99,99% | Coletor e `rollup` no `prod.yaml`, na mesma VPS, atrás do Caddy (ADR 0012); nunca aplicado numa conta real | Teste externo do host OTLP (`API_URL` do monitoramento) | Réplica do coletor e medição numa produção real |
| Painéis (portal e API de leitura) | 99,90% | **Nenhum número comprometido**, relato de medição | Uma VPS: orçamento de 43 min/mês é consumido por um deploy ruim ou uma queda da VPS | Réplica e failover do banco, portal replicado |
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
| Ingestão de API | `POST` sem chave em `API_URL` (opcional em `infra/monitoring/configure.sh`), espera o 401 do coletor | Existe se `API_URL` for definido; não prova que uma métrica é gravada |

Limites honestos do indicador atual:

- `/healthz` prova que o gateway responde, **não** que um evento é aceito de ponta a ponta (prova de JS, `ingest_site`, Umami, banco). Um gateway no ar com o Umami fora aparece como disponível. Uma sondagem sintética de `POST /e` com site de teste é melhoria necessária e **não existe**.
- A sondagem parte de **um** ponto de vista (um host de monitoramento, separado da VPS). Uma falha de rede do monitor pareceria queda da produção, e o contrário também.
- A resolução é de 15 s; quedas menores podem passar.

### 3.2 Cálculo (proposto, não executado)

Com os dados do Prometheus do monitor (retenção de **30 dias**, `--storage.tsdb.retention.time=30d` em `infra/monitoring/compose.yaml`), por componente:

```promql
avg_over_time(probe_success{job="endpoints", component="<componente>"}[30d])
```

Esta expressão e o rótulo `component` (usado em `alerts.yml`) **não foram executados** contra dados reais. Como a retenção é de 30 dias, um mês de 31 dias perde o primeiro dia: gere o relato no último dia do mês, ou aumente a retenção antes de assumir qualquer número. Os valores guardados no relato mensal são a evidência de longo prazo.

### 3.3 Janela e exclusões

- **Janela:** mês-calendário em UTC.
- **Exclusões propostas** (precisam ser registradas no relato, com horário e motivo): manutenção avisada com pelo menos 72 h de antecedência no portal ou em issue pública, limitada a um total de 60 min por mês; falha do cliente ou da rede do tenant; indisponibilidade comprovada do provedor de hospedagem (registro da página de status do provedor); queda causada por abuso (ataque de volume) enquanto o Caddy não tem limite por IP (ADR 0006). Falha de deploy, de migração ou de renovação de certificado **não** é exclusão.
- Queda do próprio host de monitoramento: o período sem dados é contado como desconhecido e declarado no relato, não como disponível.

### 3.4 Relato mensal

Até o 5º dia útil do mês seguinte, uma nota pública em `docs/` ou issue, com: disponibilidade por componente, minutos de indisponibilidade, cada incidente (início, fim, causa, correção), exclusões aplicadas, e as vulnerabilidades críticas e altas do mês com o tempo até a correção. Ainda **não existe** automação nem modelo; o primeiro relato exige criar ambos.

## 4. O que é preciso para cada meta

A produção é uma VPS só, com Docker Compose ([ADR 0016](adr/0016-producao-em-vps.md)). Réplica de ingestão, réplica do Postgres, failover e balanceador **não existem** no repositório: foram retirados por estarem fora do que o RFP exige. Para referência, o que cada meta exigiria:

- **99,9% na ingestão:** duas ou mais instâncias de ingestão atrás de balanceador ou IP flutuante, deploy rotativo, pager além do e-mail.
- **99,9% nos painéis:** réplica do Postgres com promoção ensaiada, portal replicado com uma só instância migrando.
- **99,99%:** os dois itens acima mais banco com três nós, failover medido em segundos, ponto de vista de monitoramento múltiplo, 12 meses de experiência de medição. **Não é prometido.**

O gateway já pode servir a `ingest_site` vencida quando o banco falha (`SITE_STALE_TTL`, desligado por padrão). Isso **não** muda o compromisso: nenhum número é prometido.

## 5. Resposta a vulnerabilidades críticas e altas

Processo existente, a reaproveitar: [`SECURITY.md`](../SECURITY.md) (relato privado pela aba Security do GitHub), [`docs/runbooks/vulnerabilidades.md`](runbooks/vulnerabilidades.md) (contenção, correção, release, verificação), release assinada com cosign e atestado de SBOM (`.github/workflows/release.yml`), e o deploy pelo `deploy.sh` (`docs/deploy.md`), que por padrão constrói as imagens do checkout; imagens de release podem ser usadas por digest, mas nada confere a assinatura automaticamente.

Roteiro para crítica, contado do recebimento ou da identificação interna, não da classificação (para alta, o fim é o 14º dia; a contenção deve ocorrer em até 72 h sempre que possível):

| Tempo | Passo |
|---|---|
| 0 a 48 h | Confirmar o recebimento, reproduzir e classificar (CVSS 3.1). Aplicar **contenção** do runbook (revogar chave, bloquear projeto, rebaixar operador, parar o serviço) |
| 48 h a 5 dias | Corrigir em branch privada ou advisory privado, com teste que falha antes; CI verde |
| até 6 dias | Release (`vX.Y.Z`) e imagens assinadas |
| até 7 dias | Deploy (`deploy.sh`), verificação do passo 3 ("Check production") de `docs/deploy.md` e nova checagem |
| depois | Divulgação (advisory) |

**Dependência externa.** Se não houver correção upstream, contenha o impacto e comunique o risco de não cumprir o prazo; contenção não conta como correção. Correções críticas ou altas podem dispensar a espera de 14 dias de forma específica e documentada, conforme o [runbook](runbooks/vulnerabilidades.md). O Renovate pode oferecer atualizações de segurança antes do prazo quando os alertas do GitHub estiverem ativos, mas não está instalado; o pnpm possui sua própria regra e exige exceção específica.
**Lacunas conhecidas:**
- Dois mantenedores, sem plantão definido; os prazos incluem noites, fins de semana e feriados.
- A release assinada nunca rodou de verdade (não há release publicada), e o deploy não confere assinatura; o runbook diz o mesmo.
- Deploy numa VPS só interrompe o serviço; não há deploy rotativo.
- Retirar uma versão vulnerável do script de rastreamento não é trivial (ver o runbook).

## 6. Pendências e decisões em aberto

- Plantão, sondagem de ponta a ponta, relato mensal. Alta disponibilidade está fora do escopo (ADR 0016); voltar a ela exigiria uma decisão nova.

## 7. O que este documento ainda não faz

Nenhuma medição existe; nada aqui foi exercitado numa produção real. Não há sondagem sintética de ponta a ponta, relato mensal automatizado nem pager. O canal privado de vulnerabilidades foi ativado em 19/11/2026.
