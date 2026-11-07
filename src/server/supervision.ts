// Fila de supervisão: carrega a fila do funcionário (RLS pelo cliente da sessão) e enriquece com cliente, item e valor.
// `cache` do React deduplica a leitura dentro da mesma requisição (barra lateral e página usam o mesmo resultado).
import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listQueue, type QueueItem } from "./cases.ts";
import { createSessionClient } from "./db/client";
import { scenarioClock } from "./queries.ts";
import { needsHuman, type SupervisionRow } from "./supervision-model.ts";

export interface SupervisionData { runName: string | null; clockNow: string | null; rows: SupervisionRow[] }

export interface Lookups {
  nameOf: Map<string, string | null>;
  totalOf: Map<string, number | null>;
  itemsOf: Map<string, string[]>;
  brandOf: Map<string, { name: string; unit: string | null }>;
}

/** Nome do cliente, total e itens do pedido, e marca/unidade: leitura pelo cliente da sessão (RLS). */
export async function loadLookups(db: SupabaseClient, customerIds: string[], orderIds: string[]): Promise<Lookups> {
  const none = Promise.resolve({ data: [], error: null });
  const [customers, orders, lines, brands, units] = await Promise.all([
    customerIds.length ? db.from("customers").select("customer_id, full_name").in("customer_id", customerIds) : none,
    orderIds.length ? db.from("orders").select("order_id, total_cents").in("order_id", orderIds) : none,
    orderIds.length ? db.from("order_items").select("order_id, description, line").in("order_id", orderIds).order("line") : none,
    db.from("brands").select("id, name, business_unit_id"),
    db.from("business_units").select("id, name"),
  ]);
  for (const [name, r] of [["clientes", customers], ["pedidos", orders], ["itens", lines], ["marcas", brands], ["unidades", units]] as const) {
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
  }
  const unitName = new Map((units.data ?? []).map((u) => [u.id as string, u.name as string]));
  const itemsOf = new Map<string, string[]>();
  for (const l of lines.data ?? []) {
    const k = l.order_id as string;
    itemsOf.set(k, [...(itemsOf.get(k) ?? []), String(l.description ?? "").trim()].filter(Boolean));
  }
  return {
    nameOf: new Map((customers.data ?? []).map((c) => [c.customer_id as string, (c.full_name as string | null) ?? null])),
    totalOf: new Map((orders.data ?? []).map((o) => [o.order_id as string, (o.total_cents as number | null) ?? null])),
    itemsOf,
    brandOf: new Map((brands.data ?? []).map((x) => [x.id as string, { name: x.name as string, unit: unitName.get(x.business_unit_id as string) ?? null }])),
  };
}

/** Primeiro item do pedido; "+N" quando há mais. */
export const itemLabelOf = (its: string[] | undefined): string | null => (its?.length ? `${its[0]}${its.length > 1 ? ` +${its.length - 1}` : ""}` : null);

/** Enriquece os casos com cliente, item, valor, espera e empresa (marca e unidade). */
export async function enrichRows(db: SupabaseClient, items: QueueItem[], clockMs: number): Promise<SupervisionRow[]> {
  const customerIds = [...new Set(items.map((i) => i.customerId).filter((v): v is string => !!v))];
  const orderIds = [...new Set(items.map((i) => i.orderId).filter((v): v is string => !!v))];
  const L = await loadLookups(db, customerIds, orderIds);
  return items.map((i) => {
    const brand = i.brandId ? L.brandOf.get(i.brandId) : undefined;
    return {
      ...i,
      customerName: i.customerId ? L.nameOf.get(i.customerId) ?? null : null,
      itemLabel: itemLabelOf(i.orderId ? L.itemsOf.get(i.orderId) : undefined),
      amountCents: i.proposal?.amountCents ?? (i.orderId ? L.totalOf.get(i.orderId) ?? null : null),
      waitMs: Math.max(0, clockMs - Date.parse(i.openedAt)),
      brandName: brand?.name ?? null,
      unitName: brand?.unit ?? null,
    };
  });
}

async function loadRows(only: (c: QueueItem) => boolean): Promise<SupervisionData> {
  const db = await createSessionClient();
  const { data: run } = await db.from("scenario_runs").select("id").eq("name", "demo").maybeSingle();
  if (!run) return { runName: null, clockNow: null, rows: [] };
  const clock = await scenarioClock(db, run.id as string);
  const items = (await listQueue(db, run.id as string)).filter(only);
  return { runName: "demo", clockNow: clock, rows: await enrichRows(db, items, Date.parse(clock)) };
}

export const getSupervisionQueue = cache(() => loadRows(needsHuman));
/** Todos os casos abertos (não resolvidos), mais urgente primeiro. */
export const getAllCases = cache(() => loadRows(() => true));

export interface AgentStatus { tone: "online" | "instavel" | "indisponivel"; label: string }

/** Disponibilidade real da IA (disjuntor) e investigações em andamento; nunca um texto fixo "online". */
export const getAgentStatus = cache(async (): Promise<AgentStatus> => {
  const db = await createSessionClient();
  const [{ data: circuit }, { count }] = await Promise.all([
    db.from("ai_circuit").select("state").eq("name", "proxy").maybeSingle(),
    db.from("investigation_tasks").select("id", { count: "exact", head: true }).in("status", ["pendente", "reservada"]),
  ]);
  const n = count ?? 0;
  if (circuit?.state === "open") return { tone: "indisponivel", label: `IA indisponível, ${n} em espera` };
  if (circuit?.state === "half_open") return { tone: "instavel", label: `IA instável, ${n} em espera` };
  return { tone: "online", label: n === 0 ? "Agente online" : `Agente online, ${n} ${n === 1 ? "conversa" : "conversas"} em andamento` };
});
