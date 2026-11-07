// GOB-04 · Entrada comum de contatos (WhatsApp, e-mail e Reclame Aqui simulados) e identificação do contexto.
// Sem dependências de runtime além de tipos: o mesmo arquivo roda no servidor Next e nos scripts de verificação.
// A mensagem externa é tratada como dado; quem decide a associação é o servidor, com fatos do banco.
import type { SupabaseClient } from "@supabase/supabase-js";

export const CHANNELS = ["whatsapp", "email", "reclame_aqui"] as const;
export type Channel = (typeof CHANNELS)[number];

/** Contrato comum: preserva canal, conversa e identificador de origem. */
export interface ContactEvent {
  channel: Channel;
  externalEventId: string;
  externalConversationId?: string;
  /** Conversa já existente na base importada (fila inicial). */
  sourceConversationId?: string;
  customerId?: string;
  email?: string;
  phone?: string;
  orderId?: string;
  /** Conta/marca do canal de origem: pista, nunca confirmação. */
  account?: string;
  subject?: string;
  text: string;
  receivedAt: string;
}

const str = (v: unknown, max: number): string | undefined | null => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > max) return null;
  return v.trim() || undefined;
};

/** Valida o evento recebido. Qualquer campo fora do contrato rejeita a entrega. */
export function parseContactEvent(raw: unknown): { ok: true; event: ContactEvent } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "Corpo inválido." };
  const r = raw as Record<string, unknown>;
  if (typeof r.channel !== "string" || !(CHANNELS as readonly string[]).includes(r.channel)) {
    return { ok: false, error: "Canal inválido." };
  }
  const externalEventId = str(r.externalEventId, 200);
  if (!externalEventId) return { ok: false, error: "externalEventId obrigatório." };
  const text = str(r.text, 5000);
  if (!text) return { ok: false, error: "text obrigatório (até 5000 caracteres)." };
  if (typeof r.receivedAt !== "string" || !/(Z|[+-]\d{2}:?\d{2})$/.test(r.receivedAt) || Number.isNaN(Date.parse(r.receivedAt))) {
    return { ok: false, error: "receivedAt deve ser ISO 8601 com fuso." };
  }
  const optional: Record<string, string | undefined> = {};
  for (const [key, max] of [
    ["externalConversationId", 200], ["sourceConversationId", 100], ["customerId", 100], ["email", 200],
    ["phone", 40], ["orderId", 100], ["account", 100], ["subject", 300],
  ] as const) {
    const v = str(r[key], max);
    if (v === null) return { ok: false, error: `${key} inválido.` };
    optional[key] = v;
  }
  return {
    ok: true,
    event: { channel: r.channel as Channel, externalEventId, text, receivedAt: new Date(r.receivedAt).toISOString(), ...optional },
  };
}

// ---------- Assunto ----------

export const TOPICS = [
  "rastreio_atraso", "troca_devolucao", "avaria", "personalizacao", "brinde", "reacao_adversa", "cancelamento", "outros",
] as const;
export type Topic = (typeof TOPICS)[number];

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Ordem importa: relato de saúde e avaria prevalecem sobre assuntos genéricos de entrega.
const TOPIC_RULES: [Topic, RegExp][] = [
  ["reacao_adversa", /alergi|reacao|irritacao|vermelhidao|coceira|queimou|ardencia|mancha na pele/],
  ["avaria", /quebrad|danificad|avaria|rachad|amassad|vazou|veio quebr/],
  ["personalizacao", /personaliza\w* errad|nome errado|estampa errad|impressao errad|arte errad/],
  ["troca_devolucao", /\btroca|\btrocar|devolu/],
  ["cancelamento", /cancel/],
  ["brinde", /brinde/],
  ["rastreio_atraso", /atras|rastre|nao entreg|nao chegou|entreg|prazo|sem atualiza|extravi|parado|nao recebi/],
];

/** Classificação determinística por palavras-chave; a classificação por IA entra na GOB-07. */
export function classifyTopic(subject: string | undefined, text: string): Topic {
  const hay = norm(`${subject ?? ""} ${text}`);
  return TOPIC_RULES.find(([, re]) => re.test(hay))?.[0] ?? "outros";
}

// ---------- Contexto ----------

export interface Source {
  type: "customer" | "order" | "product" | "brand_hint" | "mentioned_order" | "candidate_order";
  id: string;
  detail?: string;
}

export interface CustomerFact { customer_id: string; email: string | null; phone: string | null }
export interface OrderFact {
  order_id: string; customer_id: string; brand_id: string; business_unit_id: string; sku: string | null;
}
export interface ProductFact { sku: string; brand_id: string; business_unit_id: string }
export interface BrandFact { id: string; business_unit_id: string }

export interface Facts {
  customers: CustomerFact[];
  /** Pedidos citados (já filtrados pelo relógio do cenário). */
  mentionedOrderIds: string[];
  orders: OrderFact[];
  product: ProductFact | null;
  customerOrders: OrderFact[];
  accountBrand: BrandFact | null;
}

export interface ResolvedContext {
  customer_id: string | null;
  order_id: string | null;
  brand_id: string | null;
  business_unit_id: string | null;
  topic: Topic;
  clarification: string | null;
  sources: Source[];
}

export const ORDER_ID_RE = /\b[A-Z]{3}\d{6}\b/g;
export const extractOrderIds = (text: string): string[] => [...new Set(text.toUpperCase().match(ORDER_ID_RE) ?? [])];

// Prefixo do pedido é só indício auxiliar da unidade (planejamento §7.1.1).
const PREFIX_UNIT: Record<string, string> = { GCH: "gocase", GBH: "gobeaute" };

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
export const phoneMatches = (a: string | null | undefined, b: string | null | undefined) => {
  const x = digits(a), y = digits(b);
  return x.length >= 10 && y.length >= 10 && x.slice(-10) === y.slice(-10);
};

function pending(topic: Topic, customer: string | null, code: string, message: string, sources: Source[]): ResolvedContext {
  return {
    customer_id: customer, order_id: null, brand_id: null, business_unit_id: null,
    topic, clarification: `[${code}] ${message}`, sources,
  };
}

/**
 * Decide o contexto a partir de fatos verificados. Identidade incerta ou conflito vira pendência de
 * esclarecimento, nunca palpite: sem cliente verificado, não há pedido, marca nem associação.
 */
export function resolveContext(event: ContactEvent, topic: Topic, facts: Facts): ResolvedContext {
  const sources: Source[] = [];

  if (facts.customers.length !== 1) {
    const many = facts.customers.length > 1;
    for (const id of facts.mentionedOrderIds) sources.push({ type: "mentioned_order", id });
    return pending(
      topic, null, many ? "cliente_ambiguo" : "cliente_nao_identificado",
      many ? "Mais de um cliente corresponde aos dados do contato; confirmar identidade." : "Não foi possível identificar o cliente; pedir nome, e-mail ou telefone cadastrados.",
      sources,
    );
  }
  const customer = facts.customers[0];
  sources.push({ type: "customer", id: customer.customer_id });

  if (facts.mentionedOrderIds.length > 1) {
    for (const id of facts.mentionedOrderIds) sources.push({ type: "candidate_order", id });
    return pending(topic, customer.customer_id, "pedido_ambiguo", "O contato cita mais de um pedido; confirmar qual deve ser tratado.", sources);
  }

  if (facts.mentionedOrderIds.length === 0) {
    for (const o of facts.customerOrders) sources.push({ type: "candidate_order", id: o.order_id });
    return pending(
      topic, customer.customer_id, "pedido_nao_identificado",
      facts.customerOrders.length ? "Pedido não informado; o cliente tem pedidos recentes, confirmar qual." : "Pedido não informado e sem pedidos disponíveis para o cliente.",
      sources,
    );
  }

  const [mentioned] = facts.mentionedOrderIds;
  const order = facts.orders.find((o) => o.order_id === mentioned);
  if (!order) {
    sources.push({ type: "mentioned_order", id: mentioned });
    return pending(topic, customer.customer_id, "pedido_nao_encontrado", "O pedido citado não foi encontrado; confirmar o número.", sources);
  }
  if (order.customer_id !== customer.customer_id) {
    sources.push({ type: "mentioned_order", id: mentioned });
    return pending(topic, customer.customer_id, "pedido_de_outro_cliente", "O pedido citado não pertence ao cliente identificado; confirmar.", sources);
  }

  sources.push({ type: "order", id: order.order_id });
  if (facts.product) sources.push({ type: "product", id: facts.product.sku });

  const conflicts: string[] = [];
  if (facts.product && (facts.product.brand_id !== order.brand_id || facts.product.business_unit_id !== order.business_unit_id)) {
    conflicts.push("catálogo diverge do pedido (marca/unidade do SKU)");
  }
  if (facts.accountBrand) {
    sources.push({ type: "brand_hint", id: facts.accountBrand.id, detail: "conta do canal" });
    if (facts.accountBrand.id !== order.brand_id) conflicts.push("conta de origem aponta outra marca");
  }
  const prefixUnit = PREFIX_UNIT[order.order_id.slice(0, 3)];
  if (prefixUnit && prefixUnit !== order.business_unit_id) conflicts.push("prefixo do pedido aponta outra unidade");
  if (conflicts.length) {
    return pending(topic, customer.customer_id, "marca_divergente", `Conflito de identidade da marca: ${conflicts.join("; ")}.`, sources);
  }

  return {
    customer_id: customer.customer_id, order_id: order.order_id, brand_id: order.brand_id,
    business_unit_id: order.business_unit_id, topic, clarification: null, sources,
  };
}

// ---------- Banco ----------

type Db = SupabaseClient;

function must<T>(r: { data: T; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
}

const ORDER_COLS = "order_id, customer_id, brand_id, business_unit_id, sku";

export async function loadFacts(db: Db, runId: string, event: ContactEvent): Promise<Facts> {
  const run = must(await db.from("scenario_runs").select("clock_now").eq("id", runId).single(), "cenário");
  const clock = run!.clock_now as string;

  // Cliente: identificador explícito, senão e-mail/telefone cadastrados.
  let customers: CustomerFact[] = [];
  const cols = "customer_id, email, phone";
  if (event.customerId) {
    customers = must(await db.from("customers").select(cols).eq("customer_id", event.customerId), "cliente") as CustomerFact[];
  } else if (event.email) {
    customers = must(await db.from("customers").select(cols).ilike("email", event.email.trim()), "cliente por e-mail") as CustomerFact[];
  } else if (event.phone && digits(event.phone).length >= 10) {
    const tail = digits(event.phone).slice(-4);
    const found = must(await db.from("customers").select(cols).ilike("phone", `%${tail}%`), "cliente por telefone") as CustomerFact[];
    customers = found.filter((c) => phoneMatches(c.phone, event.phone));
  }

  // Pedidos citados no campo estruturado ou no texto; só os que já existem no relógio do cenário.
  const mentioned = event.orderId ? [event.orderId.toUpperCase()] : extractOrderIds(`${event.subject ?? ""} ${event.text}`);
  const mentionedOrderIds = mentioned;
  const orders = mentioned.length
    ? (must(await db.from("orders").select(ORDER_COLS).in("order_id", mentioned).lte("ordered_at", clock), "pedidos") as OrderFact[])
    : [];

  let customerOrders: OrderFact[] = [];
  if (customers.length === 1 && mentioned.length === 0) {
    customerOrders = must(
      await db.from("orders").select(ORDER_COLS).eq("customer_id", customers[0].customer_id)
        .lte("ordered_at", clock).order("ordered_at", { ascending: false }).limit(5),
      "pedidos do cliente",
    ) as OrderFact[];
  }

  const sku = orders.length === 1 ? orders[0].sku : null;
  const product = sku
    ? ((must(await db.from("products").select("sku, brand_id, business_unit_id").eq("sku", sku).maybeSingle(), "produto") as ProductFact | null) ?? null)
    : null;

  // Conta de origem → marca (por id, nome ou alias).
  let accountBrand: BrandFact | null = null;
  if (event.account) {
    const key = norm(event.account).replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const brands = must(await db.from("brands").select("id, name, business_unit_id"), "marcas") as (BrandFact & { name: string })[];
    const aliases = must(await db.from("brand_aliases").select("alias, brand_id"), "aliases") as { alias: string; brand_id: string }[];
    const byAlias = aliases.find((a) => a.alias === norm(event.account!).trim())?.brand_id;
    accountBrand = brands.find((b) => b.id === (byAlias ?? key)) ?? null;
  }

  return { customers, mentionedOrderIds, orders, product, customerOrders, accountBrand };
}

export interface IngestResult {
  duplicate: boolean;
  case_id: string;
  conversation_id: string;
  new_case?: boolean;
  needs_clarification?: boolean;
}

/** Recebe um contato: valida contexto no servidor e grava evento, conversa, mensagem e caso numa transação. */
/** Confirmação automática de recebimento: só informa o recebimento; não promete resultado, prazo de solução nem ação. */
export const ACK_MESSAGE = "Recebemos o seu contato e o seu caso já está em andamento. Assim que houver um próximo passo confirmado, avisamos você por aqui. Esta é uma confirmação automática de recebimento.";

/** Com `enqueue`, o caso novo nasce com tarefa de investigação e confirmação de recebimento na MESMA transação (entrada real). A fila inicial importada não enfileira. */
export async function ingestContact(db: Db, runId: string, event: ContactEvent, opts: { enqueue?: boolean; deadlineMinutes?: number } = {}): Promise<IngestResult> {
  const topic = classifyTopic(event.subject, event.text);
  const facts = await loadFacts(db, runId, event);
  const ctx = resolveContext(event, topic, facts);
  const { data, error } = await db.rpc(opts.enqueue ? "record_contact_and_enqueue" : "record_contact", {
    p_run: runId,
    p_event: {
      channel: event.channel,
      external_event_id: event.externalEventId,
      external_conversation_id: event.externalConversationId ?? null,
      source_conversation_id: event.sourceConversationId ?? null,
      subject: event.subject ?? null,
      text: event.text,
      received_at: event.receivedAt,
    },
    p_ctx: ctx,
    ...(opts.enqueue ? { p_ack: ACK_MESSAGE, p_deadline_minutes: opts.deadlineMinutes ?? 30 } : {}),
  });
  if (error) throw new Error(`record_contact: ${error.message}`);
  return data as IngestResult;
}

/** Fila inicial: conversas abertas da base que já existem no relógio do cenário viram casos. */
export async function seedInitialQueue(db: Db, runId: string): Promise<{ processed: number; duplicates: number; cases: number }> {
  const run = must(await db.from("scenario_runs").select("clock_now").eq("id", runId).single(), "cenário");
  const convs = must(
    await db.from("conversations")
      .select("conversation_id, customer_id, order_id, brand_id, channel, subject, opened_at")
      .eq("origin", "fila").is("scenario_run_id", null).lte("opened_at", run!.clock_now as string)
      .order("opened_at"),
    "fila",
  ) as { conversation_id: string; customer_id: string | null; order_id: string | null; brand_id: string | null; channel: Channel; subject: string | null; opened_at: string }[];

  const msgs = convs.length
    ? (must(
        await db.from("messages").select("conversation_id, body, sent_at").in("conversation_id", convs.map((c) => c.conversation_id)).eq("author", "cliente").order("sent_at"),
        "mensagens da fila",
      ) as { conversation_id: string; body: string | null }[])
    : [];
  const first = new Map<string, string>();
  for (const m of msgs) if (!first.has(m.conversation_id) && m.body) first.set(m.conversation_id, m.body);

  let duplicates = 0;
  const caseIds = new Set<string>();
  for (const c of convs) {
    const result = await ingestContact(db, runId, {
      channel: c.channel,
      externalEventId: c.conversation_id,
      sourceConversationId: c.conversation_id,
      customerId: c.customer_id ?? undefined,
      orderId: c.order_id ?? undefined,
      account: c.brand_id ?? undefined,
      subject: c.subject ?? undefined,
      text: first.get(c.conversation_id) ?? c.subject ?? "(sem texto)",
      receivedAt: new Date(c.opened_at).toISOString(),
    });
    if (result.duplicate) duplicates++;
    caseIds.add(result.case_id);
  }
  return { processed: convs.length, duplicates, cases: caseIds.size };
}

// ---------- Saída pública ----------

export const isPublicChannel = (channel: Channel) => channel === "reclame_aqui";

/** Remove dados privados de um texto destinado a canal público (CPF, e-mail, telefone, cartão, pedido, rastreio). */
export function publicSafeText(text: string): { text: string; redacted: boolean } {
  const out = text
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[CPF omitido]")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[e-mail omitido]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[cartão omitido]")
    .replace(/(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g, "[telefone omitido]")
    .replace(ORDER_ID_RE, "[pedido]")
    .replace(/\b[A-Z]{2}\d{9}[A-Z]{2}\b/g, "[rastreio omitido]");
  return { text: out, redacted: out !== text };
}

/** Texto de resposta para o canal: o público nunca recebe dado privado; os demais seguem sem alteração. */
export function composeOutbound(channel: Channel, text: string): { text: string; redacted: boolean } {
  return isPublicChannel(channel) ? publicSafeText(text) : { text, redacted: false };
}
