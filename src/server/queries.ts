// GOB-05 · Consultas estruturadas por identificador (pedido, itens, catálogo, rastreio, produção e anexos).
// Use o cliente da SESSÃO do funcionário: a RLS aplica o escopo de unidade/marca. Todas as leituras respeitam o relógio do
// cenário (visões *_as_of). Pedido fora do escopo e pedido inexistente são indistinguíveis de propósito.
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  evidence, orderConflicts, orderStateAt,
  type Evidence, type OrderFacts, type OrderState, type SourceRef, type TrackingFacts,
} from "./evidence.ts";

export async function scenarioClock(db: SupabaseClient, runId: string): Promise<string> {
  const { data, error } = await db.from("scenario_runs").select("clock_now").eq("id", runId).maybeSingle();
  if (error) throw new Error(`relógio: ${error.message}`);
  if (!data) throw new Error("Cenário não encontrado.");
  return data.clock_now as string;
}

const fail = (what: string, error: { message: string }) => new Error(`${what}: ${error.message}`);

type OrderRow = OrderFacts & {
  customer_id: string; brand_id: string; business_unit_id: string; ordered_at: string; total_cents: number;
  product_description: string | null; personalization: string | null; carrier: string | null; uf: string | null;
  fulfillment_center: string | null; print_machine: string | null; sales_channel: string | null; items_count: number | null;
  coupon: string | null; payment_status: string | null; payment_method: string | null;
};

const ORDER_COLUMNS = "order_id, customer_id, brand_id, business_unit_id, ordered_at, total_cents, sku, product_description, personalization, carrier, uf, delivery_status, separated_at, fulfillment_center, print_machine, delivered_on, product_lot, sales_channel, items_count, coupon, payment_method, payment_status, promised_on, tracking_code";

async function loadOrder(db: SupabaseClient, runId: string, orderId: string): Promise<OrderRow | null> {
  const { data, error } = await db.rpc("orders_as_of", { p_run: runId }).select(ORDER_COLUMNS).eq("order_id", orderId).maybeSingle();
  if (error) throw fail("pedido", error);
  return (data as OrderRow | null) ?? null;
}

async function loadEvents(db: SupabaseClient, runId: string, orderId: string): Promise<(TrackingFacts & { portal: string; location: string | null })[]> {
  const { data, error } = await db.rpc("tracking_events_as_of", { p_run: runId })
    .select("portal, event_at, status, location, expected_on, tracking_code").eq("order_id", orderId).order("event_at");
  if (error) throw fail("rastreio", error);
  return data as (TrackingFacts & { location: string | null })[];
}

const notFound = (asOf: string, orderId: string) =>
  evidence<never>(asOf, null, { missing: [`pedido ${orderId} não encontrado no relógio do cenário ou fora do seu escopo`] });

// ---------------------------------------------------------------------------
// Pedido, itens, catálogo e lote
// ---------------------------------------------------------------------------

export interface OrderEvidence {
  order: Omit<OrderRow, "delivery_status" | "separated_at" | "delivered_on"> & {
    state: OrderState["status"]; separatedAt: string | null; deliveredOn: string | null;
  };
  items: { item_id: string; line: number; sku: string | null; description: string | null; item_type: string | null; quantity: number; personalization: string | null; personalization_text: string | null; lot: string | null }[];
  products: { sku: string; name: string; brand_id: string; business_unit_id: string; category: string | null; personalizable: boolean; personalization_type: string | null; production_days: number | null; status: string | null }[];
  lot: { lot: string; sku: string; manufacturer: string | null; manufactured_on: string | null; expires_on: string | null; quality_status: string | null; quality_report: string | null } | null;
}

export async function getOrderEvidence(db: SupabaseClient, runId: string, orderId: string): Promise<Evidence<OrderEvidence>> {
  const asOf = await scenarioClock(db, runId);
  const order = await loadOrder(db, runId, orderId);
  if (!order) return notFound(asOf, orderId);

  const [events, itemsRes] = await Promise.all([
    loadEvents(db, runId, orderId),
    db.rpc("order_items_as_of", { p_run: runId })
      .select("item_id, line, sku, description, item_type, quantity, personalization, personalization_text, lot")
      .eq("order_id", orderId).order("line"),
  ]);
  if (itemsRes.error) throw fail("itens", itemsRes.error);
  const items = itemsRes.data as OrderEvidence["items"];

  const skus = [...new Set([order.sku, ...items.map((i) => i.sku)].filter((s): s is string => !!s))];
  const productsRes = skus.length
    ? await db.from("products").select("sku, name, brand_id, business_unit_id, category, personalizable, personalization_type, production_days, status").in("sku", skus)
    : { data: [], error: null };
  if (productsRes.error) throw fail("catálogo", productsRes.error);
  const products = productsRes.data as OrderEvidence["products"];

  const missing: string[] = [];
  let lot: OrderEvidence["lot"] = null;
  if (order.product_lot && order.sku) {
    const lotRes = await db.from("product_lots")
      .select("lot, sku, manufacturer, manufactured_on, expires_on, quality_status, quality_report")
      .eq("lot", order.product_lot).eq("sku", order.sku).maybeSingle();
    if (lotRes.error) throw fail("lote", lotRes.error);
    lot = lotRes.data as OrderEvidence["lot"];
    if (!lot) missing.push(`lote ${order.product_lot} do SKU ${order.sku} sem registro em lotes de produção`);
  }
  for (const sku of skus) if (!products.some((p) => p.sku === sku)) missing.push(`SKU ${sku} fora do catálogo visível`);
  if (items.length === 0) missing.push("itens do pedido");

  const state = orderStateAt(order, events, asOf);
  const rest: Record<string, unknown> = { ...order };
  for (const k of ["delivery_status", "separated_at", "delivered_on"]) delete rest[k];
  const sources: SourceRef[] = [
    { table: "orders", id: orderId, at: order.ordered_at },
    ...items.map((i) => ({ table: "order_items", id: i.item_id })),
    ...products.map((p) => ({ table: "products", id: p.sku })),
    ...(lot ? [{ table: "product_lots", id: `${lot.lot}/${lot.sku}` }] : []),
  ];
  return evidence(asOf, {
    order: { ...(rest as Omit<OrderRow, "delivery_status" | "separated_at" | "delivered_on">), state: state.status, separatedAt: state.separatedAt, deliveredOn: state.deliveredOn },
    items, products, lot,
  }, { sources, missing: [...missing, ...state.missing], conflicts: orderConflicts(order, items, events, asOf) });
}

// ---------------------------------------------------------------------------
// Rastreio e chamados à transportadora
// ---------------------------------------------------------------------------

export interface TrackingEvidence {
  orderId: string;
  carrier: string | null;
  trackingCode: string | null;
  promisedOn: string | null;
  state: OrderState["status"];
  events: { portal: string; event_at: string; status: string; location: string | null; expected_on: string | null }[];
  lastEvent: { event_at: string; status: string } | null;
  hoursSinceLastEvent: number | null;
  tickets: { ticket_id: string; carrier: string; opened_at: string; reason: string | null; status: string | null; response_due_at: string | null; responded_at: string | null; carrier_response: string | null; new_expected_on: string | null; closed_at: string | null }[];
}

export async function getTrackingEvidence(db: SupabaseClient, runId: string, orderId: string): Promise<Evidence<TrackingEvidence>> {
  const asOf = await scenarioClock(db, runId);
  const order = await loadOrder(db, runId, orderId);
  if (!order) return notFound(asOf, orderId);

  const [events, ticketsRes] = await Promise.all([
    loadEvents(db, runId, orderId),
    db.rpc("carrier_tickets_as_of", { p_run: runId })
      .select("ticket_id, carrier, opened_at, reason, status, response_due_at, responded_at, carrier_response, new_expected_on, closed_at")
      .eq("order_id", orderId).order("opened_at"),
  ]);
  if (ticketsRes.error) throw fail("chamados", ticketsRes.error);
  const tickets = (ticketsRes.data as TrackingEvidence["tickets"]).map((t) => ({
    // Resposta e encerramento posteriores ao relógio ainda não aconteceram.
    ...t,
    ...(t.responded_at && Date.parse(t.responded_at) > Date.parse(asOf) ? { responded_at: null, carrier_response: null, new_expected_on: null } : {}),
    ...(t.closed_at && Date.parse(t.closed_at) > Date.parse(asOf) ? { closed_at: null } : {}),
    status: t.closed_at && Date.parse(t.closed_at) > Date.parse(asOf)
      ? (t.responded_at && Date.parse(t.responded_at) <= Date.parse(asOf) ? "respondido" : "aberto")
      : t.status,
  }));

  const state = orderStateAt(order, events, asOf);
  const missing = [...state.missing];
  if (events.length === 0) missing.push("eventos de rastreio até o relógio do cenário");
  if (!order.carrier) missing.push("transportadora do pedido");
  const last = state.lastEvent;

  return evidence(asOf, {
    orderId, carrier: order.carrier, trackingCode: order.tracking_code, promisedOn: order.promised_on, state: state.status,
    events: events.map((e) => ({ portal: e.portal, event_at: e.event_at, status: e.status, location: e.location, expected_on: e.expected_on })),
    lastEvent: last ? { event_at: last.event_at, status: last.status } : null,
    hoursSinceLastEvent: last ? Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(last.event_at)) / 3600_000)) : null,
    tickets,
  }, {
    sources: [
      { table: "orders", id: orderId },
      ...(last ? [{ table: "tracking_events", id: orderId, at: last.event_at }] : []),
      ...tickets.map((t) => ({ table: "carrier_tickets", id: t.ticket_id, at: t.opened_at })),
    ],
    missing,
    conflicts: orderConflicts(order, [], events, asOf),
  });
}

// ---------------------------------------------------------------------------
// Produção, personalização e anexos
// ---------------------------------------------------------------------------

export interface ProductionEvidence {
  orderId: string;
  personalization: string | null;
  fulfillmentCenter: string | null;
  separatedAt: string | null;
  machine: { machine_id: string; fulfillment_center: string | null; maker_model: string | null; status: string | null; last_cartridge_change_on: string | null; last_preventive_maintenance_on: string | null } | null;
  attachments: { attachment_id: string; sent_at: string; kind: string | null; exif_captured_at: string | null; exif_software: string | null; visual_description: string | null }[];
}

export async function getProductionEvidence(db: SupabaseClient, runId: string, orderId: string): Promise<Evidence<ProductionEvidence>> {
  const asOf = await scenarioClock(db, runId);
  const order = await loadOrder(db, runId, orderId);
  if (!order) return notFound(asOf, orderId);

  const [machineRes, attRes] = await Promise.all([
    order.print_machine
      ? db.from("print_machines").select("machine_id, fulfillment_center, maker_model, status, last_cartridge_change_on, last_preventive_maintenance_on").eq("machine_id", order.print_machine).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    db.rpc("attachments_as_of", { p_run: runId })
      .select("attachment_id, sent_at, kind, exif_captured_at, exif_software, visual_description").eq("order_id", orderId).order("sent_at"),
  ]);
  if (machineRes.error) throw fail("máquina", machineRes.error);
  if (attRes.error) throw fail("anexos", attRes.error);

  const state = orderStateAt(order, [], asOf);
  const machine = machineRes.data as ProductionEvidence["machine"];
  const attachments = attRes.data as ProductionEvidence["attachments"];
  const missing: string[] = [];
  // Máquina e separação só são conhecidas depois que o pedido foi separado.
  const separated = !!state.separatedAt;
  if (order.personalization && separated && !order.print_machine) missing.push("máquina de personalização do pedido");
  if (order.print_machine && !machine) missing.push(`máquina ${order.print_machine} sem registro`);
  if (order.personalization && !separated) missing.push("produção ainda não iniciada no relógio do cenário (pedido não separado)");
  if (attachments.length === 0) missing.push("anexos (fotos) enviados pelo cliente até o relógio do cenário");

  return evidence(asOf, {
    orderId,
    personalization: order.personalization,
    fulfillmentCenter: separated ? order.fulfillment_center : null,
    separatedAt: state.separatedAt,
    machine: separated ? machine : null,
    attachments,
  }, {
    sources: [
      { table: "orders", id: orderId, at: state.separatedAt },
      ...(separated && machine ? [{ table: "print_machines", id: machine.machine_id }] : []),
      ...attachments.map((a) => ({ table: "attachments", id: a.attachment_id, at: a.sent_at })),
    ],
    missing,
  });
}

// ---------------------------------------------------------------------------
// Ficha do catálogo
// ---------------------------------------------------------------------------

export async function getProductSheet(db: SupabaseClient, runId: string, sku: string): Promise<Evidence<Record<string, unknown>>> {
  const asOf = await scenarioClock(db, runId);
  const { data, error } = await db.from("products")
    .select("sku, name, brand_id, business_unit_id, category, kind, personalizable, personalization_type, production_days, composition, usage_instructions, warnings, shelf_life_months, anvisa_registry, status, attributes")
    .eq("sku", sku).maybeSingle();
  if (error) throw fail("produto", error);
  if (!data) return evidence<Record<string, unknown>>(asOf, null, { missing: [`SKU ${sku} não encontrado ou fora do seu escopo`] });
  const missing = (["composition", "usage_instructions", "warnings"] as const)
    .filter((k) => !data[k]).map((k) => `campo ${k} da ficha do SKU ${sku}`);
  return evidence(asOf, data, { sources: [{ table: "products", id: sku }], missing });
}
