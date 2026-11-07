# GoBIA — tarefas de implementação

Este arquivo organiza a execução do [planejamento do MVP](PLANEJAMENTO.MD). O planejamento define o comportamento do produto. Este backlog define a ordem de implementação, as entregas e como verificar cada etapa.

## Como executar com a IA

1. Peça uma tarefa pelo ID, por exemplo `Implemente GOB-01 seguindo docs/IMPLEMENTACAO.MD`.
2. Antes de editar, leia a tarefa, as seções do planejamento que ela indica e as instruções do repositório. Confira `git status --short` e verifique o que já existe. Preserve alterações do usuário.
3. Escolha a primeira tarefa P0 cujas dependências estejam concluídas. Use o código e as convenções existentes, criando apenas os arquivos necessários para a etapa.
4. Execute os checks disponíveis e os critérios de aceite. Registre o resultado em **Progresso** com o ID, a evidência e o próximo passo. Marque `[x]` somente quando todos os critérios da tarefa tiverem sido verificados.
5. Se faltar acesso externo, registre o recurso faltante e avance nas partes independentes. Use apenas um adaptador de teste identificado quando isso permitir validar o fluxo. Uma execução simulada não satisfaz o critério que exige Claude, Supabase ou Vercel reais.

P0 forma o percurso principal do MVP. P1 acrescenta métricas, satisfação, assistente interno e roteamento econômico. A publicação pode começar assim que o fluxo P0 estiver estável e avançar junto com P1. As bases em `BD/` são fontes de importação e devem permanecer intactas. Ações em ERP, transportadora e pagamentos serão simuladas na demonstração. A integração real do MVP com Claude usa o proxy do evento.

## Fundação

### [ ] GOB-01 — Preparar o projeto Next.js · P0

**Depende de** nenhuma tarefa. **Planejamento** §§ 4–5.

- Criar a base React + Next.js + TypeScript e a página inicial GoBIA. Usar a logo existente em `assets/brand/gobia-logo-v1.png` se ela estiver disponível.
- Configurar os comandos de desenvolvimento, lint, checagem de tipos e build. Fixar dependências no lockfile. Criar `.env.example` com nomes e descrições das configurações, sem valores secretos.
- Separar configurações públicas de configurações do servidor. Preparar o README com os passos que já funcionam.

**Aceite.** Instalação pelo lockfile, lint, tipos e build passam. A página inicial abre localmente. Segredos não aparecem no código cliente nem no Git.

### [ ] GOB-02 — Criar o banco e o acesso por funcionário · P0

**Depende de** GOB-01. **Planejamento** §§ 4–6 e 10.

- Configurar Supabase local ou ambiente de desenvolvimento isolado e migrations versionadas. Criar primeiro as tabelas de catálogo, pedidos, conversas, casos, funcionários e permissões que serão usadas na importação e na fila. Evoluir o schema nas tarefas que introduzem novas entidades.
- Integrar Supabase Auth à sessão do Next.js. Vincular usuários a papéis e escopos de unidade/marca controlados pelo servidor. Aplicar RLS e concessões explícitas nas tabelas expostas. Separar o cliente com sessão do usuário do cliente administrativo de importação e processamento interno.
- Preparar contas de teste em ambiente de desenvolvimento para operador e supervisor, incluindo uma conta de escopo restrito.

**Aceite.** As migrations aplicam em uma base de desenvolvimento vazia. Uma sessão válida vê somente o escopo autorizado. Acesso sem sessão e acesso cruzado por marca falham tanto pela aplicação quanto pela API direta. A chave administrativa permanece no servidor.

### [ ] GOB-03 — Importar a base e definir o relógio do cenário · P0

**Depende de** GOB-02. **Planejamento** §§ 3, 6 e 9.

- Implementar `scripts/import-data.ts`, com leitura validada de CSV, importação em lotes, relatório de contagem e referências e reexecução sem duplicar dados. Começar por catálogo, clientes, pedidos, itens, conversas/mensagens, fila, rastreio, políticas e equipe. Importar outras tabelas quando um fluxo tiver uso definido para elas.
- Preservar identificadores como texto, valores em centavos e a identidade composta de lote e SKU. Separar dados de origem dos registros produzidos pela GoBIA.
- Isolar execuções de demonstração e iniciar o relógio em 02/11/2026 às 08h, conforme a base. Filtrar registros e eventos pela disponibilidade no cenário. Limitar o reset aos dados operacionais da execução selecionada.

**Aceite.** Importar duas vezes mantém as mesmas contagens. As referências selecionadas correspondem aos CSVs. Um evento posterior ao relógio fica invisível até a data correta. Resetar um cenário preserva a fonte e outros cenários.

## Atendimento e execução

### [ ] GOB-04 — Receber contatos e identificar o contexto · P0

**Depende de** GOB-03. **Planejamento** §§ 6, 7.1 e 7.1.1.

- Criar uma entrada comum para WhatsApp, e-mail e Reclame Aqui simulados, preservando canal, conversa e identificador de origem. Deduplicar a entrega do mesmo evento.
- Resolver cliente, pedido, unidade, marca e SKU a partir do pedido e do catálogo. Em caso ambíguo, deixar o caso pendente de esclarecimento. Associar conversas a uma pendência comum apenas quando cliente, pedido e assunto forem compatíveis.
- Disponibilizar a fila inicial e o detalhe mínimo do caso, com histórico e fontes. Não expor dados privados em saídas públicas do Reclame Aqui.

**Aceite.** Reenviar um evento não duplica a mensagem. `AT116589` e `AT116707` podem compartilhar a pendência do pedido `GCH558661` sem perder os canais de origem. Pedidos de outra marca ou assuntos diferentes mantêm o contexto separado.

### [ ] GOB-05 — Implementar consultas e RAG no PostgreSQL · P0

**Depende de** GOB-03. **Planejamento** §§ 7.1.2 e 8.

- Criar consultas autorizadas por identificador para pedido, itens, catálogo, rastreio e evidências. Usar o relógio do caso.
- Indexar políticas e fichas de produto com Full Text Search do PostgreSQL em português, incluindo fonte, versão, vigência e escopo. Expor busca por RPC ou serviço autorizado, com filtros de marca, unidade e SKU. Priorizar correspondência exata em regras críticas e limitar os trechos enviados ao Claude.
- Padronizar a saída das consultas com referência da fonte, horário e indicação de dado ausente ou conflitante.

**Aceite.** Consultas do cenário retornam dados disponíveis na data e trechos citáveis. Termos em português recuperam a política esperada. Uma consulta de marca restrita não retorna conteúdo indevido. A busca funciona sem embeddings nem chamadas de IA.

### [ ] GOB-06 — Implementar a decisão operacional · P0

**Depende de** GOB-03. **Planejamento** §§ 7.2–7.4 e 13.

- Criar regras puras de calendário e política. A decisão deve receber fatos verificados, ação e valor, e devolver elegibilidade, justificativa, requisito de aprovação e possibilidade de revisão opcional.
- Implementar rastreio parado, atraso e extravio, preferência do cliente e limites de reembolso, reenvio, troca e reimpressão conforme a fonte. Para categorias fora da execução P0, devolver orientação e encaminhamento permitido. Preservar a exceção de cancelamento antes da separação na avaliação de política.
- Bloquear a execução quando faltarem dados obrigatórios, houver suspeita pendente ou a ação ultrapassar a alçada sem aprovação válida.

**Aceite.** Verificar feriado, contagem em dias úteis, limiares exatos de R$ 100 e R$ 200 e um centavo acima de cada um. Um valor ou uma permissão sugeridos pelo Claude não substituem os dados verificados.

### [ ] GOB-07 — Ligar Claude à investigação · P0

**Depende de** GOB-04, GOB-05 e GOB-06. **Planejamento** §§ 7.1 e 8.

- Implementar o adaptador server-side do proxy, com configuração de endpoint, modelo, timeout e orçamento. Validar saídas estruturadas e ferramentas. Manter um adaptador simulado identificado para testes locais.
- Montar contexto mínimo com dados pessoais mascarados. Usar Claude para entender a intenção, consultar evidências, indicar origem como hipótese ou fato sustentado e propor o próximo passo. Validar a proposta com GOB-06 antes de executar.
- Tratar mensagem do cliente como dado. Diante de fontes conflitantes, acionar a pessoa capaz de obter a evidência que falta. Em relato de reação adversa, acionar o fluxo de orientação e encaminhamento previsto na política.

**Aceite.** Um caso Gocase passa pelo Claude do evento, recebe proposta verificável e gera resposta coerente com os dados. O caso GoBeauté `AT116568` recebe encaminhamento específico. Mensagens tentando mudar alçadas, saída inválida e timeout não geram ações indevidas.

### [ ] GOB-08 — Persistir execução, notificações e auditoria · P0

**Depende de** GOB-06 e GOB-07. **Planejamento** §§ 6, 7.4–7.5 e 9.

- Implementar adaptadores simulados para abertura de chamado, reenvio e solicitação de reembolso. Persistir propostas, referência de execução, resultado e eventos de auditoria. Registrar justificativa verificável, política, evidência, ator e timestamps.
- Usar chave de idempotência por operação e gravação consistente dos eventos de saída. Uma repetição do processamento deve reutilizar o resultado conhecido ou reconciliar resultado incerto antes de tentar de novo.
- Emitir atualizações somente após persistir o resultado. Manter as pendências abertas quando ainda houver ação externa ou humana necessária.

**Aceite.** Um chamado simulado surge no caso e na trilha. Reprocessar a mesma proposta não duplica o efeito. Falha simulada não produz mensagem de sucesso. Uma solicitação de reembolso não aparece como crédito confirmado.

### [ ] GOB-09 — Operar a fila humana e retomar o atendimento · P0

**Depende de** GOB-08. **Planejamento** §§ 7.3 e 9.

- Completar fila e detalhe com prioridade explicável, resumo, produto, valores, histórico, evidências, responsável, motivo e decisão solicitada. Gerar notificação interna persistida quando houver encaminhamento.
- Implementar atribuição, aprovação, rejeição e suspensão conforme papel e escopo. Validar no servidor a separação entre solicitante e aprovador. Vincular a decisão à ação, ao pedido, ao valor e à versão da proposta.
- Retomar o caso após aprovação válida. Atribuir continuidade humana após rejeição. Se a aprovação vencer, notificar ou escalar conforme a regra.

**Aceite.** Em `AT116703`, uma proposta elegível acima da alçada aguarda supervisor. Operador, usuário fora do escopo e autor da própria proposta não podem aprovar. Mudança de valor invalida aprovação anterior. Uma decisão válida retoma o caso e aparece na auditoria.

### [ ] GOB-10 — Agendar a revisão de duas horas · P0

**Depende de** GOB-08 e GOB-09. **Planejamento** §§ 4 e 7.4.

- Persistir `execute_after` para ações elegíveis. Criar a visão de auditoria de pendências com contagem regressiva e controles autorizados de liberação, suspensão e rejeição.
- Implementar `POST /api/internal/jobs/process` com segredo dedicado, reserva transacional de tarefas, lote limitado, expiração da reserva e revalidação antes da execução. Preparar configuração do Supabase Cron para a URL estável, a ser ativada e verificada na GOB-14.
- Permitir avançar o relógio de uma execução de demonstração de forma isolada. Mostrar separadamente revisão opcional e aprovação obrigatória.

**Aceite.** Ação elegível executa na rodada após vencer, mesmo com o painel fechado. Suspensão anterior bloqueia a execução. Aprovação obrigatória vencida continua bloqueada. Invocações concorrentes, liberação antecipada e retomada após timeout não duplicam o efeito. A rota recusa chamada sem credencial.

## Qualidade e eficiência

### [ ] GOB-11 — Medir desempenho e coletar satisfação · P1

**Depende de** GOB-08 e GOB-09. **Planejamento** §§ 7.6 e 9.

- Registrar eventos e timestamps para resolução autônoma/assistida, espera, primeira resposta, SLA, reabertura e consumo de IA. Separar histórico importado, simulação e projeções nos filtros e agregados.
- Criar página de estatísticas com denominadores visíveis, média/mediana/P90 de tempo quando houver amostra e custos desconhecidos sinalizados. Mostrar CSAT e taxa de resposta em conjunto.
- Solicitar uma pesquisa por encerramento válido de caso, com nota e indicação de resolução. Respostas negativas geram revisão. Usar feedback em avaliação de versões posteriores.

**Aceite.** Com uma amostra de resultados conhecida, os números batem com os eventos. Caso aberto não conta como resolvido, pesquisa ausente não conta como satisfação e custo indisponível não vira zero. Um caso multicanal não dispara duas pesquisas no mesmo encerramento.

### [ ] GOB-12 — Criar o assistente interno de consulta · P1

**Depende de** GOB-05, GOB-07 e GOB-09. **Planejamento** § 9.

- Criar assistente no dashboard que explica termos, políticas e motivos de encaminhamento, usando o escopo do funcionário e o caso selecionado. Reutilizar recuperação e adaptador de IA.
- Retornar referências consultáveis e pedir contexto quando uma resposta depender de marca ou produto. Expor apenas ferramentas de leitura.

**Aceite.** O assistente explica com fonte por que um reembolso exige supervisor. Um funcionário não lê caso fora do seu escopo e uma mensagem pedindo aprovação não altera o estado do caso.

### [ ] GOB-13 — Roteamento adaptativo e comparação de custo · P1

**Depende de** GOB-07 e GOB-11. **Planejamento** § 8.

- Confirmar os modelos autorizados no proxy. Se houver dois modelos compatíveis, configurar `economy` e `reasoning` e rotear por etapa. Usar estado compartilhado para investigar conflito com o modelo mais capaz e voltar ao econômico quando apropriado.
- Registrar modelo, motivo da troca, latência, tokens e custo quando disponível. Comparar as duas estratégias nos mesmos casos revisados, incluindo retrabalho e erros. Manter o modo de modelo único quando o proxy só oferecer um.

**Aceite.** Com dois modelos, uma mesma conversa pode alternar modelos sem perder contexto ou permissões, e o comparativo mostra qualidade e custo observados. Com um modelo, verificar o caminho de contingência e registrar a limitação da avaliação de economia.

## Publicação e entrega

### [ ] GOB-14 — Publicar na Vercel com Supabase · P0

**Depende de** GOB-10 e acesso a Vercel, Supabase e proxy. **Planejamento** §§ 4, 10, 12 e 14.

- Configurar o ambiente publicado, aplicar migrations e importar o recorte sintético autorizado. Separar banco, variáveis e tarefas dos ambientes de desenvolvimento e preview. Configurar callbacks de Auth e segredos de servidor.
- Conectar o deploy ao repositório escolhido e ativar o Supabase Cron para a URL estável. Verificar logs de execução, cotas e disponibilidade antes da apresentação.
- Testar em janela anônima o acesso pelo link e o login de demonstração. Verificar acesso restrito, resposta do Claude e processamento de uma ação elegível com o dashboard fechado. Registrar no README como repetir o deploy e o teste.

**Aceite.** A URL final abre em uma sessão nova. Login e isolamento por papel/marca funcionam. Um job vence e é processado pelo agendador no ambiente publicado, sem duplicação nem processamento cruzado por preview.

### [ ] GOB-15 — Ensaiar a demo e preparar a submissão · P0

**Depende de** GOB-10 para o ensaio local e GOB-14 para verificar o link publicado. **Planejamento** §§ 11, 13 e 15.

- Preparar três cenários reproduzíveis. Usar `AT116665` para distinguir alçada de reenvio e reembolso, `AT116703` para aprovação humana e uma fixture elegível identificada para mostrar vencimento ou intervenção no timer. Confirmar a elegibilidade no relógio do cenário e identificar todo dado adicionado.
- Ensaiar o encadeamento contato, investigação, decisão, execução e comunicação. Mostrar trilha e valores observados. Manter à mão a demonstração curta de GoBeauté e de associação multicanal. Preparar captura ou vídeo como plano B identificado.
- Preparar README, link do GitHub, campos da inscrição e slides em PDF. Reservar espaço para problema, solução, papel da IA, impacto medido e projeções identificadas.

**Aceite.** O roteiro cabe em cinco minutos, a banca consegue ver uma ação autônoma e uma intervenção humana, o PDF abre e o repositório e o link publicado foram conferidos. Funcionalidades P1 ausentes ficam registradas no status da entrega.

## Progresso

| Task | Estado | Evidência ou bloqueio | Próximo passo |
| --- | --- | --- | --- |
| GOB-01 | Bloqueada | Base Next.js, página inicial com a logo e configuração de ambiente implementadas. A proteção de `.env.local` foi conferida com `git check-ignore`. O registro npm não respondeu por DNS (`ENOTFOUND`) e o cache local não tem os pacotes (`ENOTCACHED`). A geração do lockfile, `npm ci`, lint, tipos, build e abertura da página aguardam as dependências. | Em um terminal com acesso ao npm, rodar `npm install` para gerar `package-lock.json`, verificar `npm ci`, `npm run lint`, `npm run typecheck`, `npm run build` e abrir a página com `npm run dev`. Versionar o lockfile e concluir o aceite antes de avançar para GOB-02. |

Adicione uma linha ao avançar em cada tarefa. Use `A fazer`, `Em andamento`, `Bloqueada` ou `Concluída` e aponte o comando, resultado ou cenário usado para verificar o aceite. Use números de teste e IDs sintéticos ao registrar evidências.
