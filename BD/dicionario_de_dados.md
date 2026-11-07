# Dicionário de dados: Atendimento

Todos os dados são sintéticos. Nomes, documentos, cartões e telefones que aparecem nas mensagens são fictícios. Datas em ISO (`AAAA-MM-DD` e `AAAA-MM-DD HH:MM:SS`), valores com ponto decimal.

## historico_conversas.csv (uma linha por conversa encerrada até 02/11 08:00; amostra de 1 em cada 4 clientes)

| Campo | Descrição |
| --- | --- |
| conversation_id | Identificador da conversa (`AT` + 6 dígitos, crescente com a abertura) |
| customer_id | Identificador do cliente (`CH` + 6 dígitos) |
| order_id | Pedido associado, quando houver (`GCH` = Gocase, `GBH` = GoBeauté) |
| marca | Marca do contato |
| canal | whatsapp, email ou reclame_aqui |
| data_abertura | Data e hora da primeira mensagem |
| tag_agente | Categoria atribuída pelo agente ao encerrar (vazia quando só o bot falou) |
| status | resolvido, pendente, reaberto (o cliente voltou depois) ou sem_resposta_cliente |
| n_interacoes | Número de mensagens na conversa, incluindo as do bot |

## historico_mensagens.csv (uma linha por mensagem; inclui as mensagens já recebidas das conversas da fila)

| Campo | Descrição |
| --- | --- |
| conversation_id | Conversa a que a mensagem pertence |
| message_id | Identificador da mensagem |
| autor | cliente, agente ou bot (saudação no WhatsApp e resposta automática no e-mail; o Reclame Aqui não tem bot) |
| timestamp | Data e hora da mensagem |
| texto | Conteúdo da mensagem. Fotos aparecem como `[foto anexada]` ou `[imagem]`. |

## fila_aberta.csv (conversas abertas às 08:00 de 02/11; volume cheio)

Mesmo formato do histórico, sem `tag_agente`. `status`: aberto (ninguém respondeu ainda) ou pendente (o agente respondeu e o cliente voltou a escrever).

## pedidos.csv (pedidos dos clientes acima, posição em 02/11 08:00)

| Campo | Descrição |
| --- | --- |
| order_id | Identificador do pedido |
| customer_id | Cliente |
| marca | Marca |
| data_pedido | Data do pedido |
| valor | Valor pago (R$) |
| sku, descricao_produto | Produto principal. Pedidos da campanha com brinde trazem "+ Brinde ..." na descrição |
| personalizacao | nome, foto, iniciais ou vazio (só Gocase) |
| transportadora | Transportadora responsável |
| uf | Estado de entrega |
| status_entrega | aguardando_separacao, em_transito, entregue, extraviado, devolvido ou cancelado, na posição de 02/11 08:00 |
| data_separacao | Data **e hora** em que o pedido foi separado no CD (vazia se ainda não foi) |
| cd_separacao | CD que separou o pedido (CD1 ou CD2; vazio se ainda não foi separado) |
| maquina_personalizacao | Impressora que personalizou o produto (PRN-01 a PRN-03 no CD1, PRN-04 a PRN-06 no CD2). Vazia sem personalização ou antes da separação |
| data_entrega | Data da entrega (vazia se ainda não foi entregue) |
| lote_produto | Lote do produto GoBeauté (`LT` + AAMM + `-` + letra). Vazio na Gocase (produção sob demanda) |

O arquivo também traz os pedidos que serão criados durante a semana do evento (data_pedido depois de 02/11), com a situação no momento da criação. O ambiente atualiza status, separação e entrega a cada tique pela ferramenta `consultar_pedido`.

## clientes.csv (posição em 02/11 08:00)

| Campo | Descrição |
| --- | --- |
| customer_id | Cliente |
| n_pedidos | Pedidos na vida do cliente (inclui pedidos antigos que não estão em pedidos.csv) |
| receita_acumulada | Receita na vida do cliente (R$) |
| n_trocas_12m | Trocas, reenvios e reimpressões em 12 meses |
| n_contatos_12m | Conversas com o atendimento em 12 meses |

## politicas.json, ferramentas.json

Regras como dados (prazos, limites, ações permitidas por categoria, exigências) e o catálogo de ferramentas com os papéis que podem usá-las (`atendente`, `analista`, `supervisor`).

## anexos_conversas.csv (uma linha por imagem enviada pelo cliente no histórico e na fila)

| Campo | Descrição |
| --- | --- |
| anexo_id | Identificador do anexo |
| conversation_id, message_id | Conversa e mensagem em que a imagem chegou (a mensagem mostra `[imagem]`) |
| order_id, customer_id, canal | Pedido, cliente e canal da conversa |
| enviado_em | Data e hora do envio |
| tipo | foto_produto, foto_embalagem ou print_tela, conforme a plataforma classificou |
| hash_perceptual | Hash da imagem: imagens visualmente iguais têm o mesmo hash, mesmo com outro nome de arquivo |
| exif_data_captura, exif_modelo_camera, exif_software | Metadados do arquivo. Vazios quando o aplicativo removeu (o WhatsApp quase sempre remove) |
| descricao_visual | Descrição da imagem gerada pelo módulo de visão da plataforma. As imagens originais não são distribuídas |

Nas conversas que chegam durante o evento, as imagens vêm pela ferramenta `ver_anexos` (quando o cliente manda a foto ou depois de `solicitar_foto`).

## Bases complementares (exportações dos sistemas)

Geradas por `completar_bases_atendimento.py`. Mesmo corte: 02/11/2026 08:00. Datas futuras só aparecem em campos de previsão,
prazo ou vigência (`data_prometida`, `previsao_entrega`, `nova_previsao_entrega`, `prazo_resposta`, `fim_vigencia`,
`data_validade`, `data_vencimento`) e nos pedidos que serão criados durante o evento (já presentes em `pedidos.csv`).

| Arquivo | Sistema | O que é |
| --- | --- | --- |
| `clientes.csv` (colunas novas) | CRM | nome, e-mail, telefone, CPF, nascimento, cadastro, cidade, UF, CEP, segmento (novo, recorrente, fiel, vip), canal preferido, consentimentos e data do último pedido |
| `pedidos.csv` (colunas novas) | ERP | hora do pedido, canal de venda, unidades (com brinde), valor dos produtos, desconto, cupom, frete, forma de pagamento, parcelas, status do pagamento, data prometida, código de rastreio, NF e endereço de entrega. `valor = valor_produtos - desconto + frete_cobrado` |
| `historico_conversas.csv` / `fila_aberta.csv` (colunas novas) | Central de atendimento | atendente, primeira resposta humana, encerramento, assunto (e-mail e título do Reclame Aqui) e nota CSAT |
| `rastreio_portais_transportadoras.csv` (coluna nova) | Portais | `codigo_rastreio` do pedido |
| `acoes_executadas_sistemas.csv` (coluna nova) | Vários | `referencia_sistema`: id do registro criado (OMS, estorno, chamado, transação ou tentativa de cupom). `executado_por` é o atendente que conduziu a conversa |
| `produtos.csv` | Catálogo (PIM) | ficha de cada SKU: preço, custo, peso, medidas, personalização, composição, modo de uso, validade, advertências, EAN |
| `itens_pedido.csv` | ERP | linhas de cada pedido, inclusive o brinde da campanha (preço zero) e o texto da personalização |
| `pagamentos_gateway.csv` | Gateway de pagamentos | cada tentativa de cobrança: método, bandeira, final do cartão, parcelas, status (capturada, paga, recusada, pendente, cancelada, estornada), NSU, autorização, valor estornado |
| `estornos.csv` | Gateway de pagamentos | estornos pedidos pelo atendimento ou por cancelamento automático; `negado` quando a transação já estava estornada |
| `cupons.csv` / `uso_cupons.csv` | Plataforma de cupons | regras dos cupons e cada aplicação ou recusa (com o motivo calculado pela plataforma) |
| `trocas_reenvios.csv` | OMS de trocas e reenvios | reenvio, troca ou nova produção: pedido de reposição, SKU, custos, aprovação, expedição e entrega |
| `chamados_transportadora.csv` | Portais das transportadoras | chamados abertos pelo atendimento, prazo e resposta da transportadora |
| `equipe_atendimento.csv` | RH / Central de atendimento | atendentes, supervisores e analistas: cargo, nível, turno, canais, supervisor, admissão |
| `avaliacoes_csat.csv` | Central de atendimento (pesquisa) | pesquisa enviada ao encerrar conversas resolvidas de WhatsApp e e-mail; nota de 1 a 5 quando respondida |
| `reclame_aqui.csv` | Portal Reclame Aqui | status público, resposta da empresa, réplicas, nota do consumidor (0 a 10) e "voltaria a fazer negócio" |
| `lotes_producao.csv` | Qualidade (fábricas) | lotes GoBeauté: fabricante, fabricação, validade, quantidade, laudo e liberação |
| `maquinas_personalizacao.csv` | Produção Gocase | impressoras PRN-01 a PRN-06: CD, modelo, tipos de produto, última troca de cartucho e preventiva |
