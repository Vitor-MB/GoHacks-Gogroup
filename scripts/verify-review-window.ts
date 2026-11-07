// GOB-10 · Verifica a janela de revisão e o processador de tarefas contra o banco de DESENVOLVIMENTO.
// Pré-requisito: migration 20261107000008 aplicada (e as anteriores), importação executada. Sem IA.
// Uso: node --env-file=.env scripts/verify-review-window.ts
// Opcional: VERIFY_BASE_URL=http://localhost:3000 também exercita a rota HTTP (credencial, recusa e execução).
// Cria o cenário temporário "verify-review" e funcionários temporários (gob10-*@verify.test); remove tudo ao final.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readCsv } from "./lib/csv.ts";
import { ingestContact } from "../src/server/intake.ts";
import { decide, paramsFromPolicy, type VerifiedFacts } from "../src/server/policy/decision.ts";
import type { InvestigationOutcome, OutcomeStatus } from "../src/server/ai/investigate.ts";
import { createSimulatedAdapter } from "../src/server/execution/adapters.ts";
import { recordInvestigation } from "../src/server/execution/execute.ts";
import { scenarioClock } from "../src/server/queries.ts";
import { countdownLabel } from "../src/server/jobs/countdown.ts";
import { processDueTasks } from "../src/server/jobs/process.ts";
import { releaseReviewWindow, reviewWindowMessage } from "../src/server/jobs/review.ts";
import { listPending } from "../src/server/pending.ts";
import { decideProposal, HumanDecisionError, type Deps } from "../src/server/queue/approvals.ts";

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

const facts = (orderId: string, over: Partial<VerifiedFacts> = {}): VerifiedFacts => ({
  orderId, orderValueCents: 5000, separatedOn: "2026-10-22", deliveredOn: null, promisedOn: "2026-10-15",
  lastEventOn: "2026-10-28", lastEventStatus: "em_transito", lostConfirmed: false, identityConflicts: [], duplicate: null,
  suspicionPending: false, customerPreference: "reembolso", hasPhoto: false, ...over,
});

/** Reembolso de R$ valor: dentro da alçada = ação já autorizada (admite a janela); acima = exige o supervisor. */
function reembolso(orderId: string, valor: number): InvestigationOutcome {
  const decision = decide({
    asOf: "2026-11-02", category: "atraso_entrega", action: "reembolsar", requestedCents: null,
    facts: facts(orderId, { orderValueCents: valor }), actor: gobia, approval: null, params,
  });
  const status: OutcomeStatus = decision.approvalRequired ? "aguardando_aprovacao" : "proposta_validada";
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
const round = (over: Partial<Deps> = {}, limit = 10) => processDueTasks(db, { runId, limit, worker: "verify", deps: deps(over) });

const count = async (table: string, filter: Record<string, string>) => {
  let q = db.from(table).select("*", { count: "exact", head: true });
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  const { count: n, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
};
const audit = async (caseId: string) =>
  ((ok(await db.from("audit_events").select("event_type, actor_type, data").eq("case_id", caseId).order("id"), "auditoria") ?? []) as
    { event_type: string; actor_type: string; data: Record<string, unknown> }[]);
const types = (rows: { event_type: string }[]) => rows.map((r) => r.event_type);
const proposal = async (id: string) => ok(await db.from("action_proposals").select("*").eq("id", id).single(), "proposta")!;
const task = async (proposalId: string) => ok(await db.from("scheduled_tasks").select("*").eq("proposal_id", proposalId).order("created_at"), "tarefa")!;
const caseRow = async (id: string) => ok(await db.from("cases").select("status, assigned_to, handoff_reason").eq("id", id).single(), "caso")!;
const outbox = async (caseId: string) =>
  ((ok(await db.from("outbox_events").select("kind, payload").eq("case_id", caseId), "outbox") ?? []) as { kind: string; payload: { text?: string; stage?: string } }[]);
const simOps = async (proposalId: string) => {
  const p = await proposal(proposalId);
  return count("simulated_operations", { scenario_run_id: runId, idempotency_key: `exec:${p.idempotency_key}` });
};
const setClockBy = async (hours: number) => {
  const now = Date.parse(await scenarioClock(db, runId));
  ok(await db.from("scenario_runs").update({ clock_now: new Date(now + hours * 3600_000).toISOString() }).eq("id", runId), "relógio");
};

let pool: { order_id: string; customer_id: string }[] = [];
let n = 0;
async function newCase(): Promise<{ caseId: string; orderId: string }> {
  const o = pool[n++];
  if (!o) throw new Error("pedidos de teste insuficientes");
  const clock = await scenarioClock(db, runId);
  const r = await ingestContact(db, runId, {
    channel: "email", externalEventId: `win-${n}-${o.order_id}`, customerId: o.customer_id, orderId: o.order_id,
    subject: "Pedido atrasado", text: `Meu pedido ${o.order_id} atrasou.`, receivedAt: new Date(clock).toISOString(),
  });
  return { caseId: r.case_id, orderId: o.order_id };
}

/** Caso com reembolso de R$ 50,00 (dentro da alçada) já agendado na janela de duas horas. */
async function windowCase(valor = 5000) {
  const c = await newCase();
  const rec = await recordInvestigation(db, runId, c.caseId, c.orderId, reembolso(c.orderId, valor), { facts: facts(c.orderId, { orderValueCents: valor }), reviewWindowHours: 2 });
  if (!rec.proposalId) throw new Error("proposta não registrada");
  return { ...c, proposalId: rec.proposalId, rec };
}

const staff: Record<string, string> = {};
async function makeStaff(key: string, role: "atendente" | "analista" | "supervisor", scope: { scope: "group" } | { scope: "brand"; brand_id: string }) {
  const email = `gob10-${key}@verify.test`;
  const row = ok(await db.from("staff").insert({ full_name: `Teste ${key}`, email, role }).select("id"), `staff ${key}`)![0];
  ok(await db.from("staff_scopes").insert({ staff_id: row.id, ...scope }), `escopo ${key}`);
  staff[key] = row.id as string;
}
const cleanupStaff = async () => { await db.from("staff").delete().like("email", "gob10-%@verify.test"); };

async function main() {
  // ---- Regras puras ----
  check("contagem: janela aberta", countdownLabel(72 * 60_000) === "faltam 1 h 12 min", countdownLabel(72 * 60_000));
  check("contagem: janela vencida aguarda a próxima rodada", /vencida há 5 min/.test(countdownLabel(-5 * 60_000)) && /próxima rodada/.test(countdownLabel(-5 * 60_000)));
  const msg = reviewWindowMessage("reembolsar", 2);
  check("mensagem ao cliente: programada, sem prometer crédito nem horário", /programada/.test(msg) && /duas horas/.test(msg) && /depende da forma de pagamento/.test(msg) && !/foi (reembolsad|concluíd|creditad)/i.test(msg), msg);

  // ---- Banco ----
  const probe = await db.from("scheduled_tasks").select("id").limit(1);
  if (probe.error) throw new Error(`tabelas da GOB-10 ausentes: aplique supabase/migrations/20261107000008_review_window_and_jobs.sql (${probe.error.message})`);

  await db.from("scenario_runs").delete().eq("name", "verify-review");
  await cleanupStaff();
  runId = ok(await db.from("scenario_runs").insert({ name: "verify-review", mode: "preview" }).select("id"), "criar cenário")![0].id;
  pool = ok(await db.rpc("orders_as_of", { p_run: runId }).select("order_id, customer_id").like("order_id", "GCH%").not("customer_id", "is", null).limit(24), "pedidos") as typeof pool;
  if (pool.length < 14) throw new Error("poucos pedidos Gocase no relógio do cenário: rode a importação");

  const brandOf = async (caseId: string) => (ok(await db.from("cases").select("brand_id").eq("id", caseId).single(), "marca")!).brand_id as string | null;
  const probeCase = await windowCase();
  const brandA = await brandOf(probeCase.caseId);
  const otherBrand = (ok(await db.from("brands").select("id"), "marcas") as { id: string }[]).find((b) => b.id !== brandA)!.id;
  await makeStaff("op", "atendente", { scope: "group" });
  await makeStaff("sup", "supervisor", { scope: "group" });
  await makeStaff("fora", "atendente", { scope: "brand", brand_id: otherBrand });

  // ---- 1. Agendamento ----
  const W = probeCase;
  const clock0 = Date.parse(await scenarioClock(db, runId));
  const pW = await proposal(W.proposalId);
  check("ação elegível entra na janela com execute_after = relógio do cenário + 2 h", W.rec.status === "em_janela_revisao" && pW.status === "em_janela_revisao"
    && Date.parse(pW.execute_after) === clock0 + 2 * 3600_000, String(pW.execute_after));
  const tW = await task(W.proposalId);
  check("tarefa persistida e pendente, vencendo no execute_after", tW.length === 1 && tW[0].status === "pendente" && Date.parse(tW[0].due_at) === clock0 + 2 * 3600_000);
  check("auditoria registra o agendamento com a versão da política", types(await audit(W.caseId)).includes("janela_revisao_agendada") && !!pW.policy_version);
  const ob = await outbox(W.caseId);
  check("aviso ao cliente só diz que está programado (nada executado ainda)", ob.length === 1 && ob[0].payload.stage === "programada" && /programada/.test(String(ob[0].payload.text))
    && (await count("action_executions", { proposal_id: W.proposalId })) === 0);
  await recordInvestigation(db, runId, W.caseId, W.orderId, reembolso(W.orderId, 5000), { facts: facts(W.orderId), reviewWindowHours: 2 });
  check("repetir a investigação não duplica proposta, tarefa nem aviso", (await task(W.proposalId)).length === 1 && (await outbox(W.caseId)).length === 1 && (await count("action_proposals", { case_id: W.caseId })) === 1);

  // Revisão opcional x aprovação obrigatória
  const A = await newCase();
  const recA = await recordInvestigation(db, runId, A.caseId, A.orderId, reembolso(A.orderId, 15000), { facts: facts(A.orderId, { orderValueCents: 15000 }), approvalDueHours: 24, reviewWindowHours: 2 });
  const pA = await proposal(recA.proposalId!);
  check("acima da alçada não entra na janela: aguarda aprovação obrigatória", pA.status === "aguardando_aprovacao" && !pA.execute_after && (await task(pA.id)).length === 0);
  const tamper = await db.rpc("schedule_review_window", { p_proposal: pA.id, p_hours: 2 });
  check("o banco recusa agendar janela para aprovação obrigatória", !!tamper.error && /estado_invalido/.test(tamper.error.message), tamper.error?.message);
  const tamper2 = await db.rpc("release_review_window", { p_proposal: pA.id, p_actor: null, p_revalidation: { executable: true, reviewWindowAllowed: true } });
  check("o banco recusa liberar por timer uma aprovação obrigatória", !!tamper2.error && /estado_invalido/.test(tamper2.error.message), tamper2.error?.message);

  // ---- 2. Visão de pendências (separada) ----
  const view = await listPending(db, runId);
  const rW = view.review.find((r) => r.proposalId === W.proposalId);
  const rA = view.approvals.find((r) => r.proposalId === pA.id);
  check("pendências: janela de revisão e aprovação obrigatória em listas separadas", !!rW && !!rA && !view.review.some((r) => r.proposalId === pA.id) && !view.approvals.some((r) => r.proposalId === W.proposalId));
  check("pendências: contagem regressiva calculada no relógio do cenário", rW?.remainingMs === 2 * 3600_000 && rW?.countdown === "faltam 2 h 0 min", rW?.countdown ?? "");

  // ---- 3. Antes do vencimento nada executa ----
  const early = await round();
  check("antes de vencer, a rodada não reserva nem executa", early.claimed === 0 && (await count("action_executions", { proposal_id: W.proposalId })) === 0);
  await setClockBy(1);
  check("com 1 h de 2, ainda não vence", (await round()).claimed === 0);

  // ---- 4. Vencimento: executa na rodada seguinte, sem painel ----
  await setClockBy(2);
  const afterDue = (await listPending(db, runId)).review.find((r) => r.proposalId === W.proposalId);
  check("pendências: vencida aguarda a próxima rodada (não executa sozinha)", !!afterDue && (afterDue.remainingMs ?? 1) < 0 && /próxima rodada/.test(afterDue.countdown ?? "") && (await proposal(W.proposalId)).status === "em_janela_revisao");
  const r1 = await round();
  const pW2 = await proposal(W.proposalId);
  check("rodada após o vencimento executa a ação elegível (simulada)", r1.reports.some((r) => r.proposalId === W.proposalId && r.outcome === "executada") && pW2.status === "concluida", JSON.stringify(r1.reports));
  const aW = types(await audit(W.caseId));
  check("auditoria: agendada → liberada pelo vencimento → execução concluída",
    ["janela_revisao_agendada", "janela_revisao_liberada", "execucao_iniciada", "execucao_concluida"].every((t, i, a) => aW.indexOf(t) > (i ? aW.indexOf(a[i - 1]!) : -1)), aW.join(" > "));
  const rel = (await audit(W.caseId)).find((e) => e.event_type === "janela_revisao_liberada");
  check("a liberação registra a origem (vencimento), o sistema como ator e a revalidação", rel?.actor_type === "system" && rel.data.source === "vencimento" && rel.data.revalidation === "ok");
  check("tarefa concluída; confirmação ao cliente só depois do resultado", (await task(W.proposalId))[0].status === "concluida"
    && (await outbox(W.caseId)).filter((o) => o.payload.stage !== "programada").length === 1);
  const again = await round();
  check("rodar de novo não repete o efeito", again.claimed === 0 && (await count("action_executions", { proposal_id: W.proposalId })) === 1 && (await simOps(W.proposalId)) === 1);

  // ---- 5. Suspensão e rejeição antes do vencimento bloqueiam a execução ----
  const S = await windowCase();
  const R = await windowCase();
  await decideProposal(db, runId, { proposalId: S.proposalId, actorId: staff.op!, decision: "suspensa", version: 1, note: "cliente pediu para aguardar" }, deps());
  await decideProposal(db, runId, { proposalId: R.proposalId, actorId: staff.op!, decision: "rejeitada", version: 1, note: "reenvio é melhor" }, deps());
  await setClockBy(3);
  const r2 = await round();
  check("suspensão anterior bloqueia a execução", (await proposal(S.proposalId)).status === "suspensa" && (await count("action_executions", { proposal_id: S.proposalId })) === 0 && (await task(S.proposalId))[0].status === "cancelada");
  check("rejeição anterior bloqueia a execução e mantém continuidade humana", (await proposal(R.proposalId)).status === "rejeitada" && (await count("action_executions", { proposal_id: R.proposalId })) === 0
    && (await caseRow(R.caseId)).assigned_to === staff.op && (await caseRow(R.caseId)).status === "aguardando_humano", JSON.stringify(r2.reports));
  check("auditoria registra que a janela foi cancelada", types(await audit(S.caseId)).includes("janela_revisao_cancelada") && types(await audit(S.caseId)).includes("proposta_suspensa"));

  // ---- 6. Aprovação obrigatória vencida continua bloqueada ----
  await setClockBy(30);
  const r3 = await round();
  const pA2 = await proposal(pA.id);
  check("aprovação obrigatória vencida não é executada nem aprovada pelo processador", pA2.status === "aguardando_aprovacao" && (await count("action_executions", { proposal_id: pA.id })) === 0
    && (await count("proposal_approvals", { proposal_id: pA.id })) === 0 && r3.approvalsEscalated >= 1);
  const vA = (await listPending(db, runId)).approvals.find((r) => r.proposalId === pA.id);
  check("pendências: aprovação vencida segue na lista do supervisor", !!vA && (vA.remainingMs ?? 0) > 0 || /vencido/.test(vA?.countdown ?? ""), vA?.countdown ?? "");

  // ---- 7. Invocações concorrentes ----
  const C = await windowCase();
  await setClockBy(3);
  const burst = await Promise.all(Array.from({ length: 5 }, () => round()));
  const executed = burst.flatMap((b) => b.reports).filter((r) => r.proposalId === C.proposalId && r.outcome === "executada");
  check("cinco invocações simultâneas: a tarefa é reservada e executada uma só vez", executed.length === 1
    && (await count("action_executions", { proposal_id: C.proposalId })) === 1 && (await simOps(C.proposalId)) === 1, `executadas=${executed.length}`);

  // ---- 8. Liberação antecipada ----
  const E = await windowCase();
  const deniedScope = await releaseReviewWindow(db, runId, { proposalId: E.proposalId, actorId: staff.fora! }, deps()).then(() => "liberou", (e: unknown) => (e instanceof HumanDecisionError ? e.code : "erro"));
  check("funcionário fora do escopo não libera a janela", deniedScope === "fora_do_escopo", deniedScope);
  const ear = await releaseReviewWindow(db, runId, { proposalId: E.proposalId, actorId: staff.op!, note: "cliente com pressa" }, deps());
  check("liberação antecipada por funcionário autorizado executa antes do vencimento", ear.released && ear.execution?.state === "concluida" && (await proposal(E.proposalId)).status === "concluida");
  const eRel = (await audit(E.caseId)).find((e) => e.event_type === "janela_revisao_liberada");
  check("auditoria identifica a liberação antecipada e quem a fez", eRel?.actor_type === "staff" && eRel.data.source === "liberacao_antecipada");
  const premature = await db.rpc("release_review_window", { p_proposal: (await windowCase()).proposalId, p_actor: null, p_revalidation: { executable: true, reviewWindowAllowed: true } });
  check("o sistema não libera antes do vencimento (guarda no banco)", !!premature.error && /ainda não venceu/.test(premature.error.message), premature.error?.message);
  await setClockBy(3);
  await round();
  check("vencer depois da liberação antecipada não duplica o efeito", (await count("action_executions", { proposal_id: E.proposalId })) === 1 && (await simOps(E.proposalId)) === 1);

  // Liberação antecipada e vencimento ao mesmo tempo
  const F = await windowCase();
  await setClockBy(3);
  await Promise.all([
    releaseReviewWindow(db, runId, { proposalId: F.proposalId, actorId: staff.op! }, deps()).catch(() => undefined),
    round(), round(),
  ]);
  check("liberação antecipada e vencimento simultâneos resultam em uma única operação", (await count("action_executions", { proposal_id: F.proposalId })) === 1 && (await simOps(F.proposalId)) === 1
    && (await proposal(F.proposalId)).status === "concluida");

  // ---- 9. Retomada após timeout ----
  const T1 = await windowCase();
  await setClockBy(3);
  const claimed = ok(await db.rpc("claim_due_tasks", { p_run: runId, p_limit: 50, p_lease_seconds: 30, p_worker: "morreu" }), "reservar") as { proposal_id: string }[];
  check("a reserva marca a tarefa e fica fora de outras invocações", claimed.some((c) => c.proposal_id === T1.proposalId) && (await round()).reports.every((r) => r.proposalId !== T1.proposalId));
  ok(await db.from("scheduled_tasks").update({ lease_until: new Date(Date.now() - 1000).toISOString() }).eq("proposal_id", T1.proposalId), "expirar reserva");
  const resumed = await round();
  check("reserva expirada é retomada e executa uma só vez", resumed.reports.some((r) => r.proposalId === T1.proposalId && r.outcome === "executada")
    && (await count("action_executions", { proposal_id: T1.proposalId })) === 1 && (await simOps(T1.proposalId)) === 1);
  check("auditoria registra a retomada", types(await audit(T1.caseId)).includes("tarefa_retomada"));

  // Processador morreu com a execução já reservada (efeito externo incerto): reconcilia antes de repetir
  const T2 = await windowCase();
  await setClockBy(3);
  ok(await db.rpc("claim_due_tasks", { p_run: runId, p_limit: 50, p_lease_seconds: 30, p_worker: "morreu2" }), "reservar");
  await releaseReviewWindow(db, runId, { proposalId: T2.proposalId, actorId: null }, { ...deps(), adapter: undefined });
  const begun = ok(await db.rpc("begin_execution", { p_proposal: T2.proposalId, p_adapter: "simulado" }), "begin") as { mode: string };
  const old = new Date(Date.now() - 600_000).toISOString();
  ok(await db.from("action_executions").update({ updated_at: old }).eq("proposal_id", T2.proposalId), "envelhecer execução");
  ok(await db.from("scheduled_tasks").update({ lease_until: new Date(Date.now() - 1000).toISOString() }).eq("proposal_id", T2.proposalId), "expirar reserva");
  const resumed2 = await round();
  check("retomada com execução interrompida reconcilia e conclui uma só vez", begun.mode === "run" && resumed2.reports.some((r) => r.proposalId === T2.proposalId && r.outcome === "executada")
    && (await count("action_executions", { proposal_id: T2.proposalId })) === 1 && (await simOps(T2.proposalId)) === 1 && types(await audit(T2.caseId)).includes("execucao_reserva_expirada"));

  // ---- 10. Revalidação no vencimento ----
  const H = await windowCase();
  await setClockBy(3);
  const r4 = await round({ loadFacts: async (o) => facts(o, { suspicionPending: true }) });
  check("dados novos (suspeita) no vencimento: não executa, bloqueia e devolve a uma pessoa", r4.reports.some((r) => r.proposalId === H.proposalId && r.outcome === "bloqueada")
    && (await proposal(H.proposalId)).status === "bloqueada" && (await count("action_executions", { proposal_id: H.proposalId })) === 0
    && (await caseRow(H.caseId)).handoff_reason === "revalidacao_bloqueada" && types(await audit(H.caseId)).includes("revalidacao_bloqueou"));

  // ---- 11. Acesso: o navegador não chama as funções ----
  if (publishable) {
    const anon = createClient(url as string, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
    const a1 = await anon.rpc("claim_due_tasks", { p_run: runId });
    const a2 = await anon.from("scheduled_tasks").select("id").limit(1);
    check("anônimo não reserva tarefas nem lê a fila de tarefas", !!a1.error && (a2.data ?? []).length === 0);
  }

  // ---- 12. Rota HTTP (opcional) ----
  const base = process.env.VERIFY_BASE_URL;
  if (base) {
    const cron = process.env.CRON_SECRET;
    const noAuth = await fetch(`${base}/api/internal/jobs/process`, { method: "POST" });
    const wrong = await fetch(`${base}/api/internal/jobs/process`, { method: "POST", headers: { authorization: "Bearer segredo-errado" } });
    check("rota recusa chamada sem credencial e com credencial errada", noAuth.status === 401 && wrong.status === 401, `${noAuth.status}/${wrong.status}`);
    if (cron) {
      const W2 = await windowCase();
      await setClockBy(3);
      const res = await fetch(`${base}/api/internal/jobs/process`, { method: "POST", headers: { authorization: `Bearer ${cron}`, "content-type": "application/json" }, body: JSON.stringify({ scenario: "verify-review" }) });
      const body = (await res.json()) as { claimed: number; reports: { proposalId: string; outcome: string }[] };
      check("rota autenticada processa a tarefa vencida (sem painel aberto)", res.status === 200 && body.reports.some((r) => r.proposalId === W2.proposalId && r.outcome === "executada")
        && (await count("action_executions", { proposal_id: W2.proposalId })) === 1);
    }
  } else {
    console.log("SKIP rota HTTP: defina VERIFY_BASE_URL (ex.: http://localhost:3000) com o servidor rodando para testar credencial e processamento pela rota.");
  }
}

try {
  await main();
} catch (e) {
  failures++;
  console.error("FALHA inesperada:", e instanceof Error ? e.message : e);
} finally {
  await db.from("scenario_runs").delete().eq("name", "verify-review");
  await cleanupStaff();
}
console.log(failures ? `\n${failures} verificação(ões) falharam.` : "\nTudo certo.");
process.exit(failures ? 1 : 0);
