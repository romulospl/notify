# 0001. Umami como ferramenta base de analytics web

- **Status:** Aceito
- **Data:** 13/11/2026
- **Issue:** [#10](https://github.com/romulospl/notify/issues/10)

## Contexto

O RFP "Web and API Analytics for Stellar Ecosystem Projects" do Stellar Community Fund exige que a plataforma seja construída sobre **Umami** ou **GoatCounter** e que a proposta justifique a escolha. A justificativa é um dos critérios de avaliação.

Requisitos do RFP que pesam na escolha:

- multi-tenant com isolamento estrito e visão global para operadores do SCF;
- métricas de API gravadas em **PostgreSQL**;
- todo o código sob licença aprovada pela **OSI**;
- conformidade com a GDPR sem opt-in (sem cookies);
- transferência para outra equipe da comunidade entre o 6º e o 12º mês de operação;
- painel com visualizações de página, visitantes únicos, referenciadores, duração da sessão, taxa de rejeição, país, dispositivo e navegador.

## Decisão

Usar o **Umami**, fixado na versão **v3.4.1** (imagem e tag exatas no Docker Compose e na IaC).

A v3.5.0 foi publicada em 12/11/2026, um dia antes desta decisão. Seguindo a política contra ataques à cadeia de suprimentos, só adotamos uma release depois de pelo menos duas semanas de publicada. A atualização para a 3.5.x será feita em PR próprio, de forma intencional.

O Umami será usado como **motor headless** (ingestão, armazenamento e API de estatísticas), com o mínimo possível de alterações no código original. A interface para tenants e operadores fica no portal próprio (ver [ADR 0002](0002-arquitetura-e-stack.md)).

## Comparação

Dados levantados no GitHub em 13/11/2026.

| Critério | Umami | GoatCounter |
|---|---|---|
| Licença | **MIT** (aprovada pela OSI) | EUPL 1.2 **modificada** (apêndice de licenças compatíveis alterado). Uma licença modificada não é, formalmente, a licença aprovada pela OSI |
| Linguagem e stack | TypeScript, Next.js 16, React 19, Prisma 7 | Go, binário único |
| Banco de dados | **Só PostgreSQL** (desde a v3) | SQLite ou PostgreSQL |
| Atividade | Releases mensais (v3.3.1 em ago/2026, v3.4.0 em set, v3.4.1 em out, v3.5.0 em nov); último push em 12/11/2026 | Releases espaçadas (v2.5.0 em dez/2023, v2.6.0 em jun/2025, v2.7.0 em dez/2025) |
| Mantenedores | Equipe com 3 mantenedores principais e muitos contribuidores | Essencialmente uma pessoa (cerca de 2.100 commits do autor contra menos de 5 de cada outro contribuidor) |
| Comunidade | cerca de 40 mil estrelas | cerca de 6 mil estrelas |
| Multi-site e equipes | Nativo: modelos `Team`, `TeamUser` e `Website` | Multi-site, com menos recursos prontos de equipes |
| API de estatísticas | Endpoints `/api/websites/{id}/stats` e `/metrics`, com autenticação e chaves de API (`ApiKey`) | API mais simples |
| Cookies | Não usa | Não usa |
| IP do cliente | Lê o header definido em `CLIENT_IP_HEADER`, o que permite entregar o IP já truncado | Lógica própria |
| Personalização anti-adblock | `TRACKER_SCRIPT_NAME` e `COLLECT_API_ENDPOINT` | Possível, com menos opções prontas |

## Justificativa

1. **Licença:** MIT é aprovada pela OSI sem ressalvas. A EUPL modificada do GoatCounter abre uma discussão que o RFP não precisa ter.
2. **PostgreSQL:** o RFP exige Postgres para as métricas de API, e o Umami usa só Postgres. Um banco único simplifica a operação, o backup e a transferência.
3. **Multi-tenant:** equipes e sites já existem no modelo de dados e no controle de acesso do Umami, então o isolamento parte de algo pronto.
4. **Continuidade e transferência:** o Umami tem equipe de mantenedores e releases frequentes. O GoatCounter depende de uma pessoa, o que é um risco para 12 meses de operação e para a entrega a outra equipe.
5. **Métricas mínimas:** o Umami já calcula visualizações, visitantes, visitas, rejeições e tempo total, além de referenciadores, país, dispositivo e navegador.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **GoatCounter** | Licença modificada, um único mantenedor e menos recursos de equipes. Só faria sentido se a prioridade fosse custo mínimo de hospedagem, o que não é o caso |
| **Fork pesado do Umami** | Dificulta as atualizações de segurança (o RFP pede vulnerabilidades críticas e altas corrigidas em 24 h). Preferimos o Umami original, com patches mínimos e documentados |

## Consequências

- O Umami **não tem cadastro aberto**: a criação de usuários passa por `canCreateUser` e exige administrador. O cadastro self-service fica no portal, que cria usuário, equipe e site pela API do Umami com uma conta de serviço.
- O Umami **não tem painel comparativo entre sites** nem métricas de API: os dois ficam no portal.
- O Umami tem recursos que **precisam ficar desligados** por privacidade, como gravação de sessão (`SessionReplay`) e heatmaps, e isso precisa de testes que confirmem.
- O IP chega ao Umami **já truncado** pelo gateway de ingestão, pelo header de `CLIENT_IP_HEADER`. O Umami nunca vê o IP completo.
- O script de rastreamento original não tem prova de execução de JS nem versão fixa no caminho. Teremos um script próprio, compatível com o payload do `/api/send`.
- A versão do Umami fica fixada e só sobe por PR, depois de revisar o changelog.

## A confirmar na implementação

- ~~Que `/api/websites/{id}/stats` e `/metrics` da v3.4.1 retornam todas as métricas mínimas no formato esperado.~~ **Confirmado na [#28](https://github.com/romulospl/notify/issues/28) (14/11/2026)**, contra o Umami 3.4.1 local com eventos enviados por `/api/send`: `/stats` devolve `pageviews`, `visitors`, `visits`, `bounces` e `totaltime` (a duração média da visita é `totaltime / visits` e a taxa de rejeição é `bounces / visits`), mais o período anterior de mesmo tamanho em `comparison`; `/metrics?type=referrer|country|device|browser` devolve listas `{x, y}` ordenadas, em que `y` conta **visitantes** (sessões únicas), não visualizações, e aceita `limit`; o país vem como código ISO, e o navegador como o identificador do `detect-browser` (`chrome`, `ios`, `edge-chromium`). A série no tempo vem de `/pageviews?unit=hour|day|month&timezone=UTC`, só com os baldes que têm dados. Um `type` desconhecido responde 400.
- ~~Que as chaves de API do Umami bastam para a conta de serviço do portal, sem usar a senha de administrador.~~ **Confirmado na [#58](https://github.com/romulospl/notify/issues/58) (13/11/2026):** na v3.4.1 sem `CLOUD_MODE`, a chave de API (`Authorization: Bearer umami_...`) age como o usuário dono dela. A conta de serviço é um usuário comum (papel `user`, não administrador), que cria, lista, lê e apaga os próprios sites; as rotas `/api/users`, `/api/admin`, `/api/auth` e `/api/me/api-keys` recusam a chave. A senha de administrador só é usada uma vez, pelo script `apps/portal/scripts/umami-service-account.mjs`, e o portal guarda apenas a chave. Limite: a chave também consegue criar equipes (o papel `user` tem `team:create`); o portal não usa essa rota (ADR 0003), e só o cliente em `apps/portal/src/lib/umami/` chama o Umami. O job `compose` do CI repete a verificação.
