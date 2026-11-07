// GOB-05 · Formato padrão das consultas e regras puras sobre evidências. Sem acesso a banco: roda no Next e em scripts.

/** Referência verificável de um dado: tabela/documento, identificador e quando o fato ocorreu (ou a versão da fonte). */
export interface SourceRef {
  table: string;
  id: string;
  at?: string | null;
  version?: string | null;
}

export interface Conflict {
  field: string;
  detail: string;
  sources: SourceRef[];
}

/**
 * Saída padrão de toda consulta. `asOf` é o relógio do cenário usado; dado ausente e dado conflitante são
 * declarados aqui, nunca preenchidos silenciosamente.
 */
export interface Evidence<T> {
  data: T | null;
  asOf: string;
  sources: SourceRef[];
  missing: string[];
  conflicts: Conflict[];
}

export function evidence<T>(
  asOf: string,
  data: T | null,
  parts: { sources?: SourceRef[]; missing?: string[]; conflicts?: Conflict[] } = {},
): Evidence<T> {
  return { data, asOf, sources: parts.sources ?? [], missing: parts.missing ?? [], conflicts: parts.conflicts ?? [] };
}

// ---------------------------------------------------------------------------
// Pedido na posição do relógio
// ---------------------------------------------------------------------------

export interface OrderFacts {
  order_id: string;
  sku: string | null;
  delivery_status: string | null;
  separated_at: string | null;
  delivered_on: string | null;
  promised_on: string | null;
  tracking_code: string | null;
  product_lot: string | null;
}
export interface TrackingFacts {
  id?: number;
  portal: string;
  event_at: string;
  status: string;
  tracking_code: string | null;
  expected_on: string | null;
}
export interface ItemFacts {
  item_id: string;
  sku: string | null;
}

/** Data (America/Sao_Paulo, sem horário de verão desde 2019) de um instante. */
export const saoPauloDate = (iso: string): string => new Date(Date.parse(iso) - 3 * 3600_000).toISOString().slice(0, 10);

export interface OrderState {
  status: "aguardando_separacao" | "separado" | "em_transito" | "entregue" | "extraviado" | "devolvido" | "cancelado";
  separatedAt: string | null;
  deliveredOn: string | null;
  lastEvent: TrackingFacts | null;
  missing: string[];
}

/**
 * Situação do pedido no relógio do cenário. A base guarda o estado final de cada pedido; fatos datados depois do
 * relógio (separação, entrega, eventos) ainda não existem. Cancelado e devolvido não têm data na base e por isso
 * são informados com a ressalva correspondente.
 */
export function orderStateAt(order: OrderFacts, events: TrackingFacts[], clockIso: string): OrderState {
  const clock = Date.parse(clockIso);
  const visible = events.filter((e) => Date.parse(e.event_at) <= clock).sort((a, b) => Date.parse(a.event_at) - Date.parse(b.event_at));
  const last = visible.at(-1) ?? null;
  const separatedAt = order.separated_at && Date.parse(order.separated_at) <= clock ? order.separated_at : null;
  const missing: string[] = [];

  let status: OrderState["status"];
  if (order.delivery_status === "cancelado" || order.delivery_status === "devolvido") {
    status = order.delivery_status;
    missing.push(`data do status ${order.delivery_status} (a base informa só o estado final)`);
  } else if (last?.status === "entregue") status = "entregue";
  else if (last?.status === "extraviado") status = "extraviado";
  else if (last) status = "em_transito";
  else status = separatedAt ? "separado" : "aguardando_separacao";

  const deliveredOn = last?.status === "entregue"
    ? saoPauloDate(last.event_at)
    : order.delivered_on && order.delivered_on <= saoPauloDate(clockIso) ? order.delivered_on : null;

  if (!order.tracking_code && status !== "aguardando_separacao") missing.push("código de rastreio do pedido");
  return { status, separatedAt, deliveredOn, lastEvent: last, missing };
}

/** Divergências entre fontes. Cada uma cita as fontes envolvidas; nenhuma é resolvida automaticamente. */
export function orderConflicts(order: OrderFacts, items: ItemFacts[], events: TrackingFacts[], clockIso: string): Conflict[] {
  const clock = Date.parse(clockIso);
  const visible = events.filter((e) => Date.parse(e.event_at) <= clock).sort((a, b) => Date.parse(a.event_at) - Date.parse(b.event_at));
  const last = visible.at(-1) ?? null;
  const orderRef: SourceRef = { table: "orders", id: order.order_id };
  const out: Conflict[] = [];

  const codes = [...new Set(visible.map((e) => e.tracking_code).filter((c): c is string => !!c))];
  if (order.tracking_code && codes.some((c) => c !== order.tracking_code)) {
    out.push({
      field: "codigo_rastreio",
      detail: `O pedido informa ${order.tracking_code}, mas o portal registra ${codes.join(", ")}.`,
      sources: [orderRef, { table: "tracking_events", id: order.order_id, at: last?.event_at }],
    });
  }

  const skus = items.map((i) => i.sku).filter((s): s is string => !!s);
  if (order.sku && skus.length > 0 && !skus.includes(order.sku)) {
    out.push({
      field: "sku",
      detail: `O SKU do pedido (${order.sku}) não consta nos itens (${[...new Set(skus)].join(", ")}).`,
      sources: [orderRef, { table: "order_items", id: order.order_id }],
    });
  }

  if (last?.expected_on && order.promised_on && last.expected_on !== order.promised_on) {
    out.push({
      field: "previsao_entrega",
      detail: `O portal prevê ${last.expected_on}; a data prometida do pedido é ${order.promised_on}. As duas ficam registradas, sem substituir uma pela outra.`,
      sources: [orderRef, { table: "tracking_events", id: order.order_id, at: last.event_at }],
    });
  }

  const deliveredByOrder = order.delivered_on && order.delivered_on <= saoPauloDate(clockIso) ? order.delivered_on : null;
  const deliveredByPortal = last?.status === "entregue" ? saoPauloDate(last.event_at) : null;
  if (deliveredByOrder && !deliveredByPortal && visible.length > 0) {
    out.push({
      field: "entrega",
      detail: `O pedido registra entrega em ${deliveredByOrder}, mas o último evento do portal é "${last?.status}".`,
      sources: [orderRef, { table: "tracking_events", id: order.order_id, at: last?.event_at }],
    });
  } else if (deliveredByOrder && deliveredByPortal && deliveredByOrder !== deliveredByPortal) {
    out.push({
      field: "data_entrega",
      detail: `O pedido registra entrega em ${deliveredByOrder}; o portal, em ${deliveredByPortal}.`,
      sources: [orderRef, { table: "tracking_events", id: order.order_id, at: last?.event_at }],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conhecimento: conflito entre versões e orçamento de contexto
// ---------------------------------------------------------------------------

export interface KnowledgeHit {
  id: string;
  kind: "policy" | "product";
  title: string;
  source: string;
  sourceRef: string;
  version: string;
  validFrom: string | null;
  validTo: string | null;
  scope: string;
  brandId: string | null;
  businessUnitId: string | null;
  sku: string | null;
  category: string | null;
  critical: boolean;
  exact: boolean;
  allTerms: boolean;
  rank: number;
  snippet: string;
}

export const hitSource = (h: KnowledgeHit, asOf: string): SourceRef => ({
  table: "knowledge_documents", id: h.id, version: h.version, at: h.validFrom ?? asOf,
});

/** Mesma categoria vigente em versões diferentes é conflito: exige esclarecimento, não escolha silenciosa. */
export function knowledgeConflicts(hits: KnowledgeHit[], asOf: string): Conflict[] {
  const byCategory = new Map<string, KnowledgeHit[]>();
  for (const h of hits) {
    if (!h.category || h.kind !== "policy") continue;
    byCategory.set(`${h.source}|${h.category}`, [...(byCategory.get(`${h.source}|${h.category}`) ?? []), h]);
  }
  const out: Conflict[] = [];
  for (const [, group] of byCategory) {
    const versions = [...new Set(group.map((h) => h.version))];
    if (versions.length > 1) {
      out.push({
        field: `politica:${group[0].category}`,
        detail: `Mais de uma versão vigente (${versions.join(", ")}).`,
        sources: group.map((h) => hitSource(h, asOf)),
      });
    }
  }
  return out;
}

/**
 * Limita o texto enviado ao modelo: mantém a ordem do ranking, corta no orçamento de caracteres e sempre preserva a
 * citação (id, versão, fonte). Trecho cortado termina em reticências; o que não coube é contado em `omitted`.
 */
export function limitContext(hits: KnowledgeHit[], budgetChars: number): { items: KnowledgeHit[]; omitted: number; chars: number } {
  const items: KnowledgeHit[] = [];
  let used = 0;
  for (const h of hits) {
    const room = budgetChars - used;
    if (room < 80) break;
    const snippet = h.snippet.length > room ? `${h.snippet.slice(0, room - 1).trimEnd()}…` : h.snippet;
    items.push({ ...h, snippet });
    used += snippet.length;
  }
  return { items, omitted: hits.length - items.length, chars: used };
}
