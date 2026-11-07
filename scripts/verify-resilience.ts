// Verificação da resiliência com a IA fora do ar, contra o banco de DESENVOLVIMENTO (migration 20261107000011 aplicada).
// IA SIMULADA e identificada (nenhuma chamada ao proxy). Cria o cenário temporário "verify-resilience" e o remove ao final;
// o disjuntor usa o nome isolado "verify-resilience" (não toca o disjuntor "proxy").
// Uso: node --env-file=.env scripts/verify-resilience.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readCsv } from "./lib/csv.ts";
import { AdapterError, createSimulatedAdapter, type CallObservation } from "../src/server/ai/adapter.ts";
import { createRouter } from "../src/server/ai/router.ts";
import { ACK_MESSAGE, ingestContact, type ContactEvent } from "../src/server/intake.ts";
import { processInvestigationTasks, type InvestigationJobDeps } from "../src/server/jobs/investigation.ts";
import { paramsFromPolicy } from "../src/server/policy/decision.ts";

const { NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SECRET_KEY: secret } = process.env;
if (!url || !secret) {
  console.error("Defina NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SECRET_KEY.");
  process.exit(2);
}
const db: SupabaseClient = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const CIRCUIT = "verify-resilience";
const params = paramsFromPolicy(readCsv("BD/politicas.csv").map((r) => ({ secao: r.secao, regra: r.regra, valor: r.valor })));

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "OK  " : "FALHA"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

let runId = "";
let seq = 0;
const T0 = "2026-11-02T08:00:00-03:00";
const ORDER = "GCH558661";
const CUSTOMER = "CH107459";
// Assuntos distintos no mesmo pedido = casos distintos (a pendência compatível exige o mesmo assunto).
const TEXTS = [
  "Meu pedido está atrasado, não chegou.", "O produto veio quebrado.", "Quero trocar o produto por outro.",
  "A personalização veio errada.", "Quero cancelar a compra.", "Cadê o brinde que prometeram?", "Tive uma alergia depois de usar o produto.",
];
const contact = async (text: string, over: Partial<ContactEvent> = {}, enqueue = true) =>
  ingestContact(db, runId, { channel: "whatsapp", externalEventId: `R-${++seq}`, text, receivedAt: T0, customerId: CUSTOMER, orderId: ORDER, ...over }, { enqueue });

const taskOf = async (caseId: string) => must(await db.from("investigation_tasks").select("*").eq("case_id", caseId).maybeSingle(), "tarefa");
const count = async (table: string, filter: Record<string, string>) => {
  let q = db.from(table).select("*", { count: "exact", head: true });
  for (const [k, v] of Object.entries(filter)) q = q.eq(k, v);
  const { count: n, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
};
const audits = async (caseId: string, type: string) => count("audit_events", { case_id: caseId, event_type: type });
const circuit = async () => must(await db.from("ai_circuit").select("*").eq("name", CIRCUIT).maybeSingle(), "disjuntor");
const resetCircuit = () => db.from("ai_circuit").delete().eq("name", CIRCUIT);
const releaseTask = (id: string) => db.from("investigation_tasks").update({ retry_at: null }).eq("id", id);

const toolTurn = JSON.stringify({ tool_calls: [{ name: "get_tracking", args: { order_id: ORDER } }] });
const answer = JSON.stringify({ proposal: {
  category: "atraso_entrega", secondary_categories: [], missing_info: [],
  origin: { hypothesis: "indeterminada", status: "em_investigacao", evidence_refs: [], summary: "Em análise." },
  action: null, needs_clarification: false, reply: "Estou verificando as informações do seu pedido e retorno em breve.",
} });

type Script = (n: number) => string;
/** Fábrica de dependências com IA simulada (mesmo caminho do roteador, do orçamento e do disjuntor). */
function deps(script: Script | null, over: { maxCalls?: number } = {}): { d: InvestigationJobDeps; calls: () => number } {
  let total = 0;
  const d: InvestigationJobDeps = {
    params, circuit: { name: CIRCUIT, cooldownSeconds: 3600, threshold: 3 },
    makeAdapter: (_ctx, onCall: (o: CallObservation) => void) => {
      if (!script) return null;
      const sim = createSimulatedAdapter((_m, n) => { total++; return script(n); });
      return createRouter({ economy: sim, reasoning: null, budget: { maxCalls: over.maxCalls ?? 6, maxTokens: 100_000 }, onCall });
    },
  };
  return { d, calls: () => total };
}
const down: Script = () => { throw new AdapterError("http", "Proxy respondeu HTTP 503."); };
const healthy: Script = (n) => (n === 1 ? toolTurn : answer);
const run = (d: InvestigationJobDeps, limit = 5) => processInvestigationTasks(db, { limit, worker: "verify", deps: d });

async function main() {
  await db.from("scenario_runs").delete().eq("name", "verify-resilience");
  await resetCircuit();
  runId = must(await db.from("scenario_runs").insert({ name: "verify-resilience", mode: "preview" }).select("id"), "criar cenário")![0].id;

  // ---------------------------------------------------------------- 1. Entrada: tarefa durável + confirmação sem IA
  console.log("— Entrada: tarefa durável e confirmação de recebimento (sem IA) —");
  const a = await contact(TEXTS[0]);
  const tA = await taskOf(a.case_id);
  check("caso novo nasce com tarefa de investigação pendente", !!tA && tA.status === "pendente" && tA.attempts === 0);
  const ackRows = must(await db.from("outbox_events").select("payload, kind, dedupe_key").eq("case_id", a.case_id), "outbox")!;
  check("confirmação de recebimento enfileirada uma vez, sem depender do modelo", ackRows.length === 1 && ackRows[0].kind === "notificacao_cliente" && ackRows[0].dedupe_key === "confirmacao_recebimento");
  const msg = String((ackRows[0].payload as { message: string }).message);
  check("a confirmação só informa o recebimento: sem reembolso, aprovação, prazo ou resolução", msg === ACK_MESSAGE && !/reembols|aprovad|resolvid|prazo|estorn|reenvi/i.test(msg));
  const dup = await contact(TEXTS[0], { externalEventId: `R-${seq}` });
  check("evento repetido não cria nova tarefa nem nova confirmação", dup.duplicate && (await count("investigation_tasks", { case_id: a.case_id })) === 1 && (await count("outbox_events", { case_id: a.case_id })) === 1);
  const more = await contact(TEXTS[0], { channel: "email" });
  check("novo contato na mesma pendência não duplica tarefa nem confirmação", !more.new_case && more.case_id === a.case_id && (await count("investigation_tasks", { case_id: a.case_id })) === 1 && (await count("outbox_events", { case_id: a.case_id })) === 1);
  const clar = await contact("Meu pedido atrasou.", { orderId: undefined, customerId: undefined });
  check("caso que precisa de esclarecimento não é investigado nem confirmado como em análise", !!clar.needs_clarification && (await count("investigation_tasks", { case_id: clar.case_id })) === 0);
  const seed = await contact(TEXTS[6], {}, false);
  check("entrada sem `enqueue` (fila inicial importada) não gera tarefas nem avisos", (await count("investigation_tasks", { case_id: seed.case_id })) === 0 && (await count("outbox_events", { case_id: seed.case_id })) === 0);

  // ---------------------------------------------------------------- 2. IA fora do ar: retentativa, disjuntor, sem chamar
  console.log("\n— IA fora do ar: retentativa com espera e disjuntor —");
  const out = deps(down);
  let r = await run(out.d);
  const afterFirst = await taskOf(a.case_id);
  check("falha do provedor devolve a tarefa à fila com espera (não encaminha logo, não executa nada)", r.reports.some((x) => x.outcome === "adiada_falha_ia")
    && afterFirst.status === "pendente" && afterFirst.attempts === 1 && Date.parse(afterFirst.retry_at) > Date.now() - 1000 && afterFirst.last_error_kind === "http");
  check("o caso continua sem encaminhamento nesse momento", must(await db.from("cases").select("status").eq("id", a.case_id).single(), "caso")!.status === "novo");
  await releaseTask(tA.id);
  r = await run(out.d);
  await releaseTask(tA.id);
  r = await run(out.d);
  const afterThird = await taskOf(a.case_id);
  const circ3 = await circuit();
  check("3 falhas consecutivas abrem o disjuntor", circ3?.state === "open" && circ3.failures >= 3 && afterThird.attempts === 3, `estado=${circ3?.state} falhas=${circ3?.failures}`);
  const callsBefore = out.calls();
  await releaseTask(tA.id);
  r = await run(out.d);
  const afterOpen = await taskOf(a.case_id);
  check("com o disjuntor aberto a IA nem é chamada", out.calls() === callsBefore && r.reports.some((x) => x.outcome === "adiada_circuito"));
  check("espera por disjuntor não consome tentativa", afterOpen.attempts === 3 && afterOpen.last_error_kind === "circuito_aberto");

  // ---------------------------------------------------------------- 3. Prazo esgotado → pessoa assume
  console.log("\n— Prazo esgotado sem IA: o caso vai para uma pessoa —");
  await db.from("investigation_tasks").update({ deadline_at: new Date(Date.now() - 1000).toISOString(), retry_at: null }).eq("id", tA.id);
  const callsAtDeadline = out.calls();
  r = await run(out.d);
  const degraded = await taskOf(a.case_id);
  const kA = must(await db.from("cases").select("status, handoff_reason, decision_requested").eq("id", a.case_id).single(), "caso")!;
  check("tarefa marcada como degradada, sem chamar a IA", degraded.status === "degradada" && out.calls() === callsAtDeadline);
  check("caso aguarda humano com motivo ia_indisponivel e decisão solicitada", kA.status === "aguardando_humano" && kA.handoff_reason === "ia_indisponivel" && !!kA.decision_requested);
  check("auditoria registra a degradação e a notificação interna foi criada", (await audits(a.case_id, "investigacao_degradada")) === 1 && (await count("internal_notifications", { case_id: a.case_id })) >= 1);
  check("modo degradado não cria proposta, aprovação, execução nem nova mensagem ao cliente", (await count("action_proposals", { case_id: a.case_id })) === 0
    && (await count("action_executions", { scenario_run_id: runId })) === 0 && (await count("outbox_events", { case_id: a.case_id })) === 1);
  r = await run(out.d);
  check("reprocessar não duplica o encaminhamento", (await audits(a.case_id, "investigacao_degradada")) === 1 && r.claimed === 0);

  // ---------------------------------------------------------------- 4. Recuperação: prova única e fechamento
  console.log("\n— Recuperação: uma chamada de prova fecha o disjuntor —");
  const b = await contact(TEXTS[1]);
  const tB = await taskOf(b.case_id);
  check("novo caso durante a queda entra na fila de espera", tB.status === "pendente");
  await db.from("ai_circuit").update({ opened_at: new Date(Date.now() - 2 * 3600_000).toISOString() }).eq("name", CIRCUIT);
  const g1 = must(await db.rpc("ai_circuit_check", { p_name: CIRCUIT, p_cooldown_seconds: 3600 }), "check1") as { allow: boolean; probe: boolean; state: string };
  const g2 = must(await db.rpc("ai_circuit_check", { p_name: CIRCUIT, p_cooldown_seconds: 3600 }), "check2") as { allow: boolean; state: string };
  check("passada a espera, só UMA chamada de prova é liberada (meio-aberto)", g1.allow && g1.probe && g1.state === "half_open" && !g2.allow && g2.state === "half_open");
  await db.from("ai_circuit").update({ state: "open", opened_at: new Date(Date.now() - 2 * 3600_000).toISOString(), probe_started_at: null }).eq("name", CIRCUIT);
  const ok1 = deps(healthy);
  r = await run(ok1.d);
  const doneB = await taskOf(b.case_id);
  check("IA de volta: a prova passa, o disjuntor fecha e a investigação é concluída", (await circuit())?.state === "closed" && doneB.status === "concluida" && r.reports.some((x) => x.outcome === "concluida"));
  check("investigação registrada na auditoria uma única vez", (await audits(b.case_id, "investigacao_concluida")) === 1);
  const again = await run(ok1.d);
  check("reprocessar não repete a investigação nem duplica efeitos", again.claimed === 0 && (await audits(b.case_id, "investigacao_concluida")) === 1 && (await count("outbox_events", { case_id: b.case_id })) === 1);

  // ---------------------------------------------------------------- 5. Concorrência e retomada
  console.log("\n— Concorrência e retomada —");
  const extra = [await contact(TEXTS[2]), await contact(TEXTS[3]), await contact(TEXTS[4]), await contact(TEXTS[5])];
  const [c1, c2] = await Promise.all([
    db.rpc("claim_investigation_tasks", { p_limit: 4, p_lease_seconds: 120, p_worker: "w1", p_max_attempts: 5 }),
    db.rpc("claim_investigation_tasks", { p_limit: 4, p_lease_seconds: 120, p_worker: "w2", p_max_attempts: 5 }),
  ]);
  const ids = [...((c1.data ?? []) as { id: string }[]), ...((c2.data ?? []) as { id: string }[])].map((x) => x.id);
  check("duas reservas simultâneas nunca pegam a mesma tarefa", ids.length === 4 && new Set(ids).size === 4, `${ids.length} reservas, ${new Set(ids).size} distintas`);
  await db.from("investigation_tasks").update({ lease_until: new Date(Date.now() - 1000).toISOString() }).eq("id", ids[0]);
  const reclaimed = must(await db.rpc("claim_investigation_tasks", { p_limit: 4, p_lease_seconds: 120, p_worker: "w3", p_max_attempts: 5 }), "retomada") as { id: string; attempt: number }[];
  check("reserva expirada é retomada (processo morreu no meio)", reclaimed.length === 1 && reclaimed[0].id === ids[0] && reclaimed[0].attempt === 2);

  // ---------------------------------------------------------------- 6. Outros caminhos que NÃO são "IA fora do ar"
  console.log("\n— Orçamento esgotado, IA não configurada e prazo curto —");
  const t6 = await taskOf(extra[1].case_id);
  await db.from("investigation_tasks").update({ status: "pendente", retry_at: null, lease_until: null }).eq("id", t6.id);
  await resetCircuit();
  const loop = deps(() => toolTurn, { maxCalls: 1 });
  r = await processInvestigationTasks(db, { limit: 50, worker: "verify", deps: loop.d });
  const t6after = await taskOf(extra[1].case_id);
  check("orçamento esgotado segue a continuidade humana normal e não abre o disjuntor", t6after.status === "concluida" && (t6after.result as { status: string }).status === "continuidade_humana"
    && (await circuit())?.state !== "open");
  check("caso com orçamento esgotado vai para uma pessoa (continuidade_humana)", must(await db.from("cases").select("handoff_reason").eq("id", extra[1].case_id).single(), "caso")!.handoff_reason === "continuidade_humana");

  const t7 = await taskOf(extra[2].case_id);
  await db.from("investigation_tasks").update({ status: "pendente", retry_at: null, lease_until: null, attempts: 0 }).eq("id", t7.id);
  const none = deps(null);
  r = await processInvestigationTasks(db, { limit: 50, worker: "verify", deps: none.d });
  const t7after = await taskOf(extra[2].case_id);
  check("IA não configurada: tarefa espera (conta tentativa) e o disjuntor não é afetado", t7after.last_error_kind === "nao_configurada" && t7after.status === "pendente" && (await circuit())?.state !== "open");

  const t8 = await taskOf(extra[3].case_id);
  const soon = Date.now() + 10_000;
  await db.from("investigation_tasks").update({ status: "pendente", retry_at: null, lease_until: null, attempts: 0, deadline_at: new Date(soon).toISOString() }).eq("id", t8.id);
  await resetCircuit();
  await processInvestigationTasks(db, { limit: 50, worker: "verify", deps: deps(down).d });
  const t8after = await taskOf(extra[3].case_id);
  check("a espera nunca ultrapassa o prazo (no vencimento, a próxima rodada encaminha)", Date.parse(t8after.retry_at) <= soon + 2000, `retry_at=${t8after.retry_at}`);

  // ---------------------------------------------------------------- 7. Segurança do modo degradado
  console.log("\n— Segurança —");
  const dangerous = await count("action_proposals", { scenario_run_id: runId });
  const executed = must(await db.from("action_proposals").select("status").eq("scenario_run_id", runId).in("status", ["concluida", "executando"]), "propostas")!.length;
  check("nada foi executado automaticamente em nenhum dos cenários de falha", executed === 0 && (await count("action_executions", { scenario_run_id: runId })) === 0, `${dangerous} proposta(s) no cenário`);
  const anon = createClient(url!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "", { auth: { persistSession: false } });
  const denied = await anon.rpc("ai_circuit_record", { p_name: CIRCUIT, p_ok: true });
  check("funções do disjuntor e da fila não são chamáveis por anônimo", !!denied.error);
  const anonRows = await anon.from("investigation_tasks").select("id").limit(1);
  check("tarefas não são legíveis por anônimo", (anonRows.data ?? []).length === 0);
}

main()
  .catch((e) => { console.error(`ERRO: ${(e as Error).message}`); failures++; })
  .finally(async () => {
    if (runId) await db.from("scenario_runs").delete().eq("id", runId);
    await resetCircuit();
    console.log(failures ? `\n${failures} falha(s).` : "\nTudo certo.");
    process.exit(failures ? 1 : 0);
  });
