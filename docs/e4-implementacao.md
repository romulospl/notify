# E4: o que foi implementado

Registro da implementação do épico [E4 (#4)](https://github.com/romulospl/notify/issues/4), painéis de analytics web, iniciado em **14/11/2026**. O E4 não tem spec próprio: ele roda todo dentro do portal e usa contratos que já existem, o isolamento do [ADR 0003](adr/0003-isolamento-no-portal.md) e da seção 4 do [spec do E2](specs/e2-tenants-e-controle-de-acesso.md), e a API do Umami 3.4.1 conferida no [ADR 0001](adr/0001-ferramenta-base.md).

## 1. Situação

| Issue | O que é | Situação |
|---|---|---|
| [#28 (4.1)](https://github.com/romulospl/notify/issues/28) | Painel web do tenant com as 7 métricas mínimas | Feita |
| [#29 (4.2)](https://github.com/romulospl/notify/issues/29) | Painel web global do SCF, com comparação entre projetos | Pendente |

## 2. #28: painel web do tenant

**Onde:** `/sites/[siteId]` (`apps/portal/src/app/(private)/sites/[siteId]/`). O nome do site em `/sites` e a lista "Web analytics" em `/dashboard` levam ao painel.

**O que mostra, para o período escolhido:**

| Métrica | De onde vem |
|---|---|
| Visualizações de página | `/stats` → `pageviews` |
| Visitantes únicos | `/stats` → `visitors` |
| Duração média da visita | `/stats` → `totaltime / visits` |
| Taxa de rejeição | `/stats` → `bounces / visits` |
| Referenciadores | `/metrics?type=referrer` |
| País | `/metrics?type=country` |
| Dispositivo e navegador | `/metrics?type=device` e `?type=browser` |

Além disso: a variação de cada indicador sobre o período anterior de mesmo tamanho (`comparison` do `/stats`), as visualizações ao longo do período (`/pageviews`) e as 10 primeiras linhas de cada lista.

**Leitura do Umami:** `getSiteDashboard` em `src/lib/umami/stats.ts`. Recebe o `TenantContext` e o ID do site do portal, confere que o site é do tenant (`getSite`) e só então faz as 6 chamadas ao Umami, em paralelo. Site de outro tenant ou arquivado devolve nulo sem nenhuma chamada.

**Escolhas:**

- **Períodos** fixos em `src/lib/period.ts`: últimas 24 horas (por hora), 7, 30 e 90 dias (por dia) e 12 meses (por mês). O padrão é 7 dias, e qualquer valor fora da lista na URL vira o padrão. O período termina agora e começa no início de um balde, sempre em **UTC**, como as outras datas do portal: "Last 7 days" são os 6 dias anteriores inteiros mais o dia de hoje até agora, não 168 horas exatas. É a mesma convenção dos períodos do próprio Umami, e o subtítulo do gráfico diz que o balde atual está incluído. Não há período personalizado.
- **Baldes vazios:** o Umami só devolve os baldes com dados; o portal preenche os outros com zero, para o gráfico ter um ponto por hora, dia ou mês.
- **As listas contam visitantes**, não visualizações: é o que o `y` do `/metrics` conta no Umami 3.4.1. A coluna se chama "Visitors".
- **Nomes:** país pelo `Intl.DisplayNames` (o Umami grava o código ISO), navegador por uma tabela dos identificadores do Umami (`ios` vira "Safari (iOS)"), com o próprio identificador como reserva.
- **Variação:** em porcentagem para visualizações, visitantes e duração; em pontos percentuais para a rejeição, em que subir é ruim (vermelho). Sem dados no período anterior, aparece "No data for the previous period". As cores de alta boa e ruim vêm sempre com seta e texto.
- **Gráfico:** colunas de uma série só, com a cor validada para os modos claro e escuro (skill `dataviz`), tooltip ao passar o mouse ou ao focar pelo teclado e uma tabela equivalente em "Show as table".
- **Projeto removido** vê só o aviso, sem chamar o Umami (spec do E2, seção 6). **Umami fora do ar** mostra um aviso na página; o detalhe do erro fica só no log.

**Testes:**

- `test/web-dashboard.test.ts`: períodos, formatação, parâmetros enviados ao Umami e preenchimento dos baldes; a página renderizada (`renderToStaticMarkup`), conferindo as 7 métricas, a variação, o período ativo, uma coluna e uma linha da tabela por balde; site de outro tenant, projeto removido e Umami fora do ar. Conferido que tirar uma lista ou zerar uma métrica da página faz o teste falhar;
- `test/isolation.test.ts`: dois casos do painel (#21);
- o Umami falso (`test/fake-umami.ts`) ganhou `/pageviews` e `/metrics`, no formato do 3.4.1.

**Revisão independente** de um worker Codex: sem falha de isolamento; os dois pontos levantados (convenção dos períodos e testes da página que não renderizavam os componentes) foram tratados.

**Conferido no navegador** com o Umami 3.4.1 local e cerca de 160 visualizações de teste: claro e escuro, desktop e 390px de largura, períodos de 7 e 30 dias e de 12 meses.

## 3. Limites e pendências

- **#29:** o painel global compara todos os projetos. Pela API do Umami, isso é uma leitura por site para cada período, o que cresce com o número de projetos. Se pesar, a alternativa (ler o banco do Umami direto ou guardar um resumo) muda o que o ADR 0002 decidiu e vira ADR novo.
- **Sem cache:** cada abertura do painel faz 6 chamadas ao Umami. Para os pilotos isso basta.
- **Período personalizado e fuso do usuário** ficaram de fora; tudo é UTC.
- Eventos customizados (#50) e filtros por página ou referenciador ficam para depois do MVP.
