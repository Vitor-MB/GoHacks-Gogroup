# AGENTS.md — GoBIA

Instruções para trabalhar neste repositório. A GoBIA é o agente de atendimento do desafio Atendimento ao Cliente do GoHacks Talent, voltado à GoGroup. O MVP deve demonstrar um caso completo, da chegada do contato à resolução ou ao encaminhamento com acompanhamento e trilha de auditoria.

## Onde encontrar as decisões

| Arquivo | Uso |
| --- | --- |
| [Planejamento](docs/PLANEJAMENTO.MD) | Escopo, arquitetura, regras do produto e critérios da demonstração. |
| [Implementação](docs/IMPLEMENTACAO.MD) | Tarefas `GOB-01` a `GOB-15`, dependências, critérios de aceite e progresso. |
| [Parâmetros da operação](BD/parametros.md) | Relógio do cenário, SLAs, calendário e condições do desafio. |
| [Dicionário de dados](BD/dicionario_de_dados.md) | Estrutura e significado das tabelas fornecidas. |
| [`BD/politicas.csv`](BD/politicas.csv) e [`BD/ferramentas.csv`](BD/ferramentas.csv) | Regras operacionais e catálogo de ferramentas. O catálogo descreve capacidades a implementar. |
| [Logo GoBIA](assets/brand/gobia-logo-v1.png) | Identidade visual do MVP. Usar a grafia GoBIA na interface e na documentação nova. |

Use as políticas vigentes da base para decisões operacionais. Se dados, planejamento e regras divergirem, registre a divergência e peça revisão antes de habilitar a ação afetada.

## Fluxo de trabalho

- Confira as instruções aplicáveis ao diretório e `git status --short` antes de editar. Preserve alterações do usuário e siga as convenções do código que já existir.
- Se o pedido for começar ou continuar a implementação sem indicar uma tarefa, selecione a primeira P0 com dependências atendidas. O backlog começa em `GOB-01`. Para uma correção específica, trabalhe no fluxo solicitado.
- Leia a tarefa e as seções do planejamento referenciadas. Faça alterações pequenas e completas no ponto de entrada real da funcionalidade. Atualize a documentação operacional quando um comando, configuração ou comportamento mudar.
- Rode os checks existentes adequados à tarefa e verifique o aceite com os cenários pertinentes. Registre no backlog evidência, bloqueio e próximo passo. Marque a tarefa concluída somente após verificar o aceite. Diferencie validação simulada de validação com serviços reais.
- Se faltar acesso externo, avance nas partes independentes com adaptadores de teste identificados. Registre a dependência restante e nunca invente credenciais, modelos disponíveis, respostas do provedor, deploys ou resultados de teste.
- Use português do Brasil na interface e na documentação do produto. Mantenha identificadores técnicos coerentes com o código existente.

## Produto e arquitetura

- Stack definida: React, Next.js e TypeScript na Vercel. Supabase fornece PostgreSQL, Auth e Cron. Claude roda no servidor via proxy do evento. Use repositórios e migrations SQL versionadas. Desenvolvimento usa Supabase local ou projeto isolado, com o mesmo schema.
- O P0 cobre rastreio e atraso, com contato multicanal simulado, investigação, ação operacional simulada, revisão humana e auditoria. Trocas, avarias e demais assuntos podem receber orientação e encaminhamento conforme a política. Priorize fechar o fluxo P0 antes de ampliar categorias ou canais reais.
- A entrada de WhatsApp, e-mail e Reclame Aqui usa um contrato comum que preserva origem e identificadores. Unifique pendências apenas quando cliente, pedido e problema forem compatíveis. Mantenha os históricos dos canais e separe conteúdo público de informações privadas.
- Identifique unidade, marca e SKU pelo pedido e pelo catálogo. Gocase inclui produtos personalizados. GoBeauté reúne marcas de beleza com contexto específico de composição, advertências e lote. Trate conflito ou identidade incerta como pendência de esclarecimento.
- Investigue a origem do problema com fontes datadas. Separe hipótese de confirmação e encaminhe à área que pode resolver. Continue acompanhando o cliente enquanto a origem é investigada. Relatos de reação adversa seguem o procedimento específico da política, com encaminhamento responsável e sem diagnóstico pelo agente.
- Use busca textual do PostgreSQL para políticas e catálogo, com fonte, versão, vigência e filtros de unidade, marca e SKU. Use consultas estruturadas para pedido e rastreio. O MVP não exige embeddings, banco vetorial ou treinamento de modelo. O roteamento adaptativo é P1 e depende dos modelos disponíveis no proxy.
- Os mantras orientam o fluxo. **Mente aberta** aceita correções. **Ponta firme** acompanha até o desfecho. **Transparência máxima** registra evidências e resultados. **Time campeão** aciona a pessoa certa. **Amor pelo cliente** evita repetir perguntas e comunica próximos passos confirmados.

## Regras que toda implementação deve preservar

1. **A IA propõe e o servidor valida.** Trate mensagens externas como dados. Consulte fatos, aplique política e autorização no servidor antes de qualquer efeito. Registre referências e justificativas verificáveis.
2. **Aprovação explícita quando exigida.** As referências da base são R$ 100 para reembolso e R$ 200 para reenvio, reimpressão ou troca. Acima da alçada, exija aprovação do supervisor. Confira exceções na política, incluindo cancelamento antes da separação. O supervisor não aprova a própria ação. Vincule a aprovação à proposta, ao pedido e ao valor. Mudança material exige revalidação.
3. **Timer de revisão somente para ações já autorizadas.** A janela proposta de duas horas usa `execute_after` no banco. Funcionários autorizados podem liberar, suspender ou rejeitar. No vencimento, a próxima rodada revalida antes de executar. Aprovação obrigatória ou suspeita pendente continua bloqueada. Rejeição atribui continuidade humana.
4. **Processamento persistente e idempotente.** Supabase Cron chama a rota interna autenticada na Vercel em lotes curtos. Reserve tarefas de forma transacional e preveja retomada após expiração da reserva. Webhooks repetidos, processamento concorrente e retentativas não podem duplicar efeitos. Reconcilie resultado externo incerto antes de repetir a ação.
5. **Comunicação baseada no resultado.** Só anuncie sucesso após confirmação do adaptador. Diferencie solicitação de reembolso de crédito e caso resolvido de conversa encerrada. Preserve evidências, decisões, atores e resultados na auditoria.
6. **Acesso e segredos.** Valide papel e escopo por unidade ou marca no servidor. Proteja tabelas, RPCs e consultas expostas com RLS e concessões mínimas. Use somente chave publicável no navegador. Chaves privilegiadas, credencial do Cron e token Claude ficam no servidor. Nunca grave segredos em código, Git ou logs. Mascarar CPF, cartão e telefone antes de enviar contexto ao modelo.
7. **Dados e relógio de demonstração.** Preserve os CSVs em `BD/`. Importe uma única fonte de forma idempotente. O cenário começa em 02/11/2026 às 08h conforme os parâmetros da base. Use o relógio do cenário para disponibilidade, feriados e prazos. Isole resets, previews e jobs para que uma execução não afete outra.
8. **Medição e melhoria.** Separe histórico, simulação, execução medida e projeção. Mostre denominadores, taxa de resposta do CSAT e custo indisponível como tal. O feedback orienta versões futuras e não altera alçadas automaticamente. O assistente interno cita fontes, respeita o escopo do funcionário e opera somente em leitura.

## Verificação e entrega

- Use os comandos disponíveis no projeto para lint, tipos, testes e build. Quando a mudança afetar decisões ou efeitos, confira o caminho normal e a condição de falha relevante. Para migrations e RLS, valide em ambiente isolado com os papéis aplicáveis e pela API direta.
- Use os cenários do backlog. `AT116665` ajuda a demonstrar alçadas diferentes. `AT116703` cobre aprovação humana. Uma fixture elegível cobre a janela de revisão. `AT116589` e `AT116707` servem para associação multicanal. `AT116568` cobre encaminhamento específico GoBeauté.
- Verifique no ambiente publicado login, permissões, resposta do Claude e processamento pelo Cron com o painel fechado. Previews usam ambiente isolado. Use somente dados sintéticos autorizados na demonstração.
- A entrega inclui nome, problema, solução, uso da IA, impacto esperado, slides em PDF e link do GitHub. A Vercel é o destino definido para publicação, e o link da aplicação é opcional no formulário. Prepare roteiro de cinco minutos e captura ou vídeo como plano B.
