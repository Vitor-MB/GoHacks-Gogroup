// GOB-05 · Verifica consultas por identificador e busca textual contra o banco de DESENVOLVIMENTO.
// Pré-requisitos: migration 20261107000005 aplicada e importação (GOB-03, atualizada na GOB-05) reexecutada.
// Uso: node --env-file=.env scripts/verify-knowledge.ts
//   TEST_PASSWORD (opcional): habilita a prova com a conta restrita (Kokeshi) pela API direta, como na GOB-02.
// Cria o cenário temporário "verify-knowledge" e o remove ao final.
import { createClient } from "@supabase/supabase-js";
import {
  knowledgeConflicts, limitContext, orderConflicts, orderStateAt,
  type KnowledgeHit, type OrderFacts, type TrackingFacts,
} from "../src/server/evidence.ts";
import { searchKnowledge } from "../src/server/knowledge.ts";
import { getOrderEvidence, getProductSheet, getProductionEvidence, getTrackingEvidence } from "../src/server/queries.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !secret) {
  console.error("Defina NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SECRET_KEY.");
  process.exit(2);
}
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const db = createClient(url, secret, opts);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FALHA"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const ok = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

const T0 = "2026-11-02T08:00:00-03:00";
let runId = "";

const hit = (over: Partial<KnowledgeHit>): KnowledgeHit => ({
  id: "policy:x", kind: "policy", title: "t", source: "BD/politicas.csv", sourceRef: "x", version: "2026-11-02",
  validFrom: null, validTo: null, scope: "group", brandId: null, businessUnitId: null, sku: null, category: "c",
  critical: false, exact: false, allTerms: true, rank: 1, snippet: "a".repeat(300), ...over,
});

async function search(query: string, extra: Record<string, unknown> = {}) {
  const r = ok(await db.rpc("search_knowledge", { p_run: runId, p_query: query, p_limit: 5, p_max_chars: 600, ...extra }), `busca "${query}"`);
  return r as { id: string; exact: boolean; brand_id: string | null; sku: string | null; kind: string; snippet: string; as_of: string }[];
}

async function main() {
  // ---- Regras puras ----
  const order: OrderFacts = {
    order_id: "GCH000001", sku: "GOC-5001", delivery_status: "entregue", separated_at: "2026-11-03T10:00:00-03:00",
    delivered_on: "2026-11-05", promised_on: "2026-11-04", tracking_code: "AA111BR", product_lot: null,
  };
  const ev = (status: string, at: string, code = "AA111BR", expected = "2026-11-06"): TrackingFacts =>
    ({ portal: "P", event_at: at, status, tracking_code: code, expected_on: expected });
  const events = [ev("coletado", "2026-11-03T12:00:00-03:00"), ev("entregue", "2026-11-05T15:00:00-03:00", "BB222BR")];
  const early = orderStateAt(order, events, T0);
  check("pedido antes da separação: fatos futuros ficam ocultos", early.status === "aguardando_separacao" && !early.separatedAt && !early.deliveredOn && !early.lastEvent);
  const mid = orderStateAt(order, events, "2026-11-04T08:00:00-03:00");
  check("em trânsito após a coleta", mid.status === "em_transito" && !!mid.separatedAt && !mid.deliveredOn);
  const late = orderStateAt(order, events, "2026-11-06T08:00:00-03:00");
  check("entregue só depois do evento", late.status === "entregue" && late.deliveredOn === "2026-11-05");
  check("cancelado sem data é informado como dado ausente",
    orderStateAt({ ...order, delivery_status: "cancelado" }, [], T0).missing.some((m) => m.includes("cancelado")));
  const conflicts = orderConflicts(order, [{ item_id: "i", sku: "GOC-9999" }], events, "2026-11-06T08:00:00-03:00").map((c) => c.field).sort();
  check("conflitos entre pedido, itens e portal são apontados", ["codigo_rastreio", "previsao_entrega", "sku"].every((f) => conflicts.includes(f)), conflicts.join(","));
  check("sem divergência, nenhum conflito", orderConflicts({ ...order, tracking_code: "AA111BR", promised_on: "2026-11-06" }, [{ item_id: "i", sku: "GOC-5001" }], [ev("coletado", "2026-11-03T12:00:00-03:00")], "2026-11-04T08:00:00-03:00").length === 0);
  const lim = limitContext([hit({ id: "a" }), hit({ id: "b" }), hit({ id: "c" })], 700);
  check("orçamento de contexto limita trechos e conta omitidos", lim.chars <= 700 && lim.omitted >= 0 && lim.items.length >= 1 && lim.items.length + lim.omitted === 3, `${lim.items.length} itens, ${lim.chars} caracteres`);
  check("versões diferentes da mesma política são conflito", knowledgeConflicts([hit({ id: "a", version: "1" }), hit({ id: "b", version: "2" })], T0).length === 1);

  // ---- Dados importados ----
  const cnt = async (t: string) => (await db.from(t).select("*", { count: "exact", head: true })).count ?? 0;
  const [tickets, atts, machines, docs] = await Promise.all([cnt("carrier_tickets"), cnt("attachments"), cnt("print_machines"), cnt("knowledge_documents")]);
  check("evidências importadas (chamados, anexos, máquinas)", tickets === 375 && atts === 382 && machines === 6, `${tickets}/${atts}/${machines} (rode scripts/import-data.ts se faltar)`);
  const policyDocs = (await db.from("knowledge_documents").select("*", { count: "exact", head: true }).eq("kind", "policy")).count ?? 0;
  const productDocs = (await db.from("knowledge_documents").select("*", { count: "exact", head: true }).eq("kind", "product")).count ?? 0;
  const products = await cnt("products");
  check("documentos: uma ficha por produto e trechos de política", productDocs === products && policyDocs > 20, `${productDocs} fichas, ${policyDocs} políticas`);
  const noSource = (await db.from("knowledge_documents").select("*", { count: "exact", head: true }).or("source.is.null,version.is.null,source_ref.is.null")).count ?? 0;
  check("todo documento tem fonte e versão", docs > 0 && noSource === 0);
  if (docs === 0) throw new Error("knowledge_documents vazio: rode a importação.");

  await db.from("scenario_runs").delete().eq("name", "verify-knowledge");
  runId = ok(await db.from("scenario_runs").insert({ name: "verify-knowledge", mode: "preview" }).select("id"), "criar cenário")![0].id;

  // ---- Termos em português recuperam a política esperada ----
  const expectTop = async (query: string, id: string, top = 3, extra: Record<string, unknown> = {}) => {
    const ids = (await search(query, extra)).map((r) => r.id);
    const pos = ids.indexOf(id);
    check(`"${query}" → ${id}`, pos >= 0 && pos < top, `posição ${pos + 1} de ${ids.length}`);
  };
  await expectTop("meu pedido está atrasado, quero abrir chamado com a transportadora", "policy:categorias/atraso_entrega");
  await expectTop("reação adversa ao cosmético", "policy:categorias/reacao_adversa");
  await expectTop("reacao adversa ao cosmetico", "policy:categorias/reacao_adversa");
  await expectTop("quero trocar a fragrância", "policy:categorias/troca_fragrancia");
  await expectTop("troca fragrancia", "policy:categorias/troca_fragrancia");
  await expectTop("cancelar o pedido antes de separar", "policy:categorias/arrependimento_cancelamento", 4);
  await expectTop("reembolso acima do limite precisa de aprovação do supervisor", "policy:limites_por_papel", 4);
  await expectTop("feriados nacionais", "policy:prazos_entrega", 1);

  // ---- Correspondência exata antes do texto ----
  const byCat = await search("", { p_category: "reacao_adversa" });
  check("categoria exata sem texto retorna a política com exact=true", byCat.length === 1 && byCat[0].id === "policy:categorias/reacao_adversa" && byCat[0].exact);
  const crit = await search("atraso", { p_category: "limites_por_papel" });
  check("correspondência exata vem antes do ranking textual", crit[0]?.id === "policy:limites_por_papel" && crit[0].exact);
  const reacao = ok(await db.from("knowledge_documents").select("body, critical").eq("id", "policy:categorias/reacao_adversa").single(), "reação");
  const reacaoHit = (await search("", { p_category: "reacao_adversa" }))[0];
  check("regra crítica volta inteira e citável", reacao!.critical && reacaoHit.snippet === reacao!.body.slice(0, 600));

  // ---- SKU e marca: nada de outro produto ----
  const sample = ok(await db.from("products").select("sku, brand_id, business_unit_id, name").in("brand_id", ["kokeshi", "gocase"]).limit(300), "produtos")!;
  const kok = sample.find((p) => p.brand_id === "kokeshi")!;
  const goc = sample.find((p) => p.brand_id === "gocase")!;
  const exactSku = await search("", { p_sku: kok.sku });
  check("SKU exato retorna só a ficha desse SKU", exactSku.length === 1 && exactSku[0].sku === kok.sku && exactSku[0].exact);
  const mismatch = await search("composição", { p_sku: kok.sku, p_brand: "gocase" });
  check("SKU de uma marca com filtro de outra marca não retorna nada de produto", mismatch.every((r) => r.kind !== "product"), `${mismatch.length} resultado(s)`);
  const brandOnly = await search("composição modo de uso advertências", { p_brand: "kokeshi", p_limit: 20 });
  const prods = brandOnly.filter((r) => r.kind === "product");
  check("consulta de marca restrita só traz fichas da própria marca", prods.length > 0 && prods.every((r) => r.brand_id === "kokeshi"), `${prods.length} fichas`);
  const noScope = await search("composição modo de uso advertências creme", { p_limit: 20 });
  check("sem marca, unidade ou SKU: apenas regras do grupo", noScope.every((r) => r.kind === "policy"));
  const unitOnly = await search("composição modo de uso", { p_unit: "gocase", p_limit: 20 });
  check("filtro de unidade não traz fichas da GoBeauté", unitOnly.filter((r) => r.kind === "product").every((r) => r.brand_id === "gocase"));

  // ---- Fichas: características no próprio SKU ----
  const fichaGb = ok(await db.from("knowledge_documents").select("body").eq("id", `product:${kok.sku}`).single(), "ficha")!;
  check("ficha traz marca e nome do próprio SKU", fichaGb.body.includes(kok.name) && fichaGb.body.includes("Marca: Kokeshi"));

  // ---- Vigência pelo relógio do cenário ----
  const camp = await search("brinde necessaire campanha mimo", {});
  check("campanha vigente aparece no relógio inicial (02/11)", camp.some((r) => r.id === "policy:campanha_vigente"));
  ok(await db.rpc("advance_scenario_clock", { p_run: runId, p_hours: 96 }), "avançar relógio");
  const campLate = await search("brinde necessaire campanha mimo", {});
  check("campanha encerrada (após 04/11) deixa de ser retornada", !campLate.some((r) => r.id === "policy:campanha_vigente"));
  ok(await db.rpc("reset_scenario_run", { p_run: runId }), "reset do relógio");

  // ---- Serviço: formato padrão, citações e orçamento ----
  const svc = await searchKnowledge(db, runId, { query: "atraso na entrega", budgetChars: 300 });
  const chars = svc.data!.hits.reduce((n, h) => n + h.snippet.length, 0);
  check("serviço devolve fontes com versão e respeita o orçamento", svc.sources.length === svc.data!.hits.length && svc.sources.every((s) => !!s.version) && chars <= 300 && svc.asOf === "2026-11-02", `${chars} caracteres`);
  const none = await searchKnowledge(db, runId, { query: "xyzzy qwerty inexistente" });
  check("sem resultado, a ausência é declarada", none.data!.hits.length === 0 && none.missing.length > 0);
  const noSku = await searchKnowledge(db, runId, { sku: "ZZZ-0000" });
  check("SKU inexistente declara ficha indisponível", noSku.data!.hits.length === 0 && noSku.missing.length > 0);

  // ---- Consultas por identificador ----
  const gch = await getOrderEvidence(db, runId, "GCH558661");
  check("pedido GCH558661: dados, itens, catálogo e fontes", !!gch.data && gch.data.items.length > 0 && gch.data.products.length > 0 && gch.sources.length > 1 && gch.asOf.startsWith("2026-11-02"),
    gch.data ? `estado ${gch.data.order.state}, ${gch.data.items.length} item(ns)` : gch.missing.join("; "));
  const future = ok(await db.from("orders").select("order_id").gt("ordered_at", T0).limit(1), "pedido futuro")![0];
  const fut = await getOrderEvidence(db, runId, future.order_id);
  check("pedido posterior ao relógio é tratado como ausente", fut.data === null && fut.missing.length > 0);

  const notSep = ok(await db.from("orders").select("order_id, separated_at").lte("ordered_at", T0).gt("separated_at", T0).limit(1), "não separado")![0];
  if (notSep) {
    const e = await getOrderEvidence(db, runId, notSep.order_id);
    check("separação futura não aparece (usa o relógio do caso)", e.data!.order.state === "aguardando_separacao" && e.data!.order.separatedAt === null, notSep.order_id);
    const prod = await getProductionEvidence(db, runId, notSep.order_id);
    check("produção não separada: máquina e CD ocultos", prod.data!.machine === null && prod.data!.fulfillmentCenter === null);
  } else console.log("SEM DADOS: nenhum pedido com separação posterior ao relógio inicial.");

  const futureEvents = ok(await db.from("tracking_events").select("order_id").gt("event_at", T0).limit(800), "eventos futuros")!;
  const ids = [...new Set(futureEvents.map((r) => r.order_id as string))];
  const visible = ids.length ? ok(await db.from("orders").select("order_id").lte("ordered_at", T0).in("order_id", ids).limit(1), "pedido com eventos futuros")![0] : null;
  if (visible) {
    const t = await getTrackingEvidence(db, runId, visible.order_id);
    check("eventos de rastreio posteriores ao relógio não aparecem", t.data!.events.every((x) => Date.parse(x.event_at) <= Date.parse(t.asOf)), visible.order_id);
  } else console.log("SEM DADOS: nenhum pedido anterior ao relógio com eventos posteriores.");

  const delayed = ok(await db.from("carrier_tickets").select("order_id, ticket_id").lte("opened_at", T0).gt("responded_at", T0).limit(1), "chamado respondido depois")![0];
  if (delayed) {
    const t = await getTrackingEvidence(db, runId, delayed.order_id);
    const tk = t.data?.tickets.find((x) => x.ticket_id === delayed.ticket_id);
    check("resposta de chamado posterior ao relógio não aparece", !!tk && tk.responded_at === null && tk.carrier_response === null, delayed.ticket_id);
  } else console.log("SEM DADOS: nenhum chamado aberto antes e respondido depois do relógio inicial.");

  const closedOrders = ok(await db.from("orders").select("order_id").in("delivery_status", ["cancelado", "devolvido"]).lte("ordered_at", T0).limit(1), "cancelado")![0];
  if (closedOrders) {
    const e = await getOrderEvidence(db, runId, closedOrders.order_id);
    check("pedido cancelado/devolvido declara a data ausente", e.missing.some((m) => /cancelado|devolvido/.test(m)), closedOrders.order_id);
  }

  const sheet = await getProductSheet(db, runId, kok.sku);
  check("ficha do catálogo por SKU", sheet.data?.sku === kok.sku && sheet.sources[0].table === "products");
  check("SKU inexistente na ficha: ausência declarada", (await getProductSheet(db, runId, "ZZZ-0000")).data === null);

  // ---- Conta restrita (Kokeshi) pela API direta ----
  const pass = process.env.TEST_PASSWORD_RESTRITO ?? process.env.TEST_PASSWORD;
  if (publishable && pass) {
    const restrito = createClient(url!, publishable, opts);
    const { error } = await restrito.auth.signInWithPassword({ email: "restrito@gobia.test", password: pass });
    if (error) throw new Error(`login restrito: ${error.message}`);
    const own = await searchKnowledge(restrito, runId, { query: "composição modo de uso", brand: "kokeshi", limit: 20 });
    check("restrito: encontra fichas da própria marca", own.data!.hits.some((h) => h.kind === "product" && h.brandId === "kokeshi"));
    const cross = await searchKnowledge(restrito, runId, { query: "composição modo de uso capa", brand: "gocase", limit: 20 });
    check("restrito: marca de outro escopo não retorna fichas", cross.data!.hits.every((h) => h.kind !== "product"), `${cross.data!.hits.length} resultado(s)`);
    const crossSku = await searchKnowledge(restrito, runId, { sku: goc.sku });
    check("restrito: SKU de outra marca não retorna ficha", crossSku.data!.hits.length === 0);
    const pol = await searchKnowledge(restrito, runId, { query: "atraso entrega" });
    check("restrito: regras do grupo continuam recuperáveis", pol.data!.hits.some((h) => h.id === "policy:categorias/atraso_entrega"));
    const gocOrder = await getOrderEvidence(restrito, runId, "GCH558661");
    check("restrito: pedido de outra marca é indistinguível de inexistente", gocOrder.data === null && gocOrder.missing.length > 0);
    const sheetCross = await getProductSheet(restrito, runId, goc.sku);
    check("restrito: ficha de outra marca indisponível", sheetCross.data === null);
  } else {
    console.log("SEM CREDENCIAL: defina TEST_PASSWORD para provar o escopo com a conta restrita (Kokeshi).");
  }

  if (publishable) {
    const anon = createClient(url!, publishable, opts);
    const rpc = await anon.rpc("search_knowledge", { p_run: runId, p_query: "atraso" });
    check("anônimo não executa search_knowledge", !!rpc.error);
    const rows = await anon.from("knowledge_documents").select("id").limit(1);
    check("anônimo não lê knowledge_documents", !!rows.error || (rows.data ?? []).length === 0);
    const rebuild = await anon.rpc("rebuild_knowledge");
    check("anônimo não executa rebuild_knowledge", !!rebuild.error);
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    failures++;
  })
  .finally(async () => {
    if (runId) await db.from("scenario_runs").delete().eq("id", runId);
    console.log(failures ? `\n${failures} falha(s).` : "\nTudo certo.");
    process.exit(failures ? 1 : 0);
  });
