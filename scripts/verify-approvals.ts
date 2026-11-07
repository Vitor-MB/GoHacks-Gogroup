// GOB-09 · Verifica a operação humana da fila contra o banco de DESENVOLVIMENTO: encaminhamento, atribuição, aprovação,
// rejeição, suspensão, separação solicitante x aprovador, mudança de valor, revalidação e aprovação vencida.
// Pré-requisito: migration 20261107000007 aplicada (e as anteriores), importação executada. Sem IA e sem rede além do Supabase.
// Uso: node --env-file=.env scripts/verify-approvals.ts
// Cria o cenário temporário "verify-approvals" e funcionários temporários (@verify.test); remove tudo ao final.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readCsv } from "./lib/csv.ts";
import { ingestContact } from "../src/server/intake.ts";
import { decide, paramsFromPolicy, type VerifiedFacts } from "../src/server/policy/decision.ts";
import type { InvestigationOutcome, OutcomeStatus } from "../src/server/ai/investigate.ts";
import { createSimulatedAdapter } from "../src/server/execution/adapters.ts";
import { recordInvestigation } from "../src/server/execution/execute.ts";
import { scenarioClock } from "../src/server/queries.ts";
import { byPriority, filterQueue, getCaseDetail, listQueue } from "../src/server/cases.ts";
import { priorityOf } from "../src/server/queue/priority.ts";
import { adjustProposalAmount, assignCase, decideProposal, escalateExpired, HumanDecisionError, type Deps, type HumanErrorCode } from "../src/server/queue/approvals.ts";

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
const gobia = { id: "gobia", role: "atendente" } as const;
let runId = "";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const facts = (orderId: string, over: Partial<VerifiedFacts> = {}): VerifiedFacts => ({
  orderId, orderValueCents: 20000, separatedOn: "2026-10-22", deliveredOn: null, promisedOn: "2026-10-15",
  lastEventOn: "2026-10-28", lastEventStatus: "em_transito", lostConfirmed: false, identityConflicts: [], duplicate: null,
  suspicionPending: false, customerPreference: "reembolso", hasPhoto: false, ...over,
});

function reembolso(orderId: string, valor: number, status: OutcomeStatus = "aguardando_aprovacao"): InvestigationOutcome {
  const decision = decide({
    asOf: "2026-11-02", category: "atraso_entrega", action: "reembolsar", requestedCents: null,
    facts: facts(orderId, { orderValueCents: valor }), actor: gobia, approval: null, params,
  });
  return {
    status, category: "atraso_entrega", decision, reply: "texto do modelo (não usado)", handoff: null, humanActions: [], warnings: [],
    adapter: "simulado:teste-local", steps: 2, evidenceRefs: [`orders:${orderId}`, `tracking_events:${orderId}`],
    origin: { hypothesis: "transporte", status: "hipotese", evidenceRefs: [`orders:${orderId}`], summary: "atraso acima do limite" },
    proposal: { action: "reembolsar", category: "atraso_entrega" } as unknown as InvestigationOutcome["proposal"],
  };
}

const adapter = createSimulatedAdapter(db);
const deps = (over: Partial<Deps> = {}): Deps => ({
  params, loadFacts: async (o) => facts(o), adapter, exec: { backoffMs: 1, sleep: async () => {} }, ...over,
});

async function expectError(name: string, work: Promise<unknown>, code: HumanErrorCode) {
  try {
    await work;
    check(name, false, "não houve erro");
  } catch (e) {
    check(name, e instanceof HumanDecisionError && e.code === code, e instanceof HumanDecisionError ? `${e.code}: ${e.message}` : String(e));
  }
}

const count = async (table: string, filter: Record<string, string>) => {
  let q = db.from(table).select("*", { count: "exact", head: true });
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  const { count: n, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
};
const audit = async (caseId: string) =>
  ((ok(await db.from("audit_events").select("event_type, actor_type, actor_id, data").eq("case_id", caseId).order("id"), "auditoria") ?? []) as
    { event_type: string; actor_type: string; actor_id: string | null; data: Record<string, unknown> }[]);
const types = (rows: { event_type: string }[]) => rows.map((r) => r.event_type);
const proposal = async (id: string) => ok(await db.from("action_proposals").select("*").eq("id", id).single(), "proposta")!;
const caseRow = async (id: string) => ok(await db.from("cases").select("status, assigned_to, handoff_reason, decision_requested").eq("id", id).single(), "caso")!;
const notifs = async (caseId: string) =>
  ((ok(await db.from("internal_notifications").select("kind, target_role, target_staff_id, title, body").eq("case_id", caseId), "notificações") ?? []) as
    { kind: string; target_role: string | null; target_staff_id: string | null; title: string; body: string }[]);
const outbox = async (caseId: string) =>
  ((ok(await db.from("outbox_events").select("kind, payload").eq("case_id", caseId), "outbox") ?? []) as { kind: string; payload: { text?: string } }[]);

let pool: { order_id: string; customer_id: string }[] = [];
let n = 0;
async function newCase(preferred?: { order_id: string; customer_id: string }): Promise<{ caseId: string; orderId: string }> {
  const o = preferred ?? pool[n++];
  if (!o) throw new Error("pedidos de teste insuficientes");
  const clock = await scenarioClock(db, runId);
  const r = await ingestContact(db, runId, {
    channel: "email", externalEventId: `appr-${n}-${o.order_id}`, customerId: o.customer_id, orderId: o.order_id,
    subject: "Pedido atrasado", text: `Meu pedido ${o.order_id} atrasou.`, receivedAt: new Date(clock).toISOString(),
  });
  return { caseId: r.case_id, orderId: o.order_id };
}

/** Caso com proposta de reembolso de R$ 150,00 aguardando o supervisor, como a GoBIA a deixa. */
async function pendingCase(opts: { requestedBy?: string; preferred?: { order_id: string; customer_id: string } } = {}) {
  const c = await newCase(opts.preferred);
  const rec = await recordInvestigation(db, runId, c.caseId, c.orderId, reembolso(c.orderId, 15000), {
    facts: facts(c.orderId), ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}), approvalDueHours: 24,
  });
  if (!rec.proposalId) throw new Error("proposta não registrada");
  return { ...c, proposalId: rec.proposalId };
}

// Funcionários temporários
const staff: Record<string, string> = {};
async function makeStaff(key: string, role: "atendente" | "analista" | "supervisor", scope: { scope: "group" } | { scope: "brand"; brand_id: string }) {
  const email = `gob09-${key}@verify.test`;
  const row = ok(await db.from("staff").insert({ full_name: `Teste ${key}`, email, role }).select("id"), `staff ${key}`)![0];
  ok(await db.from("staff_scopes").insert({ staff_id: row.id, ...scope }), `escopo ${key}`);
  staff[key] = row.id as string;
}
const cleanupStaff = async () => { await db.from("staff").delete().like("email", "gob09-%@verify.test"); };

// ---------------------------------------------------------------------------
async function main() {
  // ---- Regras puras: prioridade explicável ----
  const base = { topic: "rastreio_atraso", status: "novo", ageHours: 1, clarificationPending: false, assigned: false, handoffReason: null, proposal: null };
  const calm = priorityOf(base);
  const adverse = priorityOf({ ...base, topic: "reacao_adversa" });
  const overdue = priorityOf({ ...base, status: "aguardando_humano", proposal: { status: "aguardando_aprovacao", amountCents: 15000, escalationLevel: 1, overdue: true } });
  const inTime = priorityOf({ ...base, status: "aguardando_humano", proposal: { status: "aguardando_aprovacao", amountCents: 15000, escalationLevel: 0, overdue: false } });
  check("prioridade: reação adversa é alta e explica o motivo", adverse.level === "alta" && adverse.reasons.some((r) => /cosmetovigil/i.test(r)));
  check("prioridade: aprovação vencida pesa mais que a em prazo; cada ponto traz o motivo", overdue.score > inTime.score && overdue.reasons.every((r) => /\(\+\d+\)|Sem pend/.test(r)));
  check("prioridade: sem pendência é baixa e diz que não há pendência", calm.level === "baixa" && calm.reasons.length === 1);

  // ---- Banco ----
  const probe = await db.from("proposal_approvals").select("id").limit(1);
  if (probe.error) throw new Error(`tabelas da GOB-09 ausentes: aplique supabase/migrations/20261107000007_human_queue_and_approvals.sql (${probe.error.message})`);

  await db.from("scenario_runs").delete().eq("name", "verify-approvals");
  await cleanupStaff();
  runId = ok(await db.from("scenario_runs").insert({ name: "verify-approvals", mode: "preview" }).select("id"), "criar cenário")![0].id;
  pool = ok(await db.rpc("orders_as_of", { p_run: runId }).select("order_id, customer_id").like("order_id", "GCH%").not("customer_id", "is", null).limit(14), "pedidos") as typeof pool;
  if (pool.length < 8) throw new Error("poucos pedidos Gocase no relógio do cenário: rode a importação");

  // AT116703: a conversa de referência para aprovação humana (usa o pedido e o cliente reais dela, quando elegíveis ao relógio).
  const conv = ok(await db.from("conversations").select("order_id, customer_id").eq("conversation_id", "AT116703").maybeSingle(), "AT116703");
  const at703 = conv?.order_id && conv.customer_id
    ? (ok(await db.rpc("orders_as_of", { p_run: runId }).select("order_id, customer_id").eq("order_id", conv.order_id), "pedido AT116703") as typeof pool)[0] : undefined;

  const A = await pendingCase(at703 ? { preferred: at703 } : {});
  const brandA = (ok(await db.from("cases").select("brand_id").eq("id", A.caseId).single(), "marca")!).brand_id as string | null;
  const otherBrand = (ok(await db.from("brands").select("id"), "marcas") as { id: string }[]).find((b) => b.id !== brandA)!.id;
  await makeStaff("sup1", "supervisor", { scope: "group" });
  await makeStaff("sup2", "supervisor", { scope: "group" });
  await makeStaff("op", "atendente", { scope: "group" });
  await makeStaff("sup_fora", "supervisor", { scope: "brand", brand_id: otherBrand });
  check("AT116703: caso criado a partir da conversa de referência", !!at703, at703 ? at703.order_id : "usando pedido de apoio (AT116703 sem pedido elegível)");

  // ---- 1. Encaminhamento: proposta acima da alçada aguarda o supervisor, com aviso interno persistido ----
  const pA = await proposal(A.proposalId);
  const cA = await caseRow(A.caseId);
  check("proposta elegível acima da alçada aguarda supervisor", pA.status === "aguardando_aprovacao" && pA.amount_cents === 15000 && (pA.decision as { approvalRequired: boolean }).approvalRequired === true);
  check("caso vai para atendimento humano com motivo e decisão solicitada",
    cA.status === "aguardando_humano" && cA.handoff_reason === "aprovacao_supervisor" && /R\$ 150,00/.test(String(cA.decision_requested)), String(cA.decision_requested));
  const nA = await notifs(A.caseId);
  check("aviso interno persistido, dirigido ao supervisor", nA.length === 1 && nA[0].kind === "aprovacao_solicitada" && nA[0].target_role === "supervisor");
  check("prazo de aprovação definido (relógio do cenário)", !!pA.approval_due_at);
  await recordInvestigation(db, runId, A.caseId, A.orderId, reembolso(A.orderId, 15000), { facts: facts(A.orderId), approvalDueHours: 24 });
  check("repetir o encaminhamento não duplica aviso nem proposta", (await notifs(A.caseId)).length === 1 && (await count("action_proposals", { case_id: A.caseId })) === 1);

  // ---- 2. Quem não pode aprovar ----
  await expectError("operador (atendente) não aprova acima da alçada", decideProposal(db, runId, { proposalId: A.proposalId, actorId: staff.op, decision: "aprovada", version: 1 }, deps()), "papel_insuficiente");
  await expectError("supervisor fora do escopo não aprova", decideProposal(db, runId, { proposalId: A.proposalId, actorId: staff.sup_fora, decision: "aprovada", version: 1 }, deps()), "fora_do_escopo");
  await expectError("funcionário inexistente não decide", decideProposal(db, runId, { proposalId: A.proposalId, actorId: "00000000-0000-0000-0000-000000000000", decision: "aprovada", version: 1 }, deps()), "nao_autorizado");
  check("nenhuma aprovação foi gravada pelas tentativas negadas", (await count("proposal_approvals", { proposal_id: A.proposalId })) === 0 && (await proposal(A.proposalId)).status === "aguardando_aprovacao");

  // ---- 3. Autor da própria proposta e versão desatualizada ----
  const adj = await adjustProposalAmount(db, runId, { proposalId: A.proposalId, actorId: staff.sup1, newAmountCents: 16000, note: "ajuste do supervisor 1" }, deps());
  check("ajuste de valor cria a versão 2 e continua aguardando aprovação", adj.version === 2 && adj.status === "aguardando_aprovacao" && (await proposal(A.proposalId)).amount_cents === 16000);
  await expectError("o supervisor que ajustou a proposta não a aprova (própria ação)", decideProposal(db, runId, { proposalId: A.proposalId, actorId: staff.sup1, decision: "aprovada", version: 2 }, deps()), "autoaprovacao");
  await expectError("decisão sobre a versão antiga é recusada", decideProposal(db, runId, { proposalId: A.proposalId, actorId: staff.sup2, decision: "aprovada", version: 1 }, deps()), "versao_desatualizada");

  // ---- 4. Decisão válida retoma o caso e executa (simulado) ----
  const okA = await decideProposal(db, runId, { proposalId: A.proposalId, actorId: staff.sup2, decision: "aprovada", version: 2, note: "ok" }, deps());
  check("aprovação válida libera, executa e conclui (simulado)", okA.released && okA.execution?.state === "concluida", JSON.stringify(okA));
  const tA = types(await audit(A.caseId));
  const order = ["proposta_registrada", "proposta_ajustada", "aprovacao_registrada", "caso_retomado", "execucao_iniciada", "execucao_concluida"];
  check("auditoria mostra proposta, ajuste, aprovação, retomada e execução, nessa ordem",
    order.every((t) => tA.includes(t)) && order.every((t, i) => i === 0 || tA.indexOf(order[i - 1]) < tA.indexOf(t)), tA.join(" > "));
  const apr = (await audit(A.caseId)).find((e) => e.event_type === "aprovacao_registrada")!;
  check("a aprovação guarda ator, pedido, ação, valor e versão",
    apr.actor_id === staff.sup2 && apr.data.order_id === A.orderId && apr.data.action === "reembolsar" && apr.data.amount_cents === 16000 && apr.data.version === 2);
  const exA = ok(await db.from("action_executions").select("result").eq("proposal_id", A.proposalId).single(), "execução")!.result as { valorCentavos: number; creditoConfirmado: boolean };
  check("executa o valor aprovado e não confirma crédito", exA.valorCentavos === 16000 && exA.creditoConfirmado === false);
  const obA = await outbox(A.caseId);
  check("mensagem ao cliente só após o resultado, sem afirmar crédito", obA.length === 1 && /não foi creditado/.test(obA[0].payload.text ?? ""));
  check("caso retomado segue com pendência externa (não resolvido)", (await caseRow(A.caseId)).status === "aguardando_terceiro");
  const again = await decideProposal(db, runId, { proposalId: A.proposalId, actorId: staff.sup2, decision: "aprovada", version: 2 }, deps()).catch((e) => e);
  check("repetir a aprovação depois de concluída é recusado e nada duplica", again instanceof HumanDecisionError && (await count("action_executions", { proposal_id: A.proposalId })) === 1 && (await outbox(A.caseId)).length === 1);

  // ---- 5. Mudança de valor invalida a aprovação anterior ----
  const B = await pendingCase();
  const approvedB = await decideProposal(db, runId, { proposalId: B.proposalId, actorId: staff.sup1, decision: "aprovada", version: 1 }, deps({ adapter: undefined }));
  check("aprovação válida deixa a proposta pronta (sem executar neste teste)", approvedB.released && (await proposal(B.proposalId)).status === "pronta" && (await count("action_executions", { proposal_id: B.proposalId })) === 0);
  const adjB = await adjustProposalAmount(db, runId, { proposalId: B.proposalId, actorId: staff.op, newAmountCents: 17000 }, deps());
  check("mudança de valor invalida a aprovação anterior e volta a aguardar", adjB.approvals_invalidated === 1 && adjB.status === "aguardando_aprovacao" && adjB.version === 2);
  const aprB = ok(await db.from("proposal_approvals").select("superseded_at, superseded_reason").eq("proposal_id", B.proposalId).eq("decision", "aprovada"), "aprovações")!;
  check("a aprovação antiga fica registrada como invalidada, com o motivo", aprB.length === 1 && !!aprB[0].superseded_at && /valor alterado/.test(String(aprB[0].superseded_reason)));
  check("a auditoria registra a invalidação", types(await audit(B.caseId)).includes("aprovacao_invalidada"));
  const rel = await db.rpc("release_proposal", { p_proposal: B.proposalId, p_revalidation: { executable: true } });
  check("liberar sem aprovação vigente é recusado pelo banco", !!rel.error && /sem_aprovacao_valida/.test(rel.error.message), rel.error?.message);
  await expectError("aprovar a versão antiga depois do ajuste é recusado", decideProposal(db, runId, { proposalId: B.proposalId, actorId: staff.sup2, decision: "aprovada", version: 1 }, deps()), "versao_desatualizada");
  const okB = await decideProposal(db, runId, { proposalId: B.proposalId, actorId: staff.sup2, decision: "aprovada", version: 2 }, deps());
  const exB = ok(await db.from("action_executions").select("result").eq("proposal_id", B.proposalId).single(), "execução B")!.result as { valorCentavos: number };
  check("nova aprovação executa o valor novo", okB.execution?.state === "concluida" && exB.valorCentavos === 17000);

  // ---- 6. Adulteração direta do valor depois de aprovar (defesa no banco) ----
  const D = await pendingCase();
  await db.rpc("decide_proposal", { p_proposal: D.proposalId, p_actor: staff.sup1, p_decision: "aprovada", p_version: 1, p_note: null });
  ok(await db.from("action_proposals").update({ amount_cents: 99900 }).eq("id", D.proposalId), "adulterar valor");
  const relD = await db.rpc("release_proposal", { p_proposal: D.proposalId, p_revalidation: { executable: true } });
  check("aprovação que não corresponde ao valor atual não libera", !!relD.error && /sem_aprovacao_valida/.test(relD.error.message) && (await count("action_executions", { proposal_id: D.proposalId })) === 0, relD.error?.message);

  // ---- 7. Revalidação: dados mudaram depois da aprovação ----
  const E = await pendingCase();
  const blockedE = await decideProposal(db, runId, { proposalId: E.proposalId, actorId: staff.sup1, decision: "aprovada", version: 1 },
    deps({ loadFacts: async (o) => facts(o, { duplicate: { action: "reembolsar", status: "aberto" } }) }));
  check("revalidação com bloqueio impede a execução mesmo com aprovação", !blockedE.released && (await proposal(E.proposalId)).status === "bloqueada" && (await count("action_executions", { proposal_id: E.proposalId })) === 0, (blockedE.blockers ?? []).join("; "));
  check("bloqueio de revalidação devolve o caso a uma pessoa, com aviso e auditoria",
    (await caseRow(E.caseId)).handoff_reason === "revalidacao_bloqueada" && types(await audit(E.caseId)).includes("revalidacao_bloqueou") && (await notifs(E.caseId)).some((x) => x.kind === "revalidacao_bloqueada"));

  // ---- 8. Rejeição atribui continuidade humana ----
  const C = await pendingCase();
  const rej = await decideProposal(db, runId, { proposalId: C.proposalId, actorId: staff.op, decision: "rejeitada", version: 1, note: "cliente já resolveu" }, deps());
  const cC = await caseRow(C.caseId);
  check("rejeição encerra a proposta sem executar", rej.proposalStatus === "rejeitada" && (await proposal(C.proposalId)).status === "rejeitada" && (await count("action_executions", { proposal_id: C.proposalId })) === 0);
  check("rejeição atribui continuidade humana a quem decidiu e avisa", cC.status === "aguardando_humano" && cC.assigned_to === staff.op && (await notifs(C.caseId)).some((x) => x.kind === "continuidade_humana" && x.target_staff_id === staff.op));
  check("rejeição aparece na auditoria", types(await audit(C.caseId)).includes("proposta_rejeitada"));
  await expectError("proposta rejeitada não pode mais ser aprovada", decideProposal(db, runId, { proposalId: C.proposalId, actorId: staff.sup1, decision: "aprovada", version: 1 }, deps()), "estado_invalido");

  // ---- 9. Suspensão ----
  const S = await pendingCase();
  await decideProposal(db, runId, { proposalId: S.proposalId, actorId: staff.sup1, decision: "suspensa", version: 1 }, deps());
  check("suspensão para a proposta sem executar", (await proposal(S.proposalId)).status === "suspensa" && (await count("action_executions", { proposal_id: S.proposalId })) === 0 && types(await audit(S.caseId)).includes("proposta_suspensa"));
  await expectError("suspender duas vezes é recusado", decideProposal(db, runId, { proposalId: S.proposalId, actorId: staff.sup1, decision: "suspensa", version: 1 }, deps()), "estado_invalido");

  // ---- 10. Atribuição ----
  const F = await pendingCase();
  await expectError("atendente não atribui o caso a outra pessoa", assignCase(db, { caseId: F.caseId, actorId: staff.op, assigneeId: staff.sup1 }), "papel_insuficiente");
  const own = await assignCase(db, { caseId: F.caseId, actorId: staff.op, assigneeId: staff.op });
  check("atendente assume o caso para si", own.assigned_to === staff.op && (await caseRow(F.caseId)).assigned_to === staff.op);
  await assignCase(db, { caseId: F.caseId, actorId: staff.sup1, assigneeId: staff.sup2 });
  check("supervisor atribui a outro funcionário, com aviso e auditoria", (await caseRow(F.caseId)).assigned_to === staff.sup2
    && (await notifs(F.caseId)).some((x) => x.kind === "atribuicao" && x.target_staff_id === staff.sup2) && types(await audit(F.caseId)).filter((t) => t === "caso_atribuido").length === 2);
  await expectError("não atribui a quem está fora do escopo do caso", assignCase(db, { caseId: F.caseId, actorId: staff.sup1, assigneeId: staff.sup_fora }), "fora_do_escopo");
  await expectError("quem está fora do escopo não atribui", assignCase(db, { caseId: F.caseId, actorId: staff.sup_fora, assigneeId: staff.sup_fora }), "fora_do_escopo");

  // ---- 11. Aprovação vencida: cobrança e escalonamento, nunca aprovação ----
  const V = await pendingCase();
  const clock0 = Date.parse(await scenarioClock(db, runId));
  const setClock = async (ms: number) => ok(await db.from("scenario_runs").update({ clock_now: new Date(ms).toISOString() }).eq("id", runId), "relógio");
  check("antes do prazo nada é escalonado", (await escalateExpired(db, runId)) === 0);
  await setClock(clock0 + 25 * 3600_000);
  const e1 = await escalateExpired(db, runId);
  check("prazo vencido gera cobrança ao supervisor, sem aprovar", e1 >= 1 && (await proposal(V.proposalId)).status === "aguardando_aprovacao" && (await proposal(V.proposalId)).escalation_level === 1
    && (await notifs(V.caseId)).some((x) => x.kind === "aprovacao_cobrada") && (await count("proposal_approvals", { proposal_id: V.proposalId })) === 0);
  check("repetir a rodada não duplica a cobrança", (await escalateExpired(db, runId)) === 0 && (await notifs(V.caseId)).filter((x) => x.kind === "aprovacao_cobrada").length === 1);
  await setClock(clock0 + 50 * 3600_000);
  await escalateExpired(db, runId);
  check("segundo vencimento escala; continua sem aprovação", (await proposal(V.proposalId)).escalation_level === 2 && (await notifs(V.caseId)).some((x) => x.kind === "aprovacao_escalonada")
    && (await count("action_executions", { proposal_id: V.proposalId })) === 0);
  const vAudit = (await audit(V.caseId)).filter((e) => e.event_type === "aprovacao_vencida");
  check("auditoria registra o vencimento e que não houve aprovação automática", vAudit.length === 2 && vAudit.every((e) => e.data.auto_approved === false));

  // ---- 12. Fila e detalhe ----
  // Cada escalonamento empurra o prazo em +24 h; só passando do novo prazo a proposta volta a constar como vencida.
  await setClock(clock0 + 75 * 3600_000);
  const queue = await listQueue(db, runId);
  const qV = queue.find((q) => q.id === V.caseId)!;
  check("fila marca a aprovação vencida e explica a prioridade", !!qV?.proposal?.overdue && qV.priority.reasons.some((r) => /vencido/i.test(r)), qV?.priority.reasons.join(" | "));
  check("fila vem ordenada por prioridade", queue.every((q, i) => i === 0 || byPriority(queue[i - 1], q) <= 0));
  check("filtros: responsável, prazo e motivo", filterQueue(queue, { responsavel: "sem" }, staff.sup1).every((q) => !q.assignedTo)
    && filterQueue(queue, { responsavel: staff.sup2 }, staff.sup1).some((q) => q.id === F.caseId)
    && filterQueue(queue, { prazo: "vencido" }, staff.sup1).some((q) => q.id === V.caseId)
    && filterQueue(queue, { motivo: "proposta_rejeitada" }, staff.sup1).some((q) => q.id === C.caseId));
  const detail = (await getCaseDetail(db, A.caseId))!;
  const dp = detail.proposals[0];
  check("detalhe traz proposta, valores, evidências, decisões, execução e linha do tempo",
    detail.proposals.length === 1 && dp.amountCents === 16000 && dp.evidence.length === 2 && dp.justification.length > 0 && dp.approvals.some((a) => a.decision === "aprovada")
    && !!dp.executionRef && detail.timeline.length >= 6 && detail.notifications.length >= 1 && !!detail.assigneeName === !!detail.assignedTo);

  // ---- 13. Acesso: navegador anônimo ----
  if (publishable) {
    const anon = createClient(url!, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
    const a1 = await anon.from("proposal_approvals").select("id").limit(1);
    const a2 = await anon.from("internal_notifications").select("id").limit(1);
    const a3 = await anon.rpc("decide_proposal", { p_proposal: A.proposalId, p_actor: staff.sup1, p_decision: "aprovada", p_version: 1 });
    const a4 = await anon.rpc("release_proposal", { p_proposal: A.proposalId, p_revalidation: { executable: true } });
    check("anônimo não lê aprovações nem avisos", (a1.error !== null || (a1.data ?? []).length === 0) && (a2.error !== null || (a2.data ?? []).length === 0));
    check("anônimo não executa as funções de decisão", !!a3.error && !!a4.error, `${a3.error?.message} | ${a4.error?.message}`);
  } else {
    console.log("AVISO NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ausente: verificação de acesso anônimo ignorada");
  }

  console.log(failures === 0 ? "\nTudo certo." : `\n${failures} verificação(ões) falharam.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error("ERRO", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (runId) await db.from("scenario_runs").delete().eq("id", runId);
    await cleanupStaff();
  });
