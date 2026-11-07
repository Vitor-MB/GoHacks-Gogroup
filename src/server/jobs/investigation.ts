// Processador de investigações com a IA possivelmente fora do ar. Chamado pela rota interna (Cron).
// Fluxo por tarefa: disjuntor → contexto → investigação (IA propõe, servidor valida) → proposta/encaminhamento → conclusão.
// Falha do PROVEDOR (timeout, rede, HTTP, resposta inválida) devolve a tarefa à fila com espera crescente; esgotado o prazo,
// o próprio banco encaminha o caso a uma pessoa (motivo `ia_indisponivel`). Nada aqui aprova, executa ou promete resultado,
// e orçamento esgotado ou saída inválida do modelo NÃO são "IA fora do ar": seguem o caminho normal de continuidade humana.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallObservation, ModelAdapter } from "../ai/adapter.ts";
import { investigate, type InvestigationOutcome } from "../ai/investigate.ts";
import { dbToolSet } from "../ai/tools.ts";
import { saoPauloDate } from "../evidence.ts";
import { DEFAULT_REVIEW_WINDOW_HOURS } from "../execution/adapters.ts";
import { recordInvestigation } from "../execution/execute.ts";
import type { PolicyParams } from "../policy/decision.ts";
import { getOrderEvidence, scenarioClock } from "../queries.ts";
import { call, loadFactsFromDb } from "../queue/approvals.ts";

/** Falhas que indicam indisponibilidade do provedor e alimentam o disjuntor. */
export const PROVIDER_FAILURES: ReadonlySet<string> = new Set(["timeout", "rede", "http", "resposta_invalida"]);

export interface ClaimedInvestigation { id: string; scenario_run_id: string; case_id: string; attempt: number; deadline_at: string }

export type InvestigationTaskOutcome = "concluida" | "adiada_circuito" | "adiada_sem_ia" | "adiada_falha_ia" | "erro" | "cancelada";
export interface InvestigationTaskReport { taskId: string; caseId: string; attempt: number; outcome: InvestigationTaskOutcome; detail?: string }

export interface InvestigationJobDeps {
  params: PolicyParams;
  /** Cria o adaptador de IA do caso. `onCall` recebe cada tentativa (o orquestrador usa para o disjuntor). Nulo = IA não configurada. */
  makeAdapter: (ctx: { runId: string; caseId: string }, onCall: (o: CallObservation) => void) => ModelAdapter | null;
  circuit?: { name?: string; cooldownSeconds?: number; threshold?: number };
  /** Espera antes de nova tentativa por falha do provedor, em segundos, a partir do número da tentativa. */
  backoffSeconds?: (attempt: number) => number;
  reviewWindowHours?: number;
}

export interface InvestigationJobOptions {
  limit?: number;
  leaseSeconds?: number;
  worker?: string;
  /** Orçamento de tempo da invocação; o que sobrar volta à fila sem consumir tentativa. */
  budgetMs?: number;
  maxAttempts?: number;
  deps: InvestigationJobDeps;
}

export interface InvestigationJobReport { claimed: number; reports: InvestigationTaskReport[] }

const defaultBackoff = (attempt: number) => Math.min(30 * 2 ** Math.max(attempt - 1, 0), 300);

interface CaseContext { orderId: string | null; subject: string | undefined; text: string }

async function loadContext(db: SupabaseClient, caseId: string): Promise<CaseContext | null> {
  const k = await db.from("cases").select("order_id, summary").eq("id", caseId).maybeSingle();
  if (k.error) throw new Error(`caso: ${k.error.message}`);
  if (!k.data) return null;
  const links = await db.from("case_conversations").select("conversation_id").eq("case_id", caseId);
  if (links.error) throw new Error(`conversas do caso: ${links.error.message}`);
  const convIds = (links.data ?? []).map((l) => l.conversation_id as string);
  let text = "";
  let subject: string | undefined;
  if (convIds.length) {
    const [msgs, convs] = await Promise.all([
      db.from("messages").select("body, sent_at").in("conversation_id", convIds).eq("author", "cliente").order("sent_at", { ascending: false }).limit(3),
      db.from("conversations").select("subject").in("conversation_id", convIds).limit(1),
    ]);
    if (msgs.error) throw new Error(`mensagens: ${msgs.error.message}`);
    text = (msgs.data ?? []).map((m) => String(m.body ?? "")).reverse().join("\n---\n").slice(0, 2000);
    subject = (convs.data?.[0]?.subject as string | null) ?? undefined;
  }
  return { orderId: (k.data.order_id as string | null) ?? null, subject: subject ?? ((k.data.summary as string | null) ?? undefined), text: text || (k.data.summary as string | null) || "" };
}

async function runOne(db: SupabaseClient, t: ClaimedInvestigation, deps: InvestigationJobDeps): Promise<InvestigationTaskReport> {
  const base = { taskId: t.id, caseId: t.case_id, attempt: t.attempt };
  const circuit = { name: deps.circuit?.name ?? "proxy", cooldown: deps.circuit?.cooldownSeconds ?? 60, threshold: deps.circuit?.threshold ?? 3 };
  // Calculado no momento de devolver a tarefa (a investigação pode ter levado segundos).
  const secondsLeft = () => Math.max(0, Math.ceil((Date.parse(t.deadline_at) - Date.now()) / 1000));
  // A espera nunca passa do prazo: no vencimento a próxima rodada encaminha o caso a uma pessoa.
  const retry = (error: string, kind: string, delay: number, count: boolean) =>
    call(db, "retry_investigation_task", { p_task: t.id, p_error: error, p_error_kind: kind, p_delay_seconds: Math.min(delay, secondsLeft() + 1), p_count: count });

  try {
    const gate = await call<{ allow: boolean; state: string; retry_in_seconds: number }>(db, "ai_circuit_check", { p_name: circuit.name, p_cooldown_seconds: circuit.cooldown });
    if (!gate.allow) {
      await retry("disjuntor aberto: IA indisponível", "circuito_aberto", Math.max(gate.retry_in_seconds, 5), false);
      return { ...base, outcome: "adiada_circuito", detail: `disjuntor ${gate.state}; nova tentativa em ${gate.retry_in_seconds}s` };
    }

    const ctx = await loadContext(db, t.case_id);
    if (!ctx) {
      await call(db, "complete_investigation_task", { p_task: t.id, p_status: "cancelada", p_result: { motivo: "caso não encontrado" } });
      return { ...base, outcome: "cancelada", detail: "caso não encontrado" };
    }

    const obs: CallObservation[] = [];
    const adapter = deps.makeAdapter({ runId: t.scenario_run_id, caseId: t.case_id }, (o) => obs.push(o));
    if (!adapter) {
      await retry("IA não configurada neste ambiente", "nao_configurada", 60, true);
      return { ...base, outcome: "adiada_sem_ia", detail: "IA não configurada" };
    }

    const runId = t.scenario_run_id;
    const asOf = await scenarioClock(db, runId);
    const facts = ctx.orderId ? await loadFactsFromDb(db, runId, ctx.orderId) : null;
    const order = ctx.orderId ? await getOrderEvidence(db, runId, ctx.orderId) : null;
    const outcome: InvestigationOutcome = await investigate({
      adapter, tools: dbToolSet(db, runId), message: { subject: ctx.subject, text: ctx.text }, orderId: ctx.orderId,
      asOfDate: saoPauloDate(asOf), params: deps.params, actor: { id: "gobia", role: "atendente" },
      loadFacts: async () => facts, registration: { sku: order?.data?.order.sku ?? null, lot: order?.data?.order.product_lot ?? null },
    });

    // Disjuntor: só indisponibilidade do provedor conta; orçamento esgotado não é falha do provedor.
    for (const o of obs) {
      if (o.ok) await call(db, "ai_circuit_record", { p_name: circuit.name, p_ok: true, p_error_kind: null, p_threshold: circuit.threshold });
      else if (o.errorKind && PROVIDER_FAILURES.has(o.errorKind)) {
        await call(db, "ai_circuit_record", { p_name: circuit.name, p_ok: false, p_error_kind: o.errorKind, p_threshold: circuit.threshold });
      }
    }

    if (outcome.aiFailure && PROVIDER_FAILURES.has(outcome.aiFailure)) {
      await retry(`IA indisponível (${outcome.aiFailure})`, outcome.aiFailure, (deps.backoffSeconds ?? defaultBackoff)(t.attempt), true);
      return { ...base, outcome: "adiada_falha_ia", detail: outcome.aiFailure };
    }

    await recordInvestigation(db, runId, t.case_id, ctx.orderId, outcome, {
      ...(facts ? { facts } : {}), reviewWindowHours: deps.reviewWindowHours ?? DEFAULT_REVIEW_WINDOW_HOURS,
    });
    await call(db, "complete_investigation_task", { p_task: t.id, p_status: "concluida", p_result: { status: outcome.status, steps: outcome.steps } });
    return { ...base, outcome: "concluida", detail: outcome.status };
  } catch (e) {
    const message = e instanceof Error ? e.message : "erro";
    await retry(message, "erro_interno", 30, true).catch(() => undefined);
    return { ...base, outcome: "erro", detail: message };
  }
}

export async function processInvestigationTasks(db: SupabaseClient, o: InvestigationJobOptions): Promise<InvestigationJobReport> {
  const deadline = Date.now() + (o.budgetMs ?? 25_000);
  const claimed = await call<ClaimedInvestigation[]>(db, "claim_investigation_tasks", {
    p_limit: o.limit ?? 3, p_lease_seconds: o.leaseSeconds ?? 120, p_worker: o.worker ?? null, p_max_attempts: o.maxAttempts ?? 5,
  });
  const reports: InvestigationTaskReport[] = [];
  for (const t of claimed) {
    if (Date.now() > deadline) {
      await call(db, "retry_investigation_task", { p_task: t.id, p_error: "orçamento de tempo da invocação esgotado", p_error_kind: "orcamento_de_tempo", p_delay_seconds: 0, p_count: false });
      reports.push({ taskId: t.id, caseId: t.case_id, attempt: t.attempt, outcome: "adiada_circuito", detail: "orçamento de tempo esgotado" });
      continue;
    }
    reports.push(await runOne(db, t, o.deps));
  }
  return { claimed: claimed.length, reports };
}
