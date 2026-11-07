// GOB-08 · Verifica propostas, execução idempotente simulada, outbox e auditoria contra o banco de DESENVOLVIMENTO.
// Pré-requisitos: migration 20261107000006 aplicada e importação (GOB-03/05) executada. Não usa IA nem rede além do Supabase.
// Uso: node --env-file=.env scripts/verify-execution.ts
// Cria o cenário temporário "verify-execution" e o remove ao final.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readCsv } from "./lib/csv.ts";
import { ingestContact } from "../src/server/intake.ts";
import { decide, paramsFromPolicy, type Action, type Category, type VerifiedFacts } from "../src/server/policy/decision.ts";
import type { InvestigationOutcome, OutcomeStatus } from "../src/server/ai/investigate.ts";
import { composeNotification, createSimulatedAdapter, externalRef, type ExecutionRequest, type FaultHook } from "../src/server/execution/adapters.ts";
import { executeProposal, proposalKey, proposalStatusFor, recordInvestigation } from "../src/server/execution/execute.ts";
import { getTrackingEvidence, scenarioClock } from "../src/server/queries.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !secret) {
  console.error("Defina NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SECRET_KEY.");
  process.exit(2);
}
const db: SupabaseClient = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "OK  " : "FALHA"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const ok = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

const params = paramsFromPolicy(readCsv("BD/politicas.csv").map((r) => ({ secao: r.secao, regra: r.regra, valor: r.valor })));
const actor = { id: "gobia", role: "atendente" } as const;
let runId = "";

// ---------------------------------------------------------------------------
// Fixtures: resultados de investigação com decisão REAL do GOB-06
// ---------------------------------------------------------------------------
const facts = (orderId: string, over: Partial<VerifiedFacts> = {}): VerifiedFacts => ({
  orderId, orderValueCents: 8000, separatedOn: "2026-10-22", deliveredOn: null, promisedOn: "2026-10-21",
  lastEventOn: "2026-10-28", lastEventStatus: "em_transito", lostConfirmed: false, identityConflicts: [], duplicate: null,
  suspicionPending: false, customerPreference: null, hasPhoto: false, ...over,
});

function outcome(orderId: string, action: Action, category: Category, status: OutcomeStatus, f: Partial<VerifiedFacts> = {}): InvestigationOutcome {
  const decision = decide({
    asOf: "2026-11-02", category, action, requestedCents: null, facts: facts(orderId, f), actor, approval: null, params,
  });
  return {
    status, category, decision, reply: "texto do modelo (não usado)", handoff: decision.handoff, humanActions: [], warnings: [],
    adapter: "simulado:teste-local", steps: 2, evidenceRefs: [`orders:${orderId}`, `tracking_events:${orderId}`],
    origin: { hypothesis: "transporte", status: "hipotese", evidenceRefs: [`orders:${orderId}`], summary: "rastreio parado" },
    proposal: { action, category } as unknown as InvestigationOutcome["proposal"],
  };
}
const CHAMADO = (o: string) => outcome(o, "abrir_chamado_transportadora", "atraso_entrega", "proposta_validada");
const REEMBOLSO = (o: string, valor = 8000) =>
  outcome(o, "reembolsar", "atraso_entrega", "proposta_validada", { orderValueCents: valor, promisedOn: "2026-10-15", customerPreference: "reembolso" });

// ---------------------------------------------------------------------------
// Consultas de apoio
// ---------------------------------------------------------------------------
const count = async (table: string, filter: Record<string, string>) => {
  let q = db.from(table).select("*", { count: "exact", head: true });
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  const { count: n, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
};
const audit = async (caseId: string) =>
  (ok(await db.from("audit_events").select("event_type, actor_type, simulated, scenario_at, data").eq("case_id", caseId).order("id"), "auditoria") ?? []) as
    { event_type: string; actor_type: string; simulated: boolean; scenario_at: string | null; data: Record<string, unknown> }[];
const types = (rows: { event_type: string }[]) => rows.map((r) => r.event_type);
const outbox = async (caseId: string) =>
  (ok(await db.from("outbox_events").select("kind, status, payload").eq("case_id", caseId), "outbox") ?? []) as
    { kind: string; status: string; payload: { text?: string; error?: string } }[];
const caseStatus = async (caseId: string) => (ok(await db.from("cases").select("status").eq("id", caseId).single(), "caso")!).status as string;
const proposalRow = async (id: string) => ok(await db.from("action_proposals").select("*").eq("id", id).single(), "proposta")!;
const ledger = (key: string) => count("simulated_operations", { scenario_run_id: runId, idempotency_key: key });

let orderPool: { order_id: string; customer_id: string }[] = [];
let n = 0;
async function newCase(): Promise<{ caseId: string; orderId: string }> {
  const o = orderPool[n++];
  if (!o) throw new Error("pedidos de teste insuficientes");
  const clock = await scenarioClock(db, runId);
  const r = await ingestContact(db, runId, {
    channel: "email", externalEventId: `exec-${n}`, customerId: o.customer_id, orderId: o.order_id,
    subject: "Pedido atrasado", text: `Meu pedido ${o.order_id} atrasou.`, receivedAt: new Date(clock).toISOString(),
  });
  return { caseId: r.case_id, orderId: o.order_id };
}

// ---------------------------------------------------------------------------
async function main() {
  // ---- Regras puras ----
  check("chave da proposta é estável e depende do valor", proposalKey("c", "GCH1", "reembolsar", 8000) === proposalKey("c", "GCH1", "reembolsar", 8000)
    && proposalKey("c", "GCH1", "reembolsar", 8000) !== proposalKey("c", "GCH1", "reembolsar", 8001));
  check("mapeamento: validada → pronta; acima da alçada → aguardando_aprovacao; bloqueada → bloqueada",
    proposalStatusFor(CHAMADO("GCH1")) === "pronta"
    && proposalStatusFor({ ...REEMBOLSO("GCH1", 15000), status: "aguardando_aprovacao" }) === "aguardando_aprovacao"
    && proposalStatusFor({ ...CHAMADO("GCH1"), status: "bloqueada" }) === "bloqueada");
  check("sem ação executável não vira proposta (informar status, orientação, esclarecimento)",
    proposalStatusFor({ ...CHAMADO("GCH1"), status: "orientacao" }) === null
    && proposalStatusFor({ ...CHAMADO("GCH1"), status: "esclarecimento", decision: null }) === null
    && proposalStatusFor({ ...CHAMADO("GCH1"), proposal: { action: "informar_status" } as never }) === null);
  const succ = { externalRef: "SIM-RMB-X", result: {}, caseStatus: "aguardando_terceiro" as const };
  const msgRmb = composeNotification("reembolsar", succ, 8000);
  check("mensagem de reembolso: solicitação, valor não creditado", /solicita/i.test(msgRmb) && /não foi creditado/.test(msgRmb) && !/(?<!não )foi (reembolsad|creditad)|já (reembols|credit)/i.test(msgRmb), msgRmb);
  check("mensagem de reenvio: solicitação, sem prometer envio feito", /solicita/i.test(composeNotification("reenviar_produto", succ, null)) && !/foi enviado|já enviei/i.test(composeNotification("reenviar_produto", succ, null)));
  check("referência externa é determinística por chave", externalRef("abrir_chamado_transportadora", "k") === externalRef("abrir_chamado_transportadora", "k") && externalRef("reembolsar", "k").startsWith("SIM-RMB-"));

  // ---- Banco ----
  const probe = await db.from("action_proposals").select("id").limit(1);
  const ticketCol = await db.from("carrier_tickets").select("scenario_run_id").limit(1);
  if (probe.error || ticketCol.error) throw new Error(`tabelas da GOB-08 ausentes: aplique supabase/migrations/20261107000006_execution_and_audit.sql (${(probe.error ?? ticketCol.error)?.message})`);

  await db.from("scenario_runs").delete().eq("name", "verify-execution");
  runId = ok(await db.from("scenario_runs").insert({ name: "verify-execution", mode: "preview" }).select("id"), "criar cenário")![0].id;
  const importedTickets = await count("carrier_tickets", {}) - (await count("carrier_tickets", { scenario_run_id: runId }));
  orderPool = ok(await db.rpc("orders_as_of", { p_run: runId }).select("order_id, customer_id").like("order_id", "GCH%").not("customer_id", "is", null).limit(14), "pedidos") as typeof orderPool;
  if (orderPool.length < 12) throw new Error("poucos pedidos Gocase no relógio do cenário: rode a importação");

  const faults = new Map<string, FaultHook>();
  const calls = new Map<string, number>();
  const adapter = createSimulatedAdapter(db, (req: ExecutionRequest) => {
    calls.set(req.proposalId, (calls.get(req.proposalId) ?? 0) + 1);
    return faults.get(req.proposalId)?.(req);
  });
  const opts = { backoffMs: 1, sleep: async () => {} };

  // ---- 1. Chamado simulado: proposta, execução, caso e trilha ----
  const c1 = await newCase();
  const rec1 = await recordInvestigation(db, runId, c1.caseId, c1.orderId, CHAMADO(c1.orderId));
  check("proposta registrada como pronta, com política e justificativa", rec1.status === "pronta" && !!rec1.proposalId);
  const prop1 = await proposalRow(rec1.proposalId!);
  check("proposta guarda política, evidências, justificativa e autor", !!prop1.policy_version && (prop1.evidence as string[]).length === 2
    && (prop1.justification as string[]).length > 0 && String(prop1.proposed_by).startsWith("gobia:simulado") && prop1.simulated === true);
  const again = await recordInvestigation(db, runId, c1.caseId, c1.orderId, CHAMADO(c1.orderId));
  check("registrar a mesma proposta de novo reutiliza o registro", again.duplicate && again.proposalId === rec1.proposalId
    && (await count("action_proposals", { case_id: c1.caseId })) === 1);

  const r1 = await executeProposal(db, runId, rec1.proposalId!, adapter, opts);
  check("execução concluída na primeira tentativa", r1.state === "concluida" && r1.attempts === 1 && !!r1.externalRef, JSON.stringify(r1));
  const tr = await getTrackingEvidence(db, runId, c1.orderId);
  const ticket = tr.data?.tickets.find((t) => t.ticket_id === r1.externalRef);
  check("chamado simulado aparece no caso (consulta de rastreio do pedido)", !!ticket && ticket.status === "aberto");
  const sim = ok(await db.from("carrier_tickets").select("simulated, scenario_run_id, opened_by").eq("ticket_id", r1.externalRef!).single(), "chamado")!;
  check("chamado é identificado como simulado e isolado no cenário", sim.simulated === true && sim.scenario_run_id === runId && sim.opened_by === "gobia");
  const a1 = await audit(c1.caseId);
  const t1 = types(a1);
  check("trilha tem investigação, proposta, início e conclusão, nessa ordem",
    ["investigacao_concluida", "proposta_registrada", "execucao_iniciada", "execucao_concluida"].every((t) => t1.includes(t))
    && t1.indexOf("proposta_registrada") < t1.indexOf("execucao_iniciada") && t1.indexOf("execucao_iniciada") < t1.indexOf("execucao_concluida"), t1.join(" > "));
  check("eventos de auditoria carregam ator, simulado e relógio do cenário", a1.every((e) => e.simulated && !!e.actor_type && !!e.scenario_at));
  const ob1 = await outbox(c1.caseId);
  check("notificação ao cliente nasce no outbox só com o resultado, citando o protocolo",
    ob1.length === 1 && ob1[0].kind === "notificacao_cliente" && ob1[0].status === "pendente" && ob1[0].payload.text!.includes(r1.externalRef!));
  check("caso segue aberto com pendência externa (não resolvido)", (await caseStatus(c1.caseId)) === "aguardando_terceiro");
  check("proposta concluída", (await proposalRow(rec1.proposalId!)).status === "concluida");

  // ---- 2. Reprocessar a mesma proposta não duplica o efeito ----
  const r1b = await executeProposal(db, runId, rec1.proposalId!, adapter, opts);
  const key1 = `exec:${prop1.idempotency_key}`;
  check("reprocessar reutiliza o resultado conhecido", r1b.state === "reuso" && r1b.externalRef === r1.externalRef);
  check("sem novo chamado, mensagem, operação externa ou evento de conclusão",
    (await count("carrier_tickets", { scenario_run_id: runId, order_id: c1.orderId })) === 1
    && (await outbox(c1.caseId)).length === 1 && (await ledger(key1)) === 1
    && types(await audit(c1.caseId)).filter((t) => t === "execucao_concluida").length === 1 && calls.get(rec1.proposalId!) === 1);

  // ---- 3. Concorrência: cinco processadores, um efeito ----
  const c2 = await newCase();
  const rec2 = await recordInvestigation(db, runId, c2.caseId, c2.orderId, CHAMADO(c2.orderId));
  const burst = await Promise.all(Array.from({ length: 5 }, () => executeProposal(db, runId, rec2.proposalId!, adapter, opts)));
  const done = burst.filter((r) => r.state === "concluida").length;
  check("concorrência: exatamente uma execução conclui; as demais reutilizam ou aguardam",
    done === 1 && burst.every((r) => ["concluida", "reuso", "em_andamento"].includes(r.state)), burst.map((r) => r.state).join(","));
  check("concorrência: um chamado, uma mensagem, uma operação externa",
    (await count("carrier_tickets", { scenario_run_id: runId, order_id: c2.orderId })) === 1 && (await outbox(c2.caseId)).length === 1
    && (await count("action_executions", { proposal_id: rec2.proposalId! })) === 1 && calls.get(rec2.proposalId!) === 1);

  // ---- 4. Reembolso: solicitação, nunca crédito confirmado ----
  const c3 = await newCase();
  const rec3 = await recordInvestigation(db, runId, c3.caseId, c3.orderId, REEMBOLSO(c3.orderId));
  const r3 = await executeProposal(db, runId, rec3.proposalId!, adapter, opts);
  const x3 = ok(await db.from("action_executions").select("result").eq("proposal_id", rec3.proposalId!).single(), "execução")!;
  const res3 = x3.result as { kind: string; status: string; creditoConfirmado: boolean; valorCentavos: number };
  check("reembolso vira solicitação registrada, com crédito NÃO confirmado", r3.state === "concluida" && res3.kind === "solicitacao_reembolso"
    && res3.status === "solicitado" && res3.creditoConfirmado === false && res3.valorCentavos === 8000);
  const ob3 = (await outbox(c3.caseId))[0];
  check("mensagem do reembolso não promete crédito", !!ob3 && /não foi creditado/.test(ob3.payload.text!) && !/(?<!não )foi (reembolsad|creditad)|já (reembols|credit)/i.test(ob3.payload.text!));
  check("caso do reembolso não é dado como resolvido", (await caseStatus(c3.caseId)) !== "resolvido");

  // ---- 5. Acima da alçada: sem aprovação não executa ----
  const c4 = await newCase();
  const o4 = { ...REEMBOLSO(c4.orderId, 15000), status: "aguardando_aprovacao" as const };
  const rec4 = await recordInvestigation(db, runId, c4.caseId, c4.orderId, o4);
  check("acima da alçada fica aguardando aprovação", rec4.status === "aguardando_aprovacao");
  const blocked = await executeProposal(db, runId, rec4.proposalId!, adapter, opts).then(() => "executou", (e: Error) => e.message);
  check("proposta aguardando aprovação não executa", /não está pronta/.test(blocked), blocked);
  check("nada foi gravado no externo nem no outbox", (await outbox(c4.caseId)).length === 0 && !calls.has(rec4.proposalId!));

  // ---- 6. Falha definitiva: sem mensagem de sucesso ----
  const c5 = await newCase();
  const rec5 = await recordInvestigation(db, runId, c5.caseId, c5.orderId, CHAMADO(c5.orderId));
  faults.set(rec5.proposalId!, () => ({ kind: "permanente", message: "transportadora recusou a operação" }));
  const r5 = await executeProposal(db, runId, rec5.proposalId!, adapter, opts);
  const ob5 = await outbox(c5.caseId);
  check("falha definitiva: execução falhou, caso volta para humano", r5.state === "falhou" && (await proposalRow(rec5.proposalId!)).status === "falhou"
    && (await caseStatus(c5.caseId)) === "aguardando_humano");
  check("falha definitiva: nenhuma mensagem de sucesso, só intervenção humana com o erro",
    ob5.length === 1 && ob5[0].kind === "intervencao_humana" && /recusou/.test(ob5[0].payload.error ?? "") && !ob5.some((o) => o.kind === "notificacao_cliente"));
  check("falha definitiva: sem chamado nem operação externa; auditada",
    (await count("carrier_tickets", { scenario_run_id: runId, order_id: c5.orderId })) === 0 && (await ledger(`exec:${(await proposalRow(rec5.proposalId!)).idempotency_key}`)) === 0
    && types(await audit(c5.caseId)).includes("execucao_falhou"));
  const r5b = await executeProposal(db, runId, rec5.proposalId!, adapter, opts);
  check("reprocessar falha definitiva não tenta de novo", r5b.state === "falhou" && calls.get(rec5.proposalId!) === 1);

  // ---- 7. Falha transitória: repete com limite ----
  const c6 = await newCase();
  const rec6 = await recordInvestigation(db, runId, c6.caseId, c6.orderId, CHAMADO(c6.orderId));
  faults.set(rec6.proposalId!, (req) => (req.attempt < 3 ? { kind: "transitoria", message: "timeout simulado" } : undefined));
  const r6 = await executeProposal(db, runId, rec6.proposalId!, adapter, opts);
  check("transitória: conclui na 3ª tentativa, com um único efeito", r6.state === "concluida" && r6.attempts === 3
    && (await count("carrier_tickets", { scenario_run_id: runId, order_id: c6.orderId })) === 1 && (await outbox(c6.caseId)).length === 1
    && types(await audit(c6.caseId)).filter((t) => t === "execucao_falha_transitoria").length === 2);

  const c7 = await newCase();
  const rec7 = await recordInvestigation(db, runId, c7.caseId, c7.orderId, CHAMADO(c7.orderId));
  faults.set(rec7.proposalId!, () => ({ kind: "transitoria", message: "indisponível" }));
  const r7 = await executeProposal(db, runId, rec7.proposalId!, adapter, opts);
  const ob7 = await outbox(c7.caseId);
  check("transitória esgotada: 3 tentativas, falha, intervenção humana e nenhuma mensagem de sucesso",
    r7.state === "falhou" && r7.attempts === 3 && calls.get(rec7.proposalId!) === 3 && (await caseStatus(c7.caseId)) === "aguardando_humano"
    && ob7.length === 1 && ob7[0].kind === "intervencao_humana");

  // ---- 8. Resultado incerto: reconciliar antes de repetir ----
  const c8 = await newCase();
  const rec8 = await recordInvestigation(db, runId, c8.caseId, c8.orderId, REEMBOLSO(c8.orderId));
  faults.set(rec8.proposalId!, (req) => (req.attempt === 1 ? { kind: "incerta", message: "resposta perdida", applyEffect: true } : undefined));
  const r8 = await executeProposal(db, runId, rec8.proposalId!, adapter, opts);
  const key8 = `exec:${(await proposalRow(rec8.proposalId!)).idempotency_key}`;
  check("incerto com efeito aplicado: reconcilia e conclui SEM repetir a ação", r8.state === "concluida" && calls.get(rec8.proposalId!) === 1
    && (await ledger(key8)) === 1 && r8.externalRef === externalRef("reembolsar", key8));
  check("incerto: trilha registra o resultado incerto antes da conclusão", types(await audit(c8.caseId)).indexOf("execucao_incerta") < types(await audit(c8.caseId)).indexOf("execucao_concluida")
    && types(await audit(c8.caseId)).includes("execucao_incerta") && (await outbox(c8.caseId)).length === 1);

  const c9 = await newCase();
  const rec9 = await recordInvestigation(db, runId, c9.caseId, c9.orderId, CHAMADO(c9.orderId));
  faults.set(rec9.proposalId!, (req) => (req.attempt === 1 ? { kind: "incerta", message: "timeout", applyEffect: false } : undefined));
  const r9 = await executeProposal(db, runId, rec9.proposalId!, adapter, opts);
  check("incerto sem efeito externo: reconciliação não encontra e a ação é repetida uma vez", r9.state === "concluida" && r9.attempts === 2
    && (await count("carrier_tickets", { scenario_run_id: runId, order_id: c9.orderId })) === 1);

  // ---- 9. Reserva expirada: retomada ----
  const c10 = await newCase();
  const rec10 = await recordInvestigation(db, runId, c10.caseId, c10.orderId, CHAMADO(c10.orderId));
  ok(await db.rpc("begin_execution", { p_proposal: rec10.proposalId!, p_adapter: adapter.id }), "reservar");
  const busy = await executeProposal(db, runId, rec10.proposalId!, adapter, opts);
  check("reserva ativa de outro processador: aguarda", busy.state === "em_andamento" && !calls.has(rec10.proposalId!));
  ok(await db.from("action_executions").update({ updated_at: new Date(Date.now() - 3600_000).toISOString() }).eq("proposal_id", rec10.proposalId!), "envelhecer reserva");
  const resumed = await executeProposal(db, runId, rec10.proposalId!, adapter, opts);
  check("reserva expirada: reconcilia, não acha o efeito e retoma a execução", resumed.state === "concluida"
    && types(await audit(c10.caseId)).includes("execucao_reserva_expirada") && (await outbox(c10.caseId)).length === 1);

  // ---- 10. Auditoria só acrescenta; leitura anônima bloqueada ----
  const upd = await db.from("audit_events").update({ event_type: "adulterado" }).eq("case_id", c1.caseId);
  check("auditoria não pode ser reescrita pelo fluxo comum", !!upd.error && /somente de acréscimo/.test(upd.error.message), upd.error?.message ?? "sem erro");
  if (publishable) {
    const anon = createClient(url!, publishable, { auth: { persistSession: false } });
    for (const t of ["action_proposals", "action_executions", "outbox_events", "audit_events", "simulated_operations"]) {
      const r = await anon.from(t).select("*").limit(1);
      check(`anônimo não lê ${t}`, !!r.error || (r.data ?? []).length === 0);
    }
  }

  // ---- 11. Reset limpa o cenário sem tocar nos dados importados ----
  ok(await db.rpc("reset_scenario_run", { p_run: runId }), "reset");
  const left = await Promise.all(["action_proposals", "action_executions", "outbox_events", "audit_events", "simulated_operations", "carrier_tickets"]
    .map((t) => count(t, { scenario_run_id: runId })));
  check("reset remove propostas, execuções, outbox, auditoria, operações e chamados simulados", left.every((x) => x === 0), left.join("/"));
  check("reset preserva os chamados importados", (await count("carrier_tickets", {})) === importedTickets, `${importedTickets}`);
}

main()
  .catch((e) => { console.error(`ERRO: ${(e as Error).message}`); failures++; })
  .finally(async () => {
    if (runId) await db.from("scenario_runs").delete().eq("id", runId);
    console.log(failures ? `\n${failures} falha(s).` : "\nTudo certo.");
    process.exit(failures ? 1 : 0);
  });

