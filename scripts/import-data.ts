// GOB-03 · Importa os CSVs de BD/ para o PostgreSQL (Supabase) de forma idempotente.
//
// Uso (ambiente de DESENVOLVIMENTO ou projeto isolado):
//   node --env-file=.env.local scripts/import-data.ts             # importa e confere contagens
//   node scripts/import-data.ts --dry-run                         # só lê, valida e mostra o relatório (sem banco)
//   node --env-file=.env.local scripts/import-data.ts --scenario demo   # nome do cenário (padrão: "demo")
//
// - Upsert por chave primária/natural em lotes: reexecutar não duplica linhas.
// - Só escreve tabelas de origem (scenario_run_id nulo) e cria/reutiliza o cenário informado.
// - Identificadores ficam como texto; valores em centavos; horários em America/Sao_Paulo (-03:00).
// - Referências quebradas interrompem a importação antes de qualquer escrita.
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "node:url";
import { cents, date, int, readCsv, slug, text, timestamp, yesNo, type Row } from "./lib/csv.ts";

const BD = fileURLToPath(new URL("../BD/", import.meta.url));
const BATCH = 500;
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const scenarioName = args.includes("--scenario") ? args[args.indexOf("--scenario") + 1] : "demo";

const csv = (name: string) => readCsv(`${BD}${name}.csv`);
const must = <T>(v: T | null, what: string): T => {
  if (v === null || v === undefined) throw new Error(`Campo obrigatório vazio: ${what}`);
  return v;
};

type Rec = Record<string, unknown>;
type Dataset = { table: string; onConflict: string; rows: Rec[]; source: number };

// ---------- Catálogo: unidades, marcas, produtos ----------
const produtos = csv("produtos");
const unitName = new Map<string, string>(); // id → nome
const brandName = new Map<string, string>();
const brandUnit = new Map<string, string>(); // brand_id → unit_id
for (const p of produtos) {
  const unit = slug(p.unidade_negocio);
  const brand = slug(p.marca);
  unitName.set(unit, p.unidade_negocio);
  brandName.set(brand, p.marca);
  brandUnit.set(brand, unit);
}
const brandId = (name: string) => {
  const id = slug(name);
  if (!brandUnit.has(id)) throw new Error(`Marca fora do catálogo: "${name}"`);
  return id;
};

const businessUnits: Dataset = {
  table: "business_units",
  onConflict: "id",
  source: unitName.size,
  rows: [...unitName].map(([id, name]) => ({ id, name })),
};
const brands: Dataset = {
  table: "brands",
  onConflict: "id",
  source: brandName.size,
  rows: [...brandName].map(([id, name]) => ({ id, name, business_unit_id: brandUnit.get(id) })),
};

const products: Dataset = {
  table: "products",
  onConflict: "sku",
  source: produtos.length,
  rows: produtos.map((p) => ({
    sku: must(text(p.sku), "sku"),
    name: p.nome,
    brand_id: brandId(p.marca),
    business_unit_id: slug(p.unidade_negocio),
    category: text(p.categoria),
    kind: text(p.tipo),
    price_cents: cents(p.preco_venda),
    cost_cents: cents(p.custo_unitario),
    personalizable: yesNo(p.personalizavel) ?? false,
    personalization_type: text(p.tipo_personalizacao),
    production_days: int(p.prazo_producao_dias_uteis),
    composition: text(p.composicao),
    usage_instructions: text(p.modo_de_uso),
    warnings: text(p.advertencias),
    shelf_life_months: int(p.validade_meses_fechado),
    anvisa_registry: text(p.registro_anvisa),
    ean: text(p.ean),
    status: text(p.status),
    // Campos sem coluna própria ficam preservados, sem perda.
    attributes: Object.fromEntries(
      (
        [
          ["presentation", p.apresentacao],
          ["content", p.conteudo],
          ["weight_g", p.peso_g],
          ["dimensions_cm", p.dimensoes_cm],
          ["compatible_model", p.modelo_compativel],
          ["magsafe", p.compativel_magsafe],
          ["olfactory_notes", p.notas_olfativas],
          ["fixation", p.fixacao],
          ["shelf_life_after_opening", p.validade_apos_aberto],
          ["vegan", p.vegano],
          ["cruelty_free", p.cruelty_free],
          ["gluten_lactose_free", p.sem_gluten_sem_lactose],
          ["low_poo", p.liberado_low_poo],
          ["launched_on", p.data_lancamento],
        ] as [string, string][]
      )
        .map(([k, v]): [string, string | null] => [k, text(v)])
        .filter(([, v]) => v !== null),
    ),
  })),
};

const lotesCsv = csv("lotes_producao");
const productLots: Dataset = {
  table: "product_lots",
  onConflict: "lot,sku",
  source: lotesCsv.length,
  rows: lotesCsv.map((l) => ({
    lot: must(text(l.lote), "lote"),
    sku: must(text(l.sku), "sku do lote"),
    brand_id: brandId(l.marca),
    manufacturer: text(l.fabricante),
    manufactured_on: date(l.data_fabricacao),
    expires_on: date(l.data_validade),
    quantity: int(l.quantidade_produzida),
    quality_released_on: date(l.data_liberacao_qualidade),
    quality_report: text(l.laudo_qualidade),
    quality_status: text(l.status_qualidade),
  })),
};

// ---------- Clientes ----------
const clientesCsv = csv("clientes");
const customers: Dataset = {
  table: "customers",
  onConflict: "customer_id",
  source: clientesCsv.length,
  rows: clientesCsv.map((c) => ({
    customer_id: must(text(c.customer_id), "customer_id"),
    full_name: text(c.nome),
    email: text(c.email),
    phone: text(c.telefone),
    cpf: text(c.cpf),
    birth_date: date(c.data_nascimento),
    registered_at: timestamp(c.data_cadastro),
    city: text(c.cidade),
    uf: text(c.uf),
    zip: text(c.cep),
    segment: text(c.segmento),
    preferred_channel: text(c.canal_preferido),
    accepts_whatsapp: yesNo(c.aceita_comunicacao_whatsapp),
    accepts_email: yesNo(c.aceita_comunicacao_email),
    orders_count: int(c.n_pedidos),
    lifetime_revenue_cents: cents(c.receita_acumulada),
    exchanges_12m: int(c.n_trocas_12m),
    contacts_12m: int(c.n_contatos_12m),
    last_order_on: date(c.ultimo_pedido_em),
  })),
};

// ---------- Pedidos e itens ----------
const pedidosCsv = csv("pedidos");
const orders: Dataset = {
  table: "orders",
  onConflict: "order_id",
  source: pedidosCsv.length,
  rows: pedidosCsv.map((o) => {
    const brand = brandId(o.marca);
    return {
      order_id: must(text(o.order_id), "order_id"),
      customer_id: must(text(o.customer_id), "customer_id do pedido"),
      brand_id: brand,
      business_unit_id: brandUnit.get(brand),
      // Pedidos de data futura só ficam visíveis quando o relógio do cenário os alcança (orders_as_of).
      ordered_at: must(timestamp(o.data_hora_pedido) ?? timestamp(`${o.data_pedido} 00:00`), "data do pedido"),
      total_cents: must(cents(o.valor), "valor"),
      sku: text(o.sku),
      product_description: text(o.descricao_produto),
      personalization: text(o.personalizacao),
      carrier: text(o.transportadora),
      uf: text(o.uf),
      delivery_status: text(o.status_entrega),
      separated_at: timestamp(o.data_separacao),
      fulfillment_center: text(o.cd_separacao),
      print_machine: text(o.maquina_personalizacao),
      delivered_on: date(o.data_entrega),
      product_lot: text(o.lote_produto),
      sales_channel: text(o.canal_venda),
      items_count: int(o.quantidade_itens),
      products_total_cents: cents(o.valor_produtos),
      discount_cents: cents(o.desconto),
      coupon: text(o.cupom),
      shipping_cents: cents(o.frete_cobrado),
      payment_method: text(o.forma_pagamento),
      installments: int(o.parcelas),
      payment_status: text(o.status_pagamento),
      promised_on: date(o.data_prometida),
      tracking_code: text(o.codigo_rastreio),
      invoice_number: text(o.numero_nota_fiscal),
      delivery_zip: text(o.cep_entrega),
      delivery_city: text(o.cidade_entrega),
    };
  }),
};

const itensCsv = csv("itens_pedido");
const orderItems: Dataset = {
  table: "order_items",
  onConflict: "item_id",
  source: itensCsv.length,
  rows: itensCsv.map((i) => ({
    item_id: must(text(i.item_id), "item_id"),
    order_id: must(text(i.order_id), "order_id do item"),
    line: must(int(i.linha), "linha"),
    sku: text(i.sku),
    description: text(i.descricao),
    item_type: text(i.tipo_item),
    quantity: must(int(i.quantidade), "quantidade"),
    unit_price_cents: cents(i.preco_unitario),
    discount_cents: cents(i.desconto_rateado),
    total_cents: cents(i.valor_total),
    personalization: text(i.personalizacao),
    personalization_text: text(i.texto_personalizacao),
    lot: text(i.lote),
  })),
};

// ---------- Conversas e mensagens ----------
function conversation(r: Row, origin: "historico" | "fila"): Rec {
  const orderId = text(r.order_id);
  const brand = brandId(r.marca);
  return {
    conversation_id: must(text(r.conversation_id), "conversation_id"),
    customer_id: must(text(r.customer_id), "customer_id da conversa"),
    order_id: orderId,
    brand_id: brand,
    business_unit_id: brandUnit.get(brand),
    channel: r.canal,
    origin,
    opened_at: must(timestamp(r.data_abertura), "data_abertura"),
    status: text(r.status),
    // Conversas sem tag permanecem sem tag: nenhum rótulo é inventado na importação.
    agent_tag: text(r.tag_agente),
    subject: text(r.assunto),
    agent_code: text(r.atendente_id),
    first_response_at: timestamp(r.data_primeira_resposta),
    closed_at: timestamp(r.data_encerramento),
    csat: int(r.csat),
    interactions: int(r.n_interacoes),
  };
}
const histCsv = csv("historico_conversas");
const filaCsv = csv("fila_aberta");
const conversations: Dataset = {
  table: "conversations",
  onConflict: "conversation_id",
  source: histCsv.length + filaCsv.length,
  rows: [...histCsv.map((r) => conversation(r, "historico")), ...filaCsv.map((r) => conversation(r, "fila"))],
};

const msgCsv = csv("historico_mensagens");
const messages: Dataset = {
  table: "messages",
  onConflict: "message_id",
  source: msgCsv.length,
  rows: msgCsv.map((m) => ({
    message_id: must(text(m.message_id), "message_id"),
    conversation_id: must(text(m.conversation_id), "conversation_id da mensagem"),
    author: m.autor,
    sent_at: must(timestamp(m.timestamp), "timestamp"),
    body: text(m.texto),
  })),
};

// ---------- Rastreio ----------
const rastreioCsv = csv("rastreio_portais_transportadoras");
const trackingRows = new Map<string, Rec>();
for (const t of rastreioCsv) {
  const row = {
    order_id: must(text(t.pedido_ref), "pedido_ref"),
    portal: must(text(t.portal), "portal"),
    event_at: must(timestamp(t.data_hora_evento), "data_hora_evento"),
    status: must(text(t.status), "status do evento"),
    location: text(t.local),
    expected_on: date(t.previsao_entrega),
    tracking_code: text(t.codigo_rastreio),
  };
  trackingRows.set(`${row.order_id}|${row.portal}|${row.event_at}|${row.status}`, row);
}
const trackingEvents: Dataset = {
  table: "tracking_events",
  onConflict: "order_id,portal,event_at,status",
  source: rastreioCsv.length,
  rows: [...trackingRows.values()],
};

// ---------- Evidências: chamados à transportadora, anexos e máquinas de personalização ----------
const chamadosCsv = csv("chamados_transportadora");
const carrierTickets: Dataset = {
  table: "carrier_tickets",
  onConflict: "ticket_id",
  source: chamadosCsv.length,
  rows: chamadosCsv.map((c) => ({
    ticket_id: must(text(c.chamado_id), "chamado_id"),
    carrier: must(text(c.transportadora), "transportadora do chamado"),
    order_id: must(text(c.order_id), "order_id do chamado"),
    tracking_code: text(c.codigo_rastreio),
    conversation_id: text(c.conversation_id),
    action_id: text(c.acao_id),
    opened_by: text(c.aberto_por),
    opened_at: must(timestamp(c.data_abertura), "data_abertura"),
    reason: text(c.motivo),
    response_due_at: timestamp(c.prazo_resposta),
    status: text(c.status),
    responded_at: timestamp(c.data_resposta),
    carrier_response: text(c.resposta_transportadora),
    new_expected_on: date(c.nova_previsao_entrega),
    closed_at: timestamp(c.data_encerramento),
  })),
};

const anexosCsv = csv("anexos_conversas");
const attachments: Dataset = {
  table: "attachments",
  onConflict: "attachment_id",
  source: anexosCsv.length,
  rows: anexosCsv.map((a) => ({
    attachment_id: must(text(a.anexo_id), "anexo_id"),
    conversation_id: text(a.conversation_id),
    message_id: text(a.message_id),
    order_id: text(a.order_id),
    customer_id: text(a.customer_id),
    channel: text(a.canal),
    sent_at: must(timestamp(a.enviado_em), "enviado_em"),
    kind: text(a.tipo),
    perceptual_hash: text(a.hash_perceptual),
    exif_captured_at: timestamp(a.exif_data_captura),
    exif_camera: text(a.exif_modelo_camera),
    exif_software: text(a.exif_software),
    visual_description: text(a.descricao_visual),
  })),
};

const maquinasCsv = csv("maquinas_personalizacao");
const printMachines: Dataset = {
  table: "print_machines",
  onConflict: "machine_id",
  source: maquinasCsv.length,
  rows: maquinasCsv.map((m) => ({
    machine_id: must(text(m.maquina_id), "maquina_id"),
    fulfillment_center: text(m.cd),
    maker_model: text(m.fabricante_modelo),
    technology: text(m.tecnologia),
    product_types: (m.tipos_produto_atendidos ?? "").split(";").map((s) => s.trim()).filter(Boolean),
    capacity_per_hour: int(m.capacidade_pecas_hora),
    installed_on: date(m.data_instalacao),
    last_cartridge_change_on: date(m.ultima_troca_cartucho),
    last_preventive_maintenance_on: date(m.ultima_manutencao_preventiva),
    status: text(m.status),
  })),
};

// ---------- Políticas, ferramentas e equipe ----------
const politicasCsv = csv("politicas");
const policyVersion = must(
  text(politicasCsv.find((p) => p.secao === "versao")?.valor),
  "versão da política",
);
const policies: Dataset = {
  table: "policies",
  onConflict: "section,rule",
  source: politicasCsv.length,
  rows: politicasCsv.map((p) => ({
    section: must(text(p.secao), "secao"),
    rule: must(text(p.regra), "regra"),
    value: text(p.valor),
    version: policyVersion,
    scope: "group",
    valid_from: date(policyVersion),
  })),
};

const ferramentasCsv = csv("ferramentas");
const toolCatalog: Dataset = {
  table: "tool_catalog",
  onConflict: "tool",
  source: ferramentasCsv.length,
  rows: ferramentasCsv.map((f) => ({
    tool: must(text(f.ferramenta), "ferramenta"),
    kind: text(f.tipo),
    allowed_roles: (f.papeis_permitidos ?? "").split(";").map((s) => s.trim()).filter(Boolean),
    description: text(f.descricao),
    parameters: text(f.parametros),
    limits: JSON.parse(text(f.limites) ?? "{}"),
    cost_cents: cents(f.custo_rs),
  })),
};

const equipeCsv = csv("equipe_atendimento");
const staffBase = equipeCsv.map((e) => ({
  staff_code: must(text(e.colaborador_id), "colaborador_id"),
  full_name: e.nome,
  email: must(text(e.email_corporativo), "email"),
  role: e.cargo,
  level: text(e.nivel),
  channels: (e.canais_atendidos ?? "").split(";").map((s) => s.trim()).filter(Boolean),
  hired_on: date(e.data_admissao),
  active: e.status === "ativo",
}));

// ---------- Validação de referências (antes de escrever) ----------
function refs(rows: Rec[], col: string, valid: Set<string>, nullable = false) {
  const bad = rows.filter((r) => {
    const v = r[col];
    return v === null || v === undefined ? !nullable : !valid.has(String(v));
  });
  return bad;
}
const set = (ds: Dataset, col: string) => new Set(ds.rows.map((r) => String(r[col])));
const skuSet = set(products, "sku");
const customerSet = set(customers, "customer_id");
const orderSet = set(orders, "order_id");
const conversationSet = set(conversations, "conversation_id");
const lotSet = new Set(productLots.rows.map((l) => `${l.lot}|${l.sku}`));

const problems: string[] = [];
function expect(name: string, bad: Rec[], key: string) {
  if (bad.length) problems.push(`${name}: ${bad.length} referência(s) inválida(s), ex.: ${bad.slice(0, 3).map((b) => b[key]).join(", ")}`);
}
function unique(ds: Dataset, ...cols: string[]) {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const r of ds.rows) {
    const k = cols.map((c) => r[c]).join("|");
    if (seen.has(k)) dup.add(k);
    else seen.add(k);
  }
  if (dup.size) problems.push(`${ds.table}: ${dup.size} chave(s) duplicada(s), ex.: ${[...dup].slice(0, 3).join(", ")}`);
}

for (const ds of [products, productLots, customers, orders, orderItems, conversations, messages, policies, toolCatalog, carrierTickets, attachments, printMachines]) {
  unique(ds, ...ds.onConflict.split(","));
}
expect("carrier_tickets.order_id", refs(carrierTickets.rows, "order_id", orderSet), "ticket_id");
expect("carrier_tickets.conversation_id", refs(carrierTickets.rows, "conversation_id", conversationSet, true), "ticket_id");
expect("attachments.order_id", refs(attachments.rows, "order_id", orderSet, true), "attachment_id");
expect("attachments.conversation_id", refs(attachments.rows, "conversation_id", conversationSet, true), "attachment_id");
expect("attachments.customer_id", refs(attachments.rows, "customer_id", customerSet, true), "attachment_id");
unique(trackingEvents, "order_id", "portal", "event_at", "status");
expect("orders.customer_id", refs(orders.rows, "customer_id", customerSet), "order_id");
expect("orders.sku", refs(orders.rows, "sku", skuSet, true), "order_id");
expect("order_items.order_id", refs(orderItems.rows, "order_id", orderSet), "item_id");
expect("order_items.sku", refs(orderItems.rows, "sku", skuSet, true), "item_id");
expect("conversations.customer_id", refs(conversations.rows, "customer_id", customerSet), "conversation_id");
expect("conversations.order_id", refs(conversations.rows, "order_id", orderSet, true), "conversation_id");
expect("messages.conversation_id", refs(messages.rows, "conversation_id", conversationSet), "message_id");
expect("tracking_events.order_id", refs(trackingEvents.rows, "order_id", orderSet), "order_id");
expect("product_lots.sku", refs(productLots.rows, "sku", skuSet), "lot");
const missingLots = orders.rows.filter((o) => o.product_lot && o.sku && !lotSet.has(`${o.product_lot}|${o.sku}`));
if (missingLots.length) {
  // Informativo: pedidos cujo lote+SKU não consta em lotes_producao.csv (não bloqueia).
  console.warn(`Aviso: ${missingLots.length} pedido(s) com lote+SKU ausente de lotes_producao.csv, ex.: ${missingLots.slice(0, 3).map((o) => `${o.order_id}(${o.product_lot}/${o.sku})`).join(", ")}`);
}
const futureOrders = orders.rows.filter((o) => String(o.ordered_at) > "2026-11-02T08:00:00-03:00").length;

// ---------- Ordem de carga ----------
const datasets: Dataset[] = [
  businessUnits, brands, products, productLots, customers, orders, orderItems,
  conversations, messages, trackingEvents, carrierTickets, attachments, printMachines, policies, toolCatalog,
];

function report() {
  console.log("\nRelatório da leitura dos CSVs");
  console.log("tabela".padEnd(20), "linhas (fonte)".padStart(15), "linhas a gravar".padStart(17));
  for (const ds of datasets) console.log(ds.table.padEnd(20), String(ds.source).padStart(15), String(ds.rows.length).padStart(17));
  console.log("staff".padEnd(20), String(equipeCsv.length).padStart(15), String(staffBase.length).padStart(17));
  console.log(`\nPedidos com data posterior a 02/11 08:00 (ocultos até o relógio alcançar): ${futureOrders}`);
  console.log(`Conversas sem tag (mantidas sem tag): ${conversations.rows.filter((c) => c.origin === "historico" && !c.agent_tag).length}`);
}

if (problems.length) {
  console.error("Importação interrompida, referências inconsistentes:");
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
if (dryRun) {
  report();
  console.log("\n--dry-run: nenhuma escrita realizada. Referências conferidas sem erros.");
  process.exit(0);
}

// ---------- Escrita ----------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  console.error("Defina NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SECRET_KEY (ex.: node --env-file=.env.local ...).");
  process.exit(2);
}
const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

async function load(table: string, onConflict: string, rows: Rec[]) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error } = await db.from(table).upsert(rows.slice(i, i + BATCH), { onConflict });
    if (error) throw new Error(`${table} (lote ${i / BATCH + 1}): ${error.message}`);
  }
  console.log(`  ${table}: ${rows.length} linhas gravadas`);
}

async function count(table: string) {
  const { count: n, error } = await db.from(table).select("*", { count: "exact", head: true });
  if (error) throw new Error(`contagem de ${table}: ${error.message}`);
  return n ?? 0;
}

async function main() {
  console.log(`Importando BD/ (cenário "${scenarioName}")...`);
  for (const ds of datasets) await load(ds.table, ds.onConflict, ds.rows);

  // Equipe: dois passos, para resolver o supervisor pelo staff_code. Vínculo com Auth e escopos ficam fora da carga.
  await load("staff", "staff_code", staffBase);
  const { data: staffIds, error: staffErr } = await db.from("staff").select("id, staff_code");
  if (staffErr) throw new Error(`staff: ${staffErr.message}`);
  const idByCode = new Map(staffIds!.map((s) => [s.staff_code as string, s.id as string]));
  const withSupervisor = equipeCsv
    .filter((e) => text(e.supervisor_id))
    .map((e) => {
      const base = staffBase.find((s) => s.staff_code === e.colaborador_id)!;
      const sup = idByCode.get(e.supervisor_id);
      if (!sup) throw new Error(`Supervisor não encontrado: ${e.supervisor_id}`);
      return { ...base, supervisor_id: sup };
    });
  await load("staff", "staff_code", withSupervisor);

  // GOB-05: documentos de conhecimento (busca textual) derivados de policies e products.
  const rebuilt = await db.rpc("rebuild_knowledge");
  if (rebuilt.error) throw new Error(`rebuild_knowledge: ${rebuilt.error.message}`);
  console.log(`  knowledge_documents: ${rebuilt.data} documentos reconstruídos`);

  // Cenário padrão: criado uma vez, nunca reiniciado pela importação.
  const { data: run, error: runErr } = await db
    .from("scenario_runs")
    .upsert({ name: scenarioName, mode: "demo" }, { onConflict: "name", ignoreDuplicates: true })
    .select("id");
  if (runErr) throw new Error(`scenario_runs: ${runErr.message}`);
  console.log(`  scenario_runs: "${scenarioName}" ${run?.length ? "criado" : "já existia"}`);

  console.log("\nConferência (banco × CSV)");
  let bad = 0;
  for (const ds of [...datasets, { table: "staff", onConflict: "staff_code", source: staffBase.length, rows: staffBase }]) {
    const inDb = await count(ds.table);
    const ok = ds.table === "staff" ? inDb >= ds.rows.length : inDb === ds.rows.length;
    if (!ok) bad++;
    console.log(`${ok ? "OK  " : "FALHA"} ${ds.table.padEnd(20)} banco=${inDb} esperado${ds.table === "staff" ? " (mín.)" : ""}=${ds.rows.length}`);
  }
  console.log(`\nPedidos futuros no arquivo: ${futureOrders} (ocultos por orders_as_of até o relógio alcançá-los).`);
  if (bad) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
