// GOB-04/09 · Fila e detalhe do caso. Use sempre o cliente da sessão: a RLS aplica o escopo do funcionário.
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPublicChannel, type Channel, type Source } from "./intake.ts";
import { priorityOf, type Priority } from "./queue/priority.ts";
import { countdownLabel } from "./jobs/countdown.ts";
import { scenarioClock } from "./queries.ts";

export interface PendingProposal {
  id: string;
  action: string;
  amountCents: number | null;
  status: string;
  version: number;
  approvalDueAt: string | null;
  escalationLevel: number;
  overdue: boolean;
}

export interface QueueItem {
  id: string;
  status: string;
  topic: string;
  summary: string | null;
  clarification: string | null;
  orderId: string | null;
  customerId: string | null;
  brandId: string | null;
  /** Abertura do contato mais antigo, no relógio do cenário (base da espera). */
  openedAt: string;
  channels: Channel[];
  conversations: number;
  updatedAt: string;
  assignedTo: string | null;
  assigneeName: string | null;
  handoffReason: string | null;
  handoffTeam: string | null;
  decisionRequested: string | null;
  proposal: PendingProposal | null;
  priority: Priority;
}

export interface DetailProposal extends PendingProposal {
  category: string;
  orderId: string | null;
  justification: string[];
  evidence: string[];
  policyVersion: string | null;
  origin: { hypothesis?: string; status?: string; summary?: string; evidenceRefs?: string[] } | null;
  approvalRequired: boolean;
  /** GOB-10: fim da janela de revisão (relógio do cenário) e a contagem; nulos fora da janela aberta. */
  executeAfter: string | null;
  reviewCountdown: string | null;
  requestedBy: string | null;
  proposedBy: string;
  executionRef: string | null;
  executionResult: unknown;
  approvals: { id: string; version: number; decision: string; role: string; decidedByName: string | null; amountCents: number | null; note: string | null; decidedAt: string; supersededReason: string | null }[];
}

export interface CaseDetail extends QueueItem {
  customerId: string | null;
  businessUnitId: string | null;
  sources: Source[];
  order: { totalCents: number | null; items: { sku: string | null; description: string | null; quantity: number }[] } | null;
  proposals: DetailProposal[];
  notifications: { id: string; kind: string; title: string; body: string; createdAt: string }[];
  timeline: { id: number; type: string; actorType: string; actorId: string | null; at: string | null; data: Record<string, unknown> }[];
  conversationsDetail: {
    conversationId: string;
    channel: Channel;
    externalId: string | null;
    public: boolean;
    messages: { id: string; author: string; sentAt: string; body: string | null }[];
  }[];
}

type ProposalRow = {
  id: string; action: string; amount_cents: number | null; status: string; version: number;
  approval_due_at: string | null; escalation_level: number; created_at?: string;
};

type CaseRow = {
  id: string; status: string; topic: string; summary: string | null; clarification: string | null;
  order_id: string | null; brand_id: string | null; customer_id?: string | null; business_unit_id?: string | null;
  updated_at: string; sources?: Source[];
  assigned_to: string | null; assignee_name: string | null; handoff_reason: string | null; handoff_team: string | null;
  decision_requested: string | null;
  case_conversations: { conversations: { conversation_id: string; channel: Channel; opened_at: string } | null }[];
  action_proposals: ProposalRow[];
};

// Proposta que ainda pede atenção: a mais recente que não terminou nem foi descartada.
const OPEN_PROPOSAL = new Set(["aguardando_aprovacao", "suspensa", "bloqueada", "pronta", "em_janela_revisao", "executando", "falhou"]);

function pendingOf(rows: ProposalRow[], clockMs: number): PendingProposal | null {
  const r = [...rows].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "")).reverse().find((x) => OPEN_PROPOSAL.has(x.status));
  if (!r) return null;
  const overdue = r.status === "aguardando_aprovacao" && !!r.approval_due_at && Date.parse(r.approval_due_at) <= clockMs;
  return { id: r.id, action: r.action, amountCents: r.amount_cents, status: r.status, version: r.version,
    approvalDueAt: r.approval_due_at, escalationLevel: r.escalation_level, overdue };
}

function toItem(row: CaseRow, clockMs: number): QueueItem {
  const convs = row.case_conversations.map((c) => c.conversations).filter((c): c is NonNullable<typeof c> => !!c);
  const opened = Math.min(...convs.map((c) => Date.parse(c.opened_at)).filter(Number.isFinite), clockMs);
  const proposal = pendingOf(row.action_proposals ?? [], clockMs);
  return {
    id: row.id, status: row.status, topic: row.topic, summary: row.summary, clarification: row.clarification,
    orderId: row.order_id, customerId: row.customer_id ?? null, brandId: row.brand_id, openedAt: new Date(opened).toISOString(), channels: [...new Set(convs.map((c) => c.channel))],
    conversations: convs.length, updatedAt: row.updated_at,
    assignedTo: row.assigned_to, assigneeName: row.assignee_name, handoffReason: row.handoff_reason, handoffTeam: row.handoff_team,
    decisionRequested: row.decision_requested, proposal,
    priority: priorityOf({
      topic: row.topic, status: row.status, ageHours: Math.max(0, (clockMs - opened) / 3600_000),
      clarificationPending: !!row.clarification, assigned: !!row.assigned_to, handoffReason: row.handoff_reason,
      proposal: proposal ? { status: proposal.status, amountCents: proposal.amountCents, escalationLevel: proposal.escalationLevel, overdue: proposal.overdue } : null,
    }),
  };
}

const CASE_COLUMNS = "id, status, topic, summary, clarification, order_id, customer_id, brand_id, updated_at, assigned_to, assignee_name, handoff_reason, handoff_team, decision_requested, case_conversations(conversations(conversation_id, channel, opened_at)), action_proposals(id, action, amount_cents, status, version, approval_due_at, escalation_level, created_at)";

export interface QueueFilters {
  canal?: Channel;
  situacao?: string;
  /** "eu" | "sem" | id do funcionário */
  responsavel?: string;
  /** "vencido" (aprovação com prazo vencido) | "em_prazo" */
  prazo?: string;
  motivo?: string;
}

export function filterQueue(items: QueueItem[], f: QueueFilters, staffId: string): QueueItem[] {
  return items.filter((c) =>
    (!f.canal || c.channels.includes(f.canal))
    && (!f.situacao || c.status === f.situacao)
    && (!f.responsavel || (f.responsavel === "eu" ? c.assignedTo === staffId : f.responsavel === "sem" ? !c.assignedTo : c.assignedTo === f.responsavel))
    && (!f.prazo || (f.prazo === "vencido" ? !!c.proposal?.overdue : !!c.proposal && !c.proposal.overdue && c.proposal.status === "aguardando_aprovacao"))
    && (!f.motivo || c.handoffReason === f.motivo));
}

/** Mais urgente primeiro; empate pelo mais antigo atualizado. */
export const byPriority = (a: QueueItem, b: QueueItem) => b.priority.score - a.priority.score || a.updatedAt.localeCompare(b.updatedAt);

export async function listQueue(db: SupabaseClient, runId: string): Promise<QueueItem[]> {
  const clockMs = Date.parse(await scenarioClock(db, runId));
  const { data, error } = await db
    .from("cases")
    .select(CASE_COLUMNS)
    .eq("scenario_run_id", runId)
    .neq("status", "resolvido")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`fila: ${error.message}`);
  return (data as unknown as CaseRow[]).map((r) => toItem(r, clockMs)).sort(byPriority);
}

export async function getCaseDetail(db: SupabaseClient, id: string): Promise<CaseDetail | null> {
  const { data, error } = await db
    .from("cases")
    .select(`${CASE_COLUMNS}, business_unit_id, sources, scenario_run_id`)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`caso: ${error.message}`);
  if (!data) return null;
  const row = data as unknown as CaseRow & { scenario_run_id: string };
  const clockMs = Date.parse(await scenarioClock(db, row.scenario_run_id));

  const ids = row.case_conversations.map((c) => c.conversations?.conversation_id).filter((v): v is string => !!v);
  const { data: convRows, error: cErr } = await db
    .from("conversations").select("conversation_id, channel, external_id, opened_at, messages(message_id, author, sent_at, body)")
    .in("conversation_id", ids.length ? ids : ["-"]).order("opened_at");
  if (cErr) throw new Error(`conversas: ${cErr.message}`);

  // Pedido e produto (RLS herdada do pedido).
  let order: CaseDetail["order"] = null;
  if (row.order_id) {
    const [o, items] = await Promise.all([
      db.from("orders").select("total_cents").eq("order_id", row.order_id).maybeSingle(),
      db.from("order_items").select("sku, description, quantity").eq("order_id", row.order_id).order("line"),
    ]);
    if (o.error) throw new Error(`pedido: ${o.error.message}`);
    if (items.error) throw new Error(`itens: ${items.error.message}`);
    if (o.data) order = { totalCents: (o.data.total_cents as number | null) ?? null, items: (items.data ?? []) as NonNullable<CaseDetail["order"]>["items"] };
  }

  const [props, notifs, audit] = await Promise.all([
    db.from("action_proposals")
      .select("id, action, category, order_id, amount_cents, status, version, approval_due_at, execute_after, escalation_level, justification, evidence, policy_version, origin, decision, requested_by, proposed_by, created_at, action_executions(external_ref, result), proposal_approvals(id, proposal_version, decision, decided_role, decided_by, amount_cents, note, decided_at, superseded_reason)")
      .eq("case_id", id).order("created_at"),
    db.from("internal_notifications").select("id, kind, title, body, created_at").eq("case_id", id).order("created_at", { ascending: false }).limit(20),
    db.from("audit_events").select("id, event_type, actor_type, actor_id, scenario_at, data").eq("case_id", id).order("id"),
  ]);
  for (const [name, r] of [["propostas", props], ["notificações", notifs], ["auditoria", audit]] as const) {
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
  }

  type PropFull = ProposalRow & {
    execute_after: string | null;
    category: string; order_id: string | null; justification: string[]; evidence: string[]; policy_version: string | null;
    origin: DetailProposal["origin"]; decision: { approvalRequired?: boolean } | null; requested_by: string | null; proposed_by: string;
    action_executions: { external_ref: string | null; result: unknown }[] | { external_ref: string | null; result: unknown } | null;
    proposal_approvals: { id: string; proposal_version: number; decision: string; decided_role: string; decided_by: string; amount_cents: number | null; note: string | null; decided_at: string; superseded_reason: string | null }[];
  };
  const proposals: DetailProposal[] = ((props.data ?? []) as unknown as PropFull[]).map((p) => {
    const exec = Array.isArray(p.action_executions) ? p.action_executions[0] : p.action_executions;
    const overdue = p.status === "aguardando_aprovacao" && !!p.approval_due_at && Date.parse(p.approval_due_at) <= clockMs;
    return {
      id: p.id, action: p.action, amountCents: p.amount_cents, status: p.status, version: p.version, approvalDueAt: p.approval_due_at,
      escalationLevel: p.escalation_level, overdue, category: p.category, orderId: p.order_id,
      justification: p.justification ?? [], evidence: p.evidence ?? [], policyVersion: p.policy_version, origin: p.origin,
      approvalRequired: p.decision?.approvalRequired === true,
      executeAfter: p.execute_after,
      reviewCountdown: p.execute_after && p.status === "em_janela_revisao" ? countdownLabel(Date.parse(p.execute_after) - clockMs) : null,
      requestedBy: p.requested_by, proposedBy: p.proposed_by,
      executionRef: exec?.external_ref ?? null, executionResult: exec?.result ?? null,
      approvals: (p.proposal_approvals ?? []).sort((a, b) => a.decided_at.localeCompare(b.decided_at)).map((a) => ({
        id: a.id, version: a.proposal_version, decision: a.decision, role: a.decided_role, decidedByName: null, amountCents: a.amount_cents,
        note: a.note, decidedAt: a.decided_at, supersededReason: a.superseded_reason,
      })),
    };
  });

  type Conv = { conversation_id: string; channel: Channel; external_id: string | null; messages: { message_id: string; author: string; sent_at: string; body: string | null }[] };
  return {
    ...toItem(row, clockMs),
    customerId: row.customer_id ?? null,
    businessUnitId: row.business_unit_id ?? null,
    sources: row.sources ?? [],
    order,
    proposals,
    notifications: (notifs.data ?? []).map((n) => ({ id: n.id as string, kind: n.kind as string, title: n.title as string, body: n.body as string, createdAt: n.created_at as string })),
    timeline: (audit.data ?? []).map((a) => ({ id: a.id as number, type: a.event_type as string, actorType: a.actor_type as string, actorId: a.actor_id as string | null, at: a.scenario_at as string | null, data: (a.data ?? {}) as Record<string, unknown> })),
    conversationsDetail: (convRows as unknown as Conv[]).map((c) => ({
      conversationId: c.conversation_id,
      channel: c.channel,
      externalId: c.external_id,
      public: isPublicChannel(c.channel),
      messages: [...c.messages].sort((a, b) => a.sent_at.localeCompare(b.sent_at))
        .map((m) => ({ id: m.message_id, author: m.author, sentAt: m.sent_at, body: m.body })),
    })),
  };
}
