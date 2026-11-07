# Planejamento do MVP — Agente de Atendimento GoGroup

Status: planejamento consolidado para orientar a implementação; funcionalidades ainda não implementadas.

Data: 07/11/2026.

Nome do produto:GoBia. Desafio: Atendimento ao Cliente — GoHacks Talent.

## 1. Objetivo e proposta

Construir um colega de atendimento com IA que reúna o contexto de contatos por diferentes canais, investigue pedidos, execute ações permitidas, envolva a pessoa certa nas exceções e acompanhe o caso até a resolução.

O MVP deve provar um fluxo operacional completo. Responder mensagens, classificar contatos ou apresentar um dashboard são partes desse fluxo, não seu resultado final.

Frente principal: rastreio, atraso e resolução de problemas de entrega. Trocas e outros motivos terão identificação, explicação de política e encaminhamento; a execução completa dessas frentes é extensão, condicionada à conclusão do fluxo principal.

O atendimento deve reconhecer a estrutura da holding e preservar o contexto da unidade de negócio, marca e produto em todas as etapas. Na base, a unidade de beleza é denominada **GoBeauté** (referida pelo usuário como GoBeauty); preservar os valores originais e tratar variações de nome por aliases. Não confundir unidade de negócio com marca comercial ou presumir uma estrutura jurídica que a base não descreve.

### Contextos das unidades de negócio

| Contexto | Dados necessários e cuidados |
| --- | --- |
| Gocase | Cases, garrafas e acessórios; SKU, compatibilidade, tipo e texto de personalização, prazo de preparo, CD e máquina quando disponíveis. Distinguir erro de personalização, defeito, separação e transporte. |
| GoBeauté e suas marcas | Usar a marca específica do produto, composição, modo de uso, advertências, lote, validade e campanhas. Distinguir dúvida, preferência de fragrância, vazamento, item faltante e relato de reação adversa. |

As marcas GoBeauté descritas na base incluem Ápice, Barbour's, Kokeshi, Rituária, Lescent, By Samia, Auá e Yenzah. A identificação deve vir do catálogo/pedido, não de uma lista presumida pelo modelo. Um mesmo cliente pode comprar em mais de uma unidade; seu histórico não determina a marca do caso atual.

### Mantras traduzidos em comportamento

| Mantra | Comportamento demonstrável |
| --- | --- |
| Mente aberta | Aceitar correções humanas, explicitar incertezas e revisar propostas quando surgirem novas evidências. |
| Ponta firme | Acompanhar pendências, prazos e falhas até um desfecho verificável. |
| Transparência máxima | Registrar fontes, regras, ações e resultados, distinguindo execução real de simulação. |
| Time campeão | Acionar o responsável com contexto e uma decisão objetiva a tomar. |
| Amor pelo cliente | Evitar repetição de informações, respeitar preferências e comunicar próximos passos verdadeiros. |

## 2. Escopo e prioridades

### P0 — Fluxo que precisa funcionar

- Importar a base fornecida sem modificar os CSVs originais.
- Exibir a fila e reunir conversas do mesmo cliente/pedido em um caso operacional, com confirmação das associações.
- Receber mensagens por adaptador de demonstração para WhatsApp, e-mail e Reclame Aqui.
- Usar Claude para interpretar solicitações, investigar com ferramentas e produzir respostas fundamentadas.
- Consultar pedido, rastreio, políticas e contexto do cliente.
- Resolver unidade, marca e SKU antes de selecionar conhecimento e comunicação; explicitar contexto desconhecido ou conflitante.
- Investigar a origem provável do problema com evidências, separando produção, separação/CD, transportadora, pagamento e informação insuficiente.
- Abrir chamado de transportadora e preparar reenvio/reembolso no ambiente simulado.
- Validar elegibilidade, alçadas, evidências e duplicidade antes de qualquer ação.
- Permitir aprovação, suspensão e encaminhamento humano.
- Executar janela opcional de revisão para ações elegíveis, com processamento persistente.
- Retomar o atendimento após decisão humana e registrar o resultado.
- Manter trilha de auditoria e identificar claramente operações simuladas.
- Apresentar três casos de demonstração reproduzíveis.

### P1 — Compor a experiência acordada

- Estatísticas de resolução, SLA, tempo, custo, reabertura e satisfação.
- Pesquisa ao encerrar um caso, com tratamento de respostas negativas.
- Assistente interno de consulta a termos, políticas e caso selecionado.
- Roteamento entre modelos, se o proxy oferecer pelo menos dois modelos compatíveis.
- Notificação interna persistente; webhook externo se houver integração disponível.

### Extensões após o fluxo principal

- Um canal real de entrada e saída, conforme acesso disponível.
- Execução completa de trocas e reimpressão com o mesmo mecanismo de autorização.
- Notificações proativas e investigação de problemas recorrentes.

### Fora do MVP

- Integrar simultaneamente todos os canais reais e sistemas corporativos.
- Movimentar dinheiro real ou realizar envios reais durante a demonstração.
- Treinar ou ajustar pesos de um modelo de linguagem.
- Treinar um classificador supervisionado sem rótulos revisados.
- Diagnosticar condições médicas, decidir fraude autonomamente ou ampliar alçadas automaticamente.
- Criar vários agentes independentes antes de demonstrar necessidade.

## 3. Base recebida e limites de interpretação

Fonte canônica: `BD/`. A pasta extraída alternativa contém cópias idênticas e não deve ser importada junto.

Inventário verificado:

| Conteúdo | Quantidade |
| --- | ---: |
| Arquivos CSV | 24 |
| Conversas históricas | 2.984 |
| Mensagens | 13.731 |
| Conversas na fila | 65 |
| Pedidos | 6.092 |
| Clientes | 2.867 |
| Ações históricas | 4.856 |
| Eventos de rastreio | 26.517 |
| Ferramentas descritas | 35 |

Documentos de referência: `BD/parametros.md` e `BD/dicionario_de_dados.md`. Regras e catálogo de ferramentas foram entregues em CSV, apesar de os documentos mencionarem JSON.

Regras para ingestão e análise:

- Dados sintéticos; não apresentar resultados do protótipo como resultados reais da empresa.
- Histórico amostrado por cliente; fila aberta em volume cheio. Não extrapolar volume ou economia automaticamente.
- Relógio inicial do cenário: 02/11/2026 às 08:00. Não usar a data da máquina para calcular atrasos da simulação.
- Há 243 pedidos com data posterior a 02/11; disponibilizar cada registro somente no momento adequado.
- Filtrar eventos e evidências pela data disponível no cenário; não usar fatos futuros em decisões passadas.
- Preservar identificadores como texto, valores monetários em centavos e datas com interpretação temporal explícita.
- Usar chave composta de lote e SKU; lote sozinho não é único.
- As 330 conversas sem tag não devem receber rótulos inventados durante a importação.
- Tags de assunto não representam complexidade, urgência ou autorização.
- Imagens originais não foram distribuídas: trabalhar com descrições e metadados, sem alegar análise visual própria.
- O catálogo de ferramentas é uma especificação, não uma integração executável.
- Históricos podem conter falhas humanas; não transformá-los diretamente em exemplos ideais.

## 4. Arquitetura proposta

### Stack de referência

- Aplicação web única em TypeScript, com Next.js e React para interface e rotas de servidor, publicada na Vercel.
- Supabase PostgreSQL como banco online persistente, com migrations SQL, API e acesso por repositórios usando `supabase-js`.
- Supabase Auth para login dos funcionários e sessão integrada ao Next.js; autorização por papel, unidade e marca.
- Supabase Cron aciona uma rota interna autenticada na Vercel para processar lotes curtos de tarefas persistidas: timers, acompanhamento, notificações e retentativas. Não depende de processo Node.js permanentemente ativo.
- RAG em TypeScript com Full Text Search nativo do PostgreSQL, sem embeddings ou serviço vetorial adicional no MVP.
- Cliente de IA no servidor, por adaptador configurável para a API/proxy disponibilizado no evento.
- Validação de entradas e saídas estruturadas com schemas.
- Estilização com componentes reutilizáveis e CSS/Tailwind, conforme dependências escolhidas na implementação.

Versões e bibliotecas específicas serão fixadas ao iniciar o projeto, após verificar o ambiente. Somente URL e chave publicável do Supabase podem ir ao navegador; chave secreta/service role, credencial do Cron e chave do Claude ficam exclusivamente no servidor.

Vercel e Supabase passam a ser os destinos definidos para a aplicação e persistência. Não armazenar banco, timers ou estado necessário em arquivos locais da Vercel ou apenas em memória. Desenvolvimento usa Supabase local via CLI ou projeto de desenvolvimento isolado; não manter uma implementação paralela em SQLite.

### Agendamento serverless e publicação

- Cron proposto: uma chamada por minuto para `POST /api/internal/jobs/process`, com segredo dedicado armazenado de forma segura no agendador e na Vercel. Frequência deve ser validada contra cotas e carga.
- A rota seleciona tarefas vencidas por operação transacional no PostgreSQL, com reserva temporária (lease), limite de lote, número de tentativas e chave de idempotência. Não fazer seleção e reserva em chamadas independentes suscetíveis a corrida.
- Cada invocação tem orçamento abaixo do limite de duração da função. Fluxos longos persistem progresso e continuam em outra invocação; nunca aguardar duas horas dentro de uma função ou depender de processamento após encerrar a resposta HTTP.
- Tarefas abandonadas por timeout podem ser retomadas após expirar a reserva; confirmar efeito externo antes de repetir ação de resultado incerto. A entrega é repetível, mas o efeito precisa ser idempotente.
- O vencimento torna a ação elegível para a próxima rodada, não garante execução no segundo exato. Mostrar atraso operacional e revisar a promessa ao cliente se o processamento estiver indisponível.
- Em produção usar timestamps UTC e relógio confiável; na demonstração usar relógio do cenário isolado, sem disparar ações de outros ambientes.
- Cron aponta para URL estável de produção, nunca para preview descartável. Previews usam ambiente isolado e não executam tarefas da produção. Configurar acesso do agendador caso a proteção de deploy esteja ativa.
- Planejar uso do plano gratuito do Supabase dentro das cotas, sem prometer custo zero ilimitado. Verificar capacidade, pausa por inatividade e cotas de invocações antes da banca. Confirmar plano Vercel adequado ao uso empresarial e seus limites; não presumir elegibilidade ao Hobby gratuito.
- Login, política de acesso, callbacks de autenticação e variáveis de ambiente devem ser verificados no domínio publicado.

Referências técnicas: [busca textual Supabase](https://supabase.com/docs/guides/database/full-text-search), [Supabase Cron](https://supabase.com/docs/guides/cron/quickstart), [limites de funções Vercel](https://vercel.com/docs/functions/limitations). Verificar versões e limites novamente na implementação.

### Componentes e responsabilidades

```text
Canais reais ou simulados
        |
        v
Adaptadores -> Ingestão e deduplicação -> Caso e mensagens
                                            |
                                            v
                                  Orquestrador de atendimento
                                   /        |          \
                            Roteador IA  Conhecimento  Ferramentas de consulta
                                            |
                                            v
                                  Proposta estruturada de ação
                                            |
                                            v
                             Motor determinístico de políticas
                                   /        |           \
                              Executar   Revisão       Aprovação obrigatória
                                   \        |           /
                               Supabase Cron -> Executor na Vercel
                                            |
                                            v
                               Resultado + auditoria + comunicação

Dashboard -> Serviços autenticados -> Casos, decisões, métricas e auditoria
Assistente interno -> Apenas consultas autorizadas e recuperação de políticas
```

O modelo escolhe ferramentas de investigação e propõe próximos passos dentro de um orçamento de execução. O servidor valida cada chamada e cada efeito. Texto do cliente nunca altera políticas, papéis ou permissões.

## 5. Estrutura de arquivos

```text
/
├── README.md
├── .env.example
├── .gitignore
├── package.json
├── BD/                              # Fonte original, somente leitura
├── docs/
│   ├── PLANEJAMENTO.MD              # Este planejamento
│   ├── arquitetura.md               # Decisões e limitações consolidadas
│   ├── demo.md                      # Roteiro, casos e recuperação de falhas
│   └── entrega.md                   # Textos, métricas e checklist da submissão
├── scripts/
│   ├── import-data.ts               # Importação validada e idempotente
│   ├── seed-demo.ts                 # Cenários derivados e explicitamente identificados
│   ├── reset-demo.ts                # Restaura apenas banco de demonstração
│   └── evaluate-agent.ts            # Executa conjunto fixo de avaliações
├── supabase/
│   ├── config.toml                  # Configuração local do Supabase
│   └── migrations/                  # Schema, RLS, busca textual, RPCs e agendamento
├── src/
│   ├── app/
│   │   ├── page.tsx                 # Redirecionamento para central
│   │   ├── atendimentos/page.tsx
│   │   ├── atendimentos/[id]/page.tsx
│   │   ├── estatisticas/page.tsx
│   │   ├── auditoria/page.tsx
│   │   ├── demonstracao/page.tsx
│   │   └── api/
│   │       ├── cases/               # Consulta, atribuição e decisões humanas
│   │       ├── webhooks/[channel]/  # Eventos de canais, com validação
│   │       ├── assistant/           # Consulta interna, sem ferramentas de escrita
│   │       ├── feedback/            # Pesquisa vinculada ao caso
│   │       ├── metrics/             # Agregados com filtros e denominadores
│   │       ├── internal/jobs/process/ # Endpoint autenticado chamado pelo Cron
│   │       └── demo/                # Eventos e relógio da demonstração
│   ├── components/
│   │   ├── cases/                   # Fila, resumo, evidências, aprovações
│   │   ├── audit/                   # Timeline e ações aguardando execução
│   │   ├── metrics/                 # Indicadores e gráficos
│   │   ├── assistant/               # Assistente interno contextual
│   │   └── ui/                      # Elementos visuais compartilhados
│   ├── server/
│   │   ├── config.ts                # Ambiente e validação de configuração
│   │   ├── auth/                    # Supabase Auth, sessão, papéis e acesso
│   │   ├── db/
│   │   │   ├── client.ts            # Cliente Supabase com sessão do usuário
│   │   │   ├── admin.ts             # Cliente privilegiado restrito a jobs/importação
│   │   │   └── repositories/
│   │   ├── agent/
│   │   │   ├── orchestrator.ts
│   │   │   ├── model-router.ts
│   │   │   ├── context-builder.ts
│   │   │   ├── output-schemas.ts
│   │   │   ├── prompts/
│   │   │   └── tools/               # Contratos de consulta e propostas de ação
│   │   ├── policies/
│   │   │   ├── engine.ts
│   │   │   ├── business-calendar.ts
│   │   │   └── authorization.ts
│   │   ├── business-context/
│   │   │   ├── resolver.ts          # Unidade, marca e SKU a partir de evidências
│   │   │   ├── brand-profiles.ts    # Identidade, fontes e contexto por marca
│   │   │   └── issue-origin.ts      # Hipóteses, evidências e área responsável
│   │   ├── knowledge/              # Recuperação de políticas e catálogo
│   │   ├── services/
│   │   │   ├── cases.ts
│   │   │   ├── approvals.ts
│   │   │   ├── actions.ts
│   │   │   ├── audit.ts
│   │   │   ├── feedback.ts
│   │   │   └── metrics.ts
│   │   ├── adapters/
│   │   │   ├── ai/                 # Proxy e provedor configuráveis
│   │   │   ├── channels/           # Simulação e futuro canal real
│   │   │   ├── operations/         # ERP, transportadora, reembolso simulados
│   │   │   └── notifications/      # Notificações internas e webhook opcional
│   │   └── jobs/                   # Processador por lote, leases, outbox e retentativas
│   ├── lib/supabase/client.ts       # Cliente de navegador com chave publicável
│   └── shared/                     # Tipos e schemas sem segredos de servidor
├── tests/
│   ├── policies.test.ts
│   ├── actions.test.ts
│   ├── workflow.test.ts
│   └── fixtures/
├── evaluations/
│   ├── cases.json                  # Exemplos revisados, sem dados futuros
│   └── rubric.md                   # Critérios de avaliação
└── runtime/                        # Relatórios locais temporários, ignorados no Git
```

Criar módulos à medida que os fluxos forem implementados; a árvore é uma orientação de responsabilidades, não uma exigência de gerar arquivos vazios.

## 6. Modelo de dados operacional

Separar tabelas importadas de eventos produzidos pelo MVP. Cada evento novo deve indicar origem, cenário, horário e se é simulado.

| Entidade | Responsabilidade |
| --- | --- |
| customers, orders, order_items | Contexto estruturado do cliente e do pedido. |
| conversations, messages | Conversas por canal e mensagens, preservando IDs de origem. |
| cases, case_conversations | Pendência operacional e vínculo com uma ou mais conversas. |
| tracking_events, attachments | Evidências com data e origem. |
| policies, policy_versions | Regras importadas e versão usada na decisão. |
| staff, assignments | Papéis, responsáveis e atribuições. |
| action_proposals | Ação, valor, justificativa, evidências e política aplicada. |
| approvals | Decisão humana, ator, escopo e validade. |
| action_executions | Execução, chave de idempotência, referência externa e resultado. |
| audit_events | Registro acrescentado a cada evento, sem sobrescrita pelo fluxo comum. |
| jobs, outbox_events | Agendamento e entregas persistentes com retentativas. |
| model_calls | Modelo, etapa, tokens, latência, custo conhecido e versão de preço. |
| feedback | Nota, resolução declarada, comentário e vínculo com o caso. |
| scenario_runs | Relógio, modo, identificador da execução e isolamento da demonstração. |
| business_units, brands, brand_aliases | Mapeamento de unidade, marca e nomes alternativos, derivado do catálogo. |
| issue_assessments | Origem investigada, estado da conclusão, evidências favoráveis/contrárias, lacunas e área acionada. |
| knowledge_documents | Trechos de políticas e catálogo, fonte, versão, vigência, unidade, marca, SKU e índice de busca textual. |

Persistir todas essas entidades no PostgreSQL. Associar funcionários a usuários do Supabase Auth e manter permissões em tabelas controladas pelo servidor. Importação ocorre por script administrativo em lotes, fora do ciclo de build e das requisições públicas; aplicar migrations versionadas e verificar contagens/referências após carga.

Casos e propostas referenciam `business_unit_id`, `brand_id` e os itens relevantes, permitindo contexto ainda desconhecido. Conhecimento e políticas têm escopo explícito (grupo, unidade, marca ou SKU), versão e vigência. A base atual fornece regras compartilhadas e condições por categoria; não inventar políticas distintas por marca. Regra específica só prevalece quando houver fonte autorizada que estabeleça a exceção; conflitos não resolvidos exigem revisão.

Uma conversa pode conter mais de uma necessidade. Manter solicitações pendentes explícitas e não encerrar o caso após resolver apenas uma delas.

Associação multicanal exige cliente/pedido verificados e assunto compatível. Mesmo pedido não significa automaticamente mesmo problema. Preservar os canais originais e não copiar dados privados para resposta pública.

### Estados

- Caso: `novo`, `em_investigacao`, `aguardando_cliente`, `aguardando_humano`, `aguardando_terceiro`, `em_execucao`, `resolvido`, `reaberto`.
- Ação: `proposta`, `bloqueada`, `aguardando_aprovacao`, `em_janela_revisao`, `pronta`, `executando`, `concluida`, `falhou`, `rejeitada`, `cancelada`.
- Resolução não equivale a mensagem enviada ou conversa encerrada. Registrar critério do desfecho e pendências remanescentes.
- Solicitar reembolso não equivale a valor creditado. Os estados e mensagens devem preservar essa distinção.

## 7. Fluxos principais

### 7.1 Entrada, investigação e ação

1. Validar evento do canal e deduplicar por identificador externo.
2. Identificar cliente e pedido; pedir informação quando a associação não for segura.
3. Criar ou associar caso e preservar mensagens de todos os canais vinculados.
4. Mascarar dados pessoais antes de enviar contexto ao modelo, conforme política fornecida.
5. Classificar intenção principal/secundária e apontar informações faltantes.
6. Consultar dados e regras relevantes por ferramentas.
7. Gerar proposta estruturada com evidências e próxima ação.
8. Validar no motor de políticas; o modelo não autoriza a própria proposta.
9. Executar, agendar revisão ou solicitar aprovação.
10. Comunicar o resultado confirmado e agendar acompanhamento necessário.

### 7.1.1 Identificação da empresa e contexto especializado

1. Usar o canal/conta de origem como pista, quando essa informação existir.
2. Confirmar pedido e itens vinculados ao cliente; cruzar `marca` e `unidade_negocio` do catálogo pelo SKU.
3. Tratar prefixos de pedido como indício auxiliar, nunca como única confirmação.
4. Se pedido, mensagem e catálogo divergirem, registrar o conflito e pedir esclarecimento antes de agir.
5. Carregar apenas políticas aplicáveis, ficha do produto e contexto necessário da marca.
6. Adaptar a comunicação à marca atendida, sem inventar tom oficial: usar padrão empático e transparente até existir orientação aprovada.
7. Não associar automaticamente contatos de marcas diferentes, mesmo que pertençam ao mesmo cliente.

### 7.1.2 Investigação da origem do problema

O agente deve responder a duas perguntas separadas: “como resolver a necessidade do cliente?” e “quais evidências explicam o problema?”. A solução permitida não deve ficar indefinidamente parada enquanto a causa interna é investigada.

| Hipótese | Evidências a consultar | Encaminhamento possível |
| --- | --- | --- |
| Produção/personalização Gocase | Personalização solicitada em `itens_pedido`, descrição do anexo, máquina e dados de produção disponíveis. | Produção/qualidade. |
| Separação ou embalagem | Itens e brindes esperados, campanha, CD, separação, descrição dos anexos e contatos relacionados. | Operação do CD/logística. |
| Transporte | Separação, sequência temporal do rastreio, confirmação de coleta quando disponível, previsão e resposta de chamados. | Logística/transportadora. |
| Produto ou lote GoBeauté | SKU, lote, descrição do relato, advertências e registros de qualidade disponíveis. | Qualidade e responsável técnico quando aplicável. |
| Pagamento ou cadastro | Cobranças, status no gateway e divergências documentadas do pedido. | Financeiro/operação responsável. |
| Indeterminada ou múltiplas causas | Dados ausentes, conflitantes ou insuficientes para distinguir as hipóteses. | Pessoa capaz de obter a evidência faltante. |

Registrar a conclusão como `nao_avaliada`, `em_investigacao`, `hipotese` ou `confirmada`, com fonte e data. A confirmação exige evidência diretamente vinculada ao fato, não apenas confiança declarada pelo modelo. Histórico de ocorrências ajuda a levantar hipóteses; correlação não prova responsabilidade.

Exemplos de cuidado: pedido ainda não separado não demonstra atraso da transportadora; caixa danificada não prova sozinha quem causou a avaria; sintomas relatados não confirmam causalidade de um cosmético. Ausência de evidência não autoriza culpar o cliente.

Ao falar com o cliente, descrever fatos e providências, assumindo a coordenação da solução. Não transferir responsabilidade ou afirmar culpa de uma área/terceiro sem confirmação. Novas evidências atualizam a avaliação com registro de revisão.

Relato de reação adversa deve seguir imediatamente o encaminhamento e as ações obrigatórias previstas na política, sem aguardar conclusão causal e sem diagnóstico pelo agente.

### 7.2 Regras de atraso e rastreio

- Dentro do prazo: informar situação e previsão verificadas.
- Rastreio parado por três dias úteis ou mais: avaliar abertura de chamado conforme política.
- Atraso de até sete dias úteis: abrir chamado com a transportadora.
- Acima de sete dias úteis ou extravio confirmado: oferecer reenvio ou reembolso conforme preferência do cliente e alçada.
- Usar calendário, preparo e prazo prometido definidos na base; registrar divergências, sem substituir silenciosamente a data existente.
- Evitar abrir chamado ou executar resolução duplicada para o mesmo problema.

### 7.3 Aprovação obrigatória

- Reembolso acima de R$ 100: supervisor.
- Reenvio, reimpressão ou troca acima de R$ 200: supervisor.
- Cancelamento antes da separação possui regra própria de estorno integral; não reduzir todas as ações a uma única comparação de valor.
- Suspeitas exigem decisão do supervisor e evidências verificáveis; não acusar o cliente nem negar autonomamente por suspeita.
- O aprovador não aprova a própria ação; papéis e identidade são conferidos no servidor.
- Aprovação vale para ação, pedido e valor específicos. Mudança material invalida a aprovação anterior.
- Prazo vencido gera cobrança e escalonamento, nunca aprovação automática.

### 7.4 Janela opcional de revisão — duas horas

Aplicável somente a ações que já podem ser executadas autonomamente segundo a política. Duas horas é configuração proposta do MVP, não regra original da empresa.

1. Confirmar elegibilidade e preferência do cliente.
2. Registrar proposta, evidências, versão da política e `execute_after`.
3. Exibir contagem regressiva na auditoria e disponibilizar intervenção.
4. Funcionário autorizado pode liberar antecipadamente, suspender ou rejeitar com justificativa.
5. Sem intervenção, o processador acionado pelo Supabase Cron revalida o caso na primeira rodada após o vencimento e executa apenas se continuar elegível.
6. Se surgirem dados novos relevantes, pagamento já estornado, suspeita ou alteração de preferência, interromper e reavaliar.
7. Rejeição atribui responsável pela continuidade com o cliente; o caso não desaparece da fila.
8. Registrar solicitação confirmada e comunicar prazo de crédito conforme meio de pagamento.

Mensagem proposta: “Sua solicitação de reembolso está programada para processamento após a janela de revisão de duas horas. Avisaremos quando ela for confirmada. O prazo para o valor aparecer depende da forma de pagamento.” Usar somente quando essa programação estiver efetivamente registrada e autorizada; não prometer crédito nem execução no segundo exato do vencimento.

Timer persistido no Supabase, nunca apenas no navegador. Invocações posteriores retomam tarefas vencidas após falha ou interrupção do processador. Aprovação antecipada e vencimento simultâneo precisam resultar em uma única operação por transação, reserva de execução e idempotência.

### 7.5 Falhas de execução

- Não comunicar sucesso antes da confirmação do adaptador operacional.
- Repetir somente falhas transitórias, com limite e intervalo crescente.
- Se o retorno for incerto, consultar o estado externo antes de repetir uma ação financeira.
- Após esgotar tentativas, atribuir intervenção humana com erro e contexto.
- Usar outbox para desacoplar execução e notificação sem perder mensagens.
- Na simulação, produzir registros e referências de operação persistentes; não fingir uma chamada real.

### 7.6 Pesquisa e melhoria

- Solicitar pesquisa uma vez por encerramento válido do caso, evitando duplicação por canal.
- Perguntas: nota de 1 a 5; problema resolvido (sim/parcialmente/não); comentário opcional.
- Resposta “não” ou “parcialmente” gera revisão e continuidade apropriada.
- Não presumir satisfação quando não houver resposta.
- Feedback alimenta revisão de prompts, conhecimento e roteamento em novas versões.
- Nenhuma nota muda pesos do modelo, políticas, permissões ou timers automaticamente.
- Preservar versão e avaliar mudanças em conjunto fixo de casos antes de ativar.

## 8. Uso de IA, conhecimento e economia

### Papéis separados

- Código: datas, cálculos, limites, validação, acesso, deduplicação e efeitos operacionais.
- Claude: interpretação, investigação orientada por ferramentas, síntese e comunicação.
- Recuperação de conhecimento: políticas, procedimentos e catálogo com fontes identificadas.
- Pessoas: aprovações obrigatórias, exceções e revisão de decisões.

### RAG proporcional ao tamanho da base

Começar com recuperação por categoria, SKU e busca textual. A base de políticas é pequena; banco vetorial não é pré-requisito. Dados de pedido e rastreio devem ser consultados por identificador, não recuperados por similaridade sem confirmação.

Ferramenta definida: **Full Text Search do PostgreSQL no Supabase**, consumida por TypeScript via `supabase-js` e RPC de busca. Implementar documentos com fonte e metadados, configuração de busca em português, índice GIN sobre `tsvector` e consulta textual com ranking. A RPC aplica acesso, marca/unidade e vigência antes de retornar trechos limitados ao orçamento de contexto. Regras compartilhadas do grupo permanecem recuperáveis quando aplicáveis.

Priorizar correspondência exata de categoria e SKU para regras críticas; FTS complementa a recuperação textual, sem substituir a autorização determinística. Caso não haja resultado suficiente, buscar por campos estruturados ou solicitar esclarecimento. Testar vocabulário, nomes de marcas e termos dos clientes; busca textual não equivale a compreensão semântica.

Fluxo: CSVs -> documentos de conhecimento versionados no PostgreSQL -> recuperação filtrada -> contexto com referências -> Claude. Não exige LangChain, API de embeddings, pgvector nem assinatura de RAG. Mantém consumo do Claude e recursos do banco/hospedagem dentro das cotas contratadas; avaliar busca semântica apenas se os testes demonstrarem necessidade.

Toda orientação deve indicar política/fonte usada. Falta de fonte ou conflito exige esclarecimento; não inventar procedimento.

A recuperação aplica filtros de unidade, marca, SKU e vigência no servidor. Compartilhar regras de grupo somente quando aplicáveis. Nunca usar características ou instruções de uso de um produto como se fossem de outro. A investigação pode cruzar fontes de logística/produção autorizadas, mantendo a origem de cada evidência.

### Roteamento adaptativo

- Verificar modelos, formato da API, limites e contabilização disponíveis no proxy do evento.
- Configurar aliases `economy` e `reasoning`, sem fixar nomes de modelos antes dessa verificação.
- Intenção simples, dados coerentes e redação factual: modelo econômico.
- Múltiplas solicitações, conflito de fontes e investigação mais difícil: modelo de maior capacidade.
- Reavaliar a cada etapa; permitir voltar ao modelo econômico após resolver a parte complexa.
- Compartilhar estado estruturado, evidências, ações e pendências entre modelos.
- Não usar somente confiança autodeclarada para rotear.
- Limitar número de chamadas, tokens e tentativas por caso. Orçamento esgotado gera continuidade humana, não resolução falsa.
- Se houver apenas um modelo, manter o mesmo adaptador e economizar chamadas/contexto.

### Custo e qualidade

Registrar uso reportado pelo provedor. Quando preço ou consumo não estiver disponível, mostrar “não disponível” ou estimativa identificada; nunca zero implícito.

Comparar modelo mais capaz em todas as etapas com roteamento adaptativo nos mesmos cenários, incluindo falhas e retrabalho. Só divulgar economia após medir qualidade e custo por caso resolvido.

Treinamento supervisionado fica fora do primeiro MVP. Eventual estudo exige rótulos revisados e separação de treino/teste por cliente e tempo, sem usar desfechos futuros como entrada.

## 9. Telas

### Central de atendimentos

- Fila filtrável por canal, situação, responsável, prazo e motivo do encaminhamento.
- Prioridade explicável baseada em prazo, consequência e pendências; sentimento sozinho não define prioridade.
- Detalhe: cliente, pedido, histórico multicanal, resumo, valores, evidências, ações, decisão necessária e controles.
- Perfil baseado em fatos e preferências declaradas; evitar personas psicológicas inventadas e rótulos depreciativos.
- Identificação pessoal acessível por necessidade e permissão, com mascaramento inicial.
- Atualização do estado após aprovação, sem obrigar o funcionário a refazer o trabalho da IA.
- Mostrar unidade e marca em destaque, produto e contexto específico; exibir origem investigada, grau de confirmação, evidências, lacunas e área responsável pela próxima ação.

### Estatísticas

Separar histórico importado, execução do MVP e projeções. Filtros de período, canal, cenário e modelo.

Adicionar filtros por unidade e marca. Exibir distribuição por origem investigada separando hipóteses de causas confirmadas e mantendo “indeterminada”. Não atribuir custo ou falha a uma transportadora/área com base apenas em classificação provisória; comparar unidades com seus volumes e tipos de caso explícitos.

| Métrica | Definição e cuidado |
| --- | --- |
| Resolução autônoma | Casos elegíveis de uma coorte resolvidos sem intervenção / casos elegíveis dessa coorte; mostrar também total recebido e ainda aberto. |
| Resolução assistida | Casos resolvidos com intervenção humana identificada. |
| Tempo de resolução | Abertura até resolução, com média, mediana e P90; exibir também idade dos casos abertos. |
| Primeira resposta e SLA | Primeira resposta substantiva; saudação automática não conta. Aplicar janela comercial do WhatsApp. |
| Custo por caso resolvido | Custos atribuídos aos casos resolvidos da coorte / número desses casos, incluindo tentativas; mostrar custo dos casos abertos separadamente. |
| CSAT | Notas 4 ou 5 / avaliações respondidas, acompanhado de taxa de resposta. |
| Reabertura | Casos que voltam pelo mesmo problema numa janela configurada; proposta inicial de sete dias, identificada como hipótese. |
| Intervenções | Motivos, tempo até decisão e proporção de propostas ajustadas/rejeitadas. |
| Modelos | Chamadas, tokens, latência, trocas e custo por modelo/etapa. |
| Qualidade operacional | Falhas, retentativas, execuções bloqueadas e duplicidades efetivamente evitadas. |

Tempo humano poupado e economia financeira são projeções quando derivados de premissas. Não confundir valor de reembolso com custo da IA ou valor retido para análise com economia.

### Auditoria

- Visão de ações aguardando execução: timer, valor, evidências, regra aplicada e necessidade ou não de aprovação obrigatória.
- Visão de casos executados: linha do tempo, fontes, chamadas de ferramenta, resultados, ator e revisões.
- Filtros por valor, ação, modelo, revisão, período e falha.
- Justificativas verificáveis; não armazenar nem exibir cadeia de pensamento privada do modelo.
- Eventos acrescentados com data, origem e correlação. Não alegar imutabilidade criptográfica no MVP.
- Possibilidade de selecionar casos autônomos para revisão posterior. Ausência de intervenção não conta como confirmação de acerto.

### Assistente interno

- Acessível no detalhe do caso e no dashboard.
- Responde sobre termos, políticas, dados autorizados e razões verificáveis de encaminhamento.
- Exibe fontes e sinaliza informação ausente.
- Sem ferramentas de escrita; aprovações continuam nos controles próprios.
- Aplica as mesmas permissões de acesso do funcionário.
- Herda unidade, marca e SKU do caso selecionado; quando a pergunta não tiver esse contexto e a resposta depender dele, solicita esclarecimento. Explica as hipóteses de origem com fontes, sem apresentá-las como fatos confirmados.

### Demonstração

- Simulador de entrada dos três canais, com identificação visual constante.
- Relógio acelerável apenas no modo de demonstração, mantendo registro do avanço.
- Reinicialização isolada da execução atual, preservando fontes e outros ambientes.
- Se a IA estiver indisponível, exibir falha e permitir roteiro gravado claramente identificado, sem fingir resposta ao vivo.

## 10. Segurança operacional e acesso

- Segredos em variáveis de ambiente da Vercel e armazenamento seguro do agendador; `.env`, dumps e credenciais fora do Git.
- Supabase Auth identifica o funcionário; RLS deve proteger todas as tabelas expostas pela Data API, com acesso por papel, marca e unidade. Autenticado não significa acesso irrestrito.
- Regras de autorização não usam `user_metadata` editável pelo usuário. Usar tabelas de permissões controladas e validar decisões sensíveis contra o estado atual.
- Chave publicável pode estar no cliente com RLS configurada; chave secreta/service role nunca aparece em `NEXT_PUBLIC_*`, navegador ou logs. Operações privilegiadas ficam restritas a importação e processamento interno, com validação explícita de escopo.
- RPCs e views respeitam o acesso do chamador por padrão. Restringir concessões de execução e evitar `SECURITY DEFINER` em funções expostas; endpoints internos exigem autenticação própria além de não aparecerem na interface.
- Autenticação e autorização no servidor para cada consulta ou mutação.
- Contas de demonstração com papéis definidos. Um seletor visual de papel não pode conceder privilégios em uma aplicação publicada.
- Cliente não escolhe livremente valor, papel ou referência de aprovação; validar contra dados persistidos.
- Separar conteúdo externo de instruções do sistema e limitar ferramentas por papel.
- Mascarar CPF, cartão e telefone antes do envio ao modelo, conforme a base.
- Validar webhooks e rejeitar repetição de eventos já processados.
- Impedir divulgação de dados privados em respostas públicas do Reclame Aqui.
- Aplicar acesso por unidade/marca quando o funcionário não tiver permissão de grupo. Consultas do agente e do assistente interno respeitam esse escopo; contexto de holding não concede acesso irrestrito.
- Para reação adversa, reconhecer o encaminhamento obrigatório previsto na política e acionar responsável; não tratar como troca comum.
- Qualquer regra de revisão opcional acrescentada ao protótipo deve ser configurada explicitamente e não pode relaxar a política original.

## 11. Cenários de demonstração

1. **Investigação e proposta dentro da alçada:** `AT116665`, pedido `GCH551964`, R$ 122,80. Confirmar atraso, preferência e elegibilidade; demonstrar que reenvio e reembolso têm alçadas diferentes.
2. **Aprovação humana:** `AT116703`, pedido `GCH551605`, R$ 219,90. Apresentar evidências, solicitar aprovação e retomar após decisão.
3. **Intervenção na janela de auditoria:** derivar um cenário elegível do primeiro caso ou criar fixture sintética identificada. Mostrar execução no vencimento e, numa execução separada, suspensão por funcionário.

Recurso adicional curto: `AT116589` e `AT116707` compartilham cliente e pedido `GCH558661`, em Reclame Aqui e e-mail. Demonstrar contexto unificado sem duplicar a resolução.

Os casos são pontos de partida, não autorizações pré-calculadas. Reavaliar dados, calendário e regras no momento da execução.

Acrescentar uma verificação curta de contexto GoBeauté: `AT116568`, pedido `GBH471000`, contém relato de reação adversa. Demonstrar identificação da marca/produto e encaminhamento específico previsto na política, sem diagnóstico e sem tratar o caso como troca comum. Esse exemplo não amplia o MVP para execução completa de todas as categorias. Os casos Gocase já definidos e essa verificação devem comprovar comportamentos diferentes quando o contexto exigir.

## 12. Etapas de implementação e critérios de saída

| Etapa | Entrega | Critério para avançar |
| --- | --- | --- |
| 1. Fundação | Next.js, Supabase, Auth, migrations, RLS, importação e relógio | Base importada uma vez; acesso isolado por papel/marca; relacionamentos válidos; futuros ocultos. |
| 2. Fluxo vertical | Um caso recebido, investigado e respondido com Claude | Consulta fundamentada e ação simulada persistida com resultado. |
| 3. Controle | Motor de políticas, aprovações, idempotência e auditoria | Limites e exceções respeitados; nenhuma execução indevida. |
| 4. Operação humana | Fila, detalhe, atribuição, aprovar/rejeitar e retomada | Funcionário decide com contexto; agente continua o caso. |
| 5. Agendamento | Janela de revisão, Supabase Cron e processador na Vercel | Timer sobrevive a interrupção; endpoint autenticado; sem duplicação em concorrência. |
| 6. Qualidade e eficiência | Feedback, métricas e roteamento disponível | Indicadores derivam de eventos; custos ausentes não viram zero. |
| 7. Apoio interno | Assistente contextual somente leitura | Respostas citam fontes e respeitam acesso. |
| 8. Entrega | Deploy Vercel com Supabase, três demonstrações, README, GitHub e slides PDF | Login e Cron verificados no domínio final; fluxo reproduzível e apresentação em cinco minutos. |

Se o tempo apertar, cortar integrações reais adicionais, gráficos secundários e análise de causas recorrentes. Preservar o fluxo completo, a intervenção humana e a honestidade da demonstração. Registrar qualquer funcionalidade adiada.

## 13. Verificação necessária

Concentrar testes nos riscos e fluxos relevantes:

- Limites exatamente em R$ 100 e R$ 200 e imediatamente acima; exceção de cancelamento antes da separação.
- Dias úteis, feriados e horários de atendimento.
- Ausência de aprovação obrigatória nunca libera ação pelo timer.
- Mudança de pedido ou valor invalida proposta/aprovação incompatível.
- Aprovação antecipada concorrendo com duas invocações do processador produz uma execução.
- Timeout do processador e posterior expiração de lease permitem retomada sem duplicar operações.
- Endpoint do Cron rejeita chamadas sem autenticação; cron publicado não depende do navegador aberto.
- RLS bloqueia acesso indevido pela API direta, incluindo RPCs de busca e consulta de métricas.
- Login e sessão funcionam no domínio Vercel; previews não processam tarefas da produção.
- Busca textual retorna fontes aplicáveis e não mistura marcas, vigências ou registros futuros.
- Contatos em dois canais não geram dois reenvios para o mesmo problema.
- Falha ou retorno incerto do adaptador não produz mensagem de sucesso.
- Mensagem tentando alterar instruções não modifica política ou papel.
- Assistente interno não executa mutações nem acessa casos sem permissão.
- Dados futuros não entram no contexto; informações pessoais são mascaradas.
- Pesquisa sem resposta não aumenta satisfação; casos abertos não aparecem como resolvidos.
- Cliente com compras em duas unidades recebe contexto do pedido correto; ambiguidade de marca solicita esclarecimento.
- Recuperação não mistura política específica ou características de SKUs distintos; regras compartilhadas continuam disponíveis quando aplicáveis.
- Erro de personalização não recebe procedimento de troca de fragrância; reação adversa não segue apenas fluxo comum de troca.
- Pedido não separado não é atribuído automaticamente à transportadora; origem sem evidência permanece hipótese/indeterminada.
- Correção humana da origem preserva a avaliação anterior na auditoria e atualiza o encaminhamento.
- Funcionário com acesso restrito a uma marca não consulta casos de outra pelo dashboard nem pelo assistente.

Avaliar o agente com exemplos revisados de solicitação simples, múltiplas intenções, ironia, dados faltantes, conflito, aprovação obrigatória e necessidade de encaminhamento especializado. Medir ação correta e qualidade do encaminhamento, além da fluência da resposta.

## 14. Pendências externas e decisões antes de integrar

- Confirmar endpoint, autenticação, modelos disponíveis, limites e custos do proxy de IA.
- Confirmar se o evento fornece ambiente executável para as 35 ferramentas descritas.
- Escolher canal real somente após confirmar acesso; simulação permanece suficiente para provar o fluxo.
- Definir destino de notificações externas e credenciais, se utilizadas.
- Definir nome do projeto e repositório GitHub.
- Configurar projetos Vercel e Supabase, plano adequado, Auth, RLS, variáveis e Cron; validar cotas e disponibilidade antes da demonstração.
- Decidir regras adicionais de revisão opcional e documentá-las como configuração do protótipo.
- Validar mapeamento de unidades/marcas, responsáveis por área e eventuais políticas/tons específicos; enquanto ausentes, usar apenas as regras e fatos fornecidos.

Não inserir credenciais neste documento ou em commits.

## 15. Entrega e narrativa para a banca

Obrigatórios: nome do projeto; problema; solução; uso de IA; resultado/impacto esperado; slides em PDF; link do GitHub. Aplicação publicada, vídeo e materiais adicionais são opcionais.

Pitch de cinco minutos: dor e usuário; processo atual; solução; demonstração com autonomia e intervenção; métricas medidas e projeções identificadas; primeiro passo de implantação.

Preparar captura ou vídeo como plano B. Mostrar a IA executando e acompanhando, a pessoa decidindo uma exceção e o registro verificável do resultado.

Projeção: após revisão de amostras e acompanhamento de erros, reaberturas, satisfação e custo, a empresa pode ajustar janelas de revisão por tipo de ação. A ampliação da autonomia depende de decisão explícita da empresa, nunca de autoaprovação do agente.

## 16. Definição de pronto

O MVP está pronto quando recebe um caso, investiga com os dados permitidos, escolhe uma ação fundamentada, respeita alçadas, executa ou encaminha, retoma após decisão, comunica o resultado verdadeiro e deixa uma trilha auditável; o dashboard permite operar esse fluxo e medir seus resultados sem misturar simulação, histórico e projeção.

Esse fluxo deve identificar corretamente unidade, marca e produto, aplicar o contexto correspondente e distinguir fatos de hipóteses sobre a origem do problema, mantendo a responsabilidade pelo acompanhamento do cliente.
