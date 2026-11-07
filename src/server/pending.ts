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
  /** Contexto para leitura rápida na tela. */
  customerName: string | null;
  channels: string[];
  summary: string | null;
  itemLabel: string | null;
}

export interface PendingView { clock: string; review: PendingRow[]; approvals: PendingRow[] }

type CaseRef = {
  assignee_name: string | null; summary: string | null; customer_id: string | null;
  case_conversations: { conversations: { channel: string } | null }[];
};

type Raw = {
  id: string; case_id: string; action: string; amount_cents: number | null; status: string; version: number; order_id: string | null;
  execute_after: string | null; approval_due_at: string | null; escalation_level: number; decision: { approvalRequired?: boolean } | null;
  cases: CaseRef | CaseRef[] | null;
  scheduled_tasks: { status: string; attempts: number; last_error: string | null }[] | null;
};

const OPEN_REVIEW = new Set(["em_janela_revisao", "suspensa", "pronta", "executando"]);

export async function listPending(db: SupabaseClient, runId: string): Promise<PendingView> {
  const clock = await scenarioClock(db, runId);
  const clockMs = Date.parse(clock);
  const { data, error } = await db.from("action_proposals")
    .select("id, case_id, action, amount_cents, status, version, order_id, execute_after, approval_due_at, escalation_level, decision, cases(assignee_name, summary, customer_id, case_conversations(conversations(channel))), scheduled_tasks(status, attempts, last_error)")
    .eq("scenario_run_id", runId).or("execute_after.not.is.null,status.eq.aguardando_aprovacao,status.eq.suspensa").order("created_at");
  if (error) throw new Error(`pendências: ${error.message}`);

  const raws = (data ?? []) as unknown as Raw[];
  const refOf = (p: Raw) => (Array.isArray(p.cases) ? p.cases[0] : p.cases) ?? null;
  const customerIds = [...new Set(raws.map((p) => refOf(p)?.customer_id).filter((v): v is string => !!v))];
  const orderIds = [...new Set(raws.map((p) => p.order_id).filter((v): v is string => !!v))];
  const [customers, lines] = await Promise.all([
    customerIds.length ? db.from("customers").select("customer_id, full_name").in("customer_id", customerIds) : Promise.resolve({ data: [], error: null }),
    orderIds.length ? db.from("order_items").select("order_id, description, line").in("order_id", orderIds).order("line") : Promise.resolve({ data: [], error: null }),
  ]);
  if (customers.error) throw new Error(`clientes: ${customers.error.message}`);
  if (lines.error) throw new Error(`itens: ${lines.error.message}`);
  const nameOf = new Map((customers.data ?? []).map((c) => [c.customer_id as string, (c.full_name as string | null) ?? null]));
  const itemsOf = new Map<string, string[]>();
  for (const l of lines.data ?? []) itemsOf.set(l.order_id as string, [...(itemsOf.get(l.order_id as string) ?? []), String(l.description ?? "").trim()].filter(Boolean));

  const review: PendingRow[] = [];
  const approvals: PendingRow[] = [];
  for (const p of raws) {
    const needsApproval = p.decision?.approvalRequired === true;
    const c = refOf(p);
    const its = p.order_id ? itemsOf.get(p.order_id) ?? [] : [];
    const task = p.scheduled_tasks?.length ? p.scheduled_tasks[p.scheduled_tasks.length - 1]! : null;
    const base: PendingRow = {
      proposalId: p.id, caseId: p.case_id, action: p.action, amountCents: p.amount_cents, status: p.status, version: p.version, orderId: p.order_id,
      assigneeName: c?.assignee_name ?? null, executeAfter: p.execute_after, approvalDueAt: p.approval_due_at, escalationLevel: p.escalation_level,
      remainingMs: null, countdown: null, task: task ? { status: task.status, attempts: task.attempts, lastError: task.last_error } : null,
      customerName: c?.customer_id ? nameOf.get(c.customer_id) ?? null : null,
      channels: [...new Set((c?.case_conversations ?? []).map((x) => x.conversations?.channel).filter((v): v is string => !!v))],
      summary: c?.summary ?? null,
      itemLabel: its.length ? `${its[0]}${its.length > 1 ? ` +${its.length - 1}` : ""}` : null,
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
