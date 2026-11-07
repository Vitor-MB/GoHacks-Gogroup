// GOB-10 · Visão de auditoria de pendências: revisão opcional (janela de duas horas) e aprovação obrigatória, em separado.
// Use o cliente da sessão: a RLS aplica o escopo do funcionário. A contagem usa o relógio do cenário.
import type { SupabaseClient } from "@supabase/supabase-js";
import { countdownLabel } from "./jobs/countdown.ts";
import { scenarioClock } from "./queries.ts";

export interface PendingRow {
  proposalId: string;
  caseId: string;
  action: string;
  amountCents: number | null;
  status: string;
  version: number;
  orderId: string | null;
  assigneeName: string | null;
  executeAfter: string | null;
  approvalDueAt: string | null;
  escalationLevel: number;
  /** Só para janela aberta ou aprovação aguardando: prazo − relógio do cenário. */
  remainingMs: number | null;
  countdown: string | null;
  task: { status: string; attempts: number; lastError: string | null } | null;
}

export interface PendingView { clock: string; review: PendingRow[]; approvals: PendingRow[] }

type Raw = {
  id: string; case_id: string; action: string; amount_cents: number | null; status: string; version: number; order_id: string | null;
  execute_after: string | null; approval_due_at: string | null; escalation_level: number; decision: { approvalRequired?: boolean } | null;
  cases: { assignee_name: string | null } | { assignee_name: string | null }[] | null;
  scheduled_tasks: { status: string; attempts: number; last_error: string | null }[] | null;
};

const OPEN_REVIEW = new Set(["em_janela_revisao", "suspensa", "pronta", "executando"]);

export async function listPending(db: SupabaseClient, runId: string): Promise<PendingView> {
  const clock = await scenarioClock(db, runId);
  const clockMs = Date.parse(clock);
  const { data, error } = await db.from("action_proposals")
    .select("id, case_id, action, amount_cents, status, version, order_id, execute_after, approval_due_at, escalation_level, decision, cases(assignee_name), scheduled_tasks(status, attempts, last_error)")
    .eq("scenario_run_id", runId).or("execute_after.not.is.null,status.eq.aguardando_aprovacao,status.eq.suspensa").order("created_at");
  if (error) throw new Error(`pendências: ${error.message}`);

  const review: PendingRow[] = [];
  const approvals: PendingRow[] = [];
  for (const p of (data ?? []) as unknown as Raw[]) {
    const needsApproval = p.decision?.approvalRequired === true;
    const c = Array.isArray(p.cases) ? p.cases[0] : p.cases;
    const task = p.scheduled_tasks?.length ? p.scheduled_tasks[p.scheduled_tasks.length - 1]! : null;
    const base: PendingRow = {
      proposalId: p.id, caseId: p.case_id, action: p.action, amountCents: p.amount_cents, status: p.status, version: p.version, orderId: p.order_id,
      assigneeName: c?.assignee_name ?? null, executeAfter: p.execute_after, approvalDueAt: p.approval_due_at, escalationLevel: p.escalation_level,
      remainingMs: null, countdown: null, task: task ? { status: task.status, attempts: task.attempts, lastError: task.last_error } : null,
    };
    if (needsApproval) {
      if (p.status === "aguardando_aprovacao" || p.status === "suspensa") {
        const remaining = p.approval_due_at ? Date.parse(p.approval_due_at) - clockMs : null;
        approvals.push({ ...base, remainingMs: remaining, countdown: remaining === null ? null : remaining > 0 ? countdownLabel(remaining) : "prazo vencido — a decisão continua com o supervisor" });
      }
    } else if (p.execute_after) {
      const open = p.status === "em_janela_revisao";
      const remaining = open ? Date.parse(p.execute_after) - clockMs : null;
      review.push({ ...base, remainingMs: remaining, countdown: remaining === null ? null : countdownLabel(remaining) });
    }
  }
  // Janelas abertas primeiro (mais próximas do vencimento), depois o histórico recente.
  review.sort((a, b) => Number(OPEN_REVIEW.has(b.status)) - Number(OPEN_REVIEW.has(a.status)) || (a.executeAfter ?? "").localeCompare(b.executeAfter ?? ""));
  return { clock, review, approvals };
}
