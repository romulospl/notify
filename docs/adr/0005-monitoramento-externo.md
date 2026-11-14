# 0005. Monitoramento externo com Prometheus, numa VM separada

- **Status:** Aceito
- **Data:** 14/11/2026
- **Issue:** [#15](https://github.com/romulospl/notify/issues/15)
- **Depende de:** [ADR 0002](0002-arquitetura-e-stack.md), [ADR 0004](0004-hospedagem-e-backup.md)

## Contexto

A #15 pede que os endpoints de ingestão (web e API) e os painéis sejam monitorados **de fora**, com alerta quando caírem, e com a configuração versionada no monorepo. O ADR 0002 previu Prometheus, Grafana e Alertmanager em `infra/monitoring`.

A produção é uma VM só (ADR 0004). Um monitor dentro dela cai junto com ela, justamente no caso mais grave.

## Decisão

1. **Uma segunda VM, pequena, em outro data center da Hetzner** (`fsn1`, Falkenstein; a produção fica em `nbg1`). Uma regra do OpenTofu impede pôr as duas no mesmo local. Firewall só com SSH das redes de administração.
2. **Prometheus + blackbox exporter + Alertmanager**, em Docker Compose (`infra/monitoring/`), com os mesmos papéis `base` e `docker` do Ansible da produção (`infra/ansible/monitoring.yml`).
3. **O que é testado**, por HTTPS, como um cliente vê:
   - o portal (`/api/auth/ok`);
   - o gateway web (`/healthz`);
   - a ingestão de API, quando o coletor (#30) estiver publicado na produção (variável `monitor_api_url`).

   Os testes rodam a cada 15 segundos.
4. **Alertas por e-mail:**
   - `EndpointDown`: sem resposta 2xx por 1 minuto;
   - `TLSCertificateExpiringSoon`: certificado vencendo em menos de 14 dias, sinal de que a renovação automática falhou;
   - `ProbeFailing`: o Prometheus não consegue nem pedir o teste ao blackbox (sem isso, o alvo ficaria sem `probe_success` e nenhum alerta dispararia);
   - `ProberDown`: o próprio blackbox fora do ar;
   - e-mail de resolvido quando o problema passa.
5. **Sinal de vida opcional:** um alerta sempre ativo (`Watchdog`) vai a cada 5 minutos para um serviço externo de sinal de vida, se configurado. Se ele parar de chegar, quem caiu foi o monitor.
6. **Sem Grafana por enquanto.** Para alertar, basta o Prometheus; a interface dele e a do Alertmanager ficam acessíveis pelo túnel SSH. Os painéis do Grafana entram quando houver métricas internas para mostrar.

## Alternativas consideradas

| Alternativa | Prós | Contras |
|---|---|---|
| Monitor na própria VM de produção | Sem custo extra | Cai junto com a VM; não é monitoramento externo |
| Serviço de uptime hospedado (SaaS) | Nada para operar | Dependência externa, nem sempre de código aberto; a configuração fica fora do repositório |
| Uptime Kuma numa VM separada | Interface pronta, muitos canais de alerta | A configuração vive no banco dele, não em arquivos versionados (critério da #15) |
| Prometheus com Grafana desde já | Painéis prontos | Mais um serviço e mais uma senha, sem métricas internas para mostrar ainda |

## Consequências

- **Custo:** mais uma VM, a menor que a Hetzner oferecer.
- **O monitor também precisa de vigia:** sem o sinal de vida externo, a queda da VM de monitoramento passa despercebida. Por isso o guia recomenda configurá-lo.
- **O que ainda não é monitorado:**
  - a ingestão de API, até o coletor ser publicado;
  - métricas internas da produção (disco, memória, tempo de resposta do banco);
  - a idade do último backup.

  Os dois últimos entram junto com o Grafana.
- **A configuração é testada no CI** (job `monitoring`):
  - testes de unidade das regras (`promtool test rules`);
  - o intervalo do sinal de vida na configuração gerada;
  - ponta a ponta, o teste derruba um alvo e confere o e-mail de alerta, o de resolvido e o sinal de vida, com o mesmo template de configuração que o Ansible usa.
