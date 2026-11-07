// GOB-10 · Processador de tarefas vencidas. Chamado pela rota interna (Supabase Cron) e pelo botão de demonstração.
// Cada invocação é curta: reserva um lote pequeno (transacional, skip locked), revalida e executa pelo caminho idempotente.
// Nunca aguarda a janela: o que ainda não venceu fica no banco para a próxima rodada.
import type { SupabaseClient } from "@supabase/supabase-js";
import { call, escalateExpired, type Deps } from "../queue/approvals.ts";
import { releaseReviewWindow } from "./review.ts";

export interface ClaimedTask { id: string; proposal_id: string; scenario_run_id: string; attempt: number; due_at: string; proposal_status: string }

export type TaskOutcome = "executada" | "bloqueada" | "falhou" | "adiada" | "erro";
export interface TaskReport { taskId: string; proposalId: string; attempt: number; outcome: TaskOutcome; detail?: string }

export interface ProcessOptions {
  /** Limita ao cenário informado. Ausente = todos (cada execução vence pelo próprio relógio). */
  runId?: string | null;
  limit?: number;
  leaseSeconds?: number;
  worker?: string;
  /** Orçamento de tempo da invocação; o que sobrar volta à fila sem consumir tentativa. */
  budgetMs?: number;
  deps: Deps;
}

export interface ProcessReport { claimed: number; reports: TaskReport[]; approvalsEscalated: number }

async function runOne(db: SupabaseClient, t: ClaimedTask, deps: Deps): Promise<TaskReport> {
  const base = { taskId: t.id, proposalId: t.proposal_id, attempt: t.attempt };
  try {
    const r = await releaseReviewWindow(db, t.scenario_run_id, { proposalId: t.proposal_id, actorId: null }, deps);
    if (!r.released) {
      await call(db, "complete_task", { p_task: t.id, p_status: "concluida", p_result: { outcome: "bloqueada", blockers: r.blockers ?? [] } });
      return { ...base, outcome: "bloqueada", detail: (r.blockers ?? []).join("; ") };
    }
    const state = r.execution?.state;
    if (state === "concluida" || state === "reuso") {
      await call(db, "complete_task", { p_task: t.id, p_status: "concluida", p_result: { outcome: "executada", state, externalRef: r.execution?.externalRef ?? null } });
      return { ...base, outcome: "executada", detail: state };
    }
    if (state === "falhou") {
      await call(db, "complete_task", { p_task: t.id, p_status: "falhou", p_result: { outcome: "falhou", error: r.execution?.error ?? null } });
      return { ...base, outcome: "falhou", detail: r.execution?.error };
    }
    // Outra execução em curso ou reconciliação adiada: tenta de novo na próxima rodada, sem gastar tentativa.
    await call(db, "retry_task", { p_task: t.id, p_error: r.execution?.error ?? "execução em andamento", p_delay_seconds: 15, p_count: false });
    return { ...base, outcome: "adiada", detail: r.execution?.error ?? "execução em andamento" };
  } catch (e) {
    const message = e instanceof Error ? e.message : "erro";
    await call(db, "retry_task", { p_task: t.id, p_error: message, p_delay_seconds: 30, p_count: true }).catch(() => undefined);
    return { ...base, outcome: "erro", detail: message };
  }
}

export async function processDueTasks(db: SupabaseClient, o: ProcessOptions): Promise<ProcessReport> {
  const deadline = Date.now() + (o.budgetMs ?? 20_000);
  const claimed = await call<ClaimedTask[]>(db, "claim_due_tasks", {
    p_run: o.runId ?? null, p_limit: o.limit ?? 5, p_lease_seconds: o.leaseSeconds ?? 120, p_worker: o.worker ?? null,
  });

  const reports: TaskReport[] = [];
  for (const t of claimed) {
    if (Date.now() > deadline) {
      await call(db, "retry_task", { p_task: t.id, p_error: "orçamento de tempo da invocação esgotado", p_delay_seconds: 0, p_count: false });
      reports.push({ taskId: t.id, proposalId: t.proposal_id, attempt: t.attempt, outcome: "adiada", detail: "orçamento de tempo esgotado" });
      continue;
    }
    reports.push(await runOne(db, t, o.deps));
  }

  // Aprovação obrigatória vencida só cobra e escala; nunca aprova nem executa.
  let approvalsEscalated = 0;
  let runIds: string[] = o.runId ? [o.runId] : [];
  if (!o.runId) {
    const { data } = await db.from("scenario_runs").select("id");
    runIds = (data ?? []).map((r) => r.id as string);
  }
  for (const id of runIds) approvalsEscalated += await escalateExpired(db, id);

  return { claimed: claimed.length, reports, approvalsEscalated };
}
