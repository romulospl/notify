# Política de segurança

O notify recebe dados de uso de vários projetos (tenants). Vulnerabilidades que permitam ler dados de outro tenant, burlar a chave de ingestão, persistir dados pessoais (como o IP completo) ou inflar métricas são tratadas como prioridade.

## Como relatar uma vulnerabilidade

**Não abra issue pública** para vulnerabilidades.

Use o relato privado do GitHub: na aba **Security** do repositório, clique em **Report a vulnerability**. O relato fica visível só para os mantenedores até a correção ser publicada.

Inclua, se possível:

- o componente afetado (portal, script de rastreamento, gateway, coletor, infraestrutura);
- os passos para reproduzir e o impacto esperado;
- a versão (commit, versão do script `/s/vX.Y.Z/` ou tag de release).

## Prazos de resposta

| Etapa | Prazo |
|---|---|
| Confirmação de recebimento | até 3 dias úteis |
| Avaliação inicial e severidade | até 7 dias corridos |
| Correção de severidade crítica | até 14 dias corridos |
| Correção de severidade alta | até 30 dias corridos |
| Correção de severidade média ou baixa | até 90 dias corridos |

A severidade segue o CVSS 3.1. Depois da correção publicada, divulgamos um advisory no GitHub e damos crédito a quem relatou, se a pessoa quiser.

## Versões suportadas

| Componente | Suportado |
|---|---|
| Plataforma hospedada (`main`) | Sim, sempre a versão em produção |
| Script de rastreamento | A versão mais recente de cada versão maior. Versões publicadas são imutáveis: correções saem em uma versão nova, e os tenants afetados são avisados |
| Releases antigas do repositório | Não |

## Escopo

Fora do escopo: ataques que exigem acesso físico ou credenciais já comprometidas do tenant, negação de serviço por volume e relatos automáticos de scanners sem prova de impacto.
