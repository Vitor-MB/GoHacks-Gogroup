// GOB-09 · Operação humana da fila: atribuição, ajuste de valor, aprovação, rejeição e suspensão.
// Quem é o funcionário vem da sessão validada no servidor (nunca de formulário). As regras valem no banco
// (assert_staff_on_case, decide_proposal, release_proposal): este módulo só orquestra e traduz erros.
// Aprovar NÃO executa sozinho: a aprovação é registrada, a decisão do GOB-06 é recalculada com fatos atuais e só
// então a proposta é liberada e executada pelo caminho idempotente do GOB-08.
import type { SupabaseClient } from "@supabase/supabase-js";
import { factsFromEvidence } from "../ai/facts.ts";
import { executeProposal, proposalKey, type ExecuteOptions, type ExecutionReport } from "../execution/execute.ts";
import type { ActionAdapter } from "../execution/adapters.ts";
import { decide, type Action, type ApprovalRecord, type Category, type Decision, type PolicyParams, type Role, type VerifiedFacts } from "../policy/decision.ts";
import { getOrderEvidence, getProductionEvidence, getTrackingEvidence, scenarioClock } from "../queries.ts";
import { saoPauloDate } from "../evidence.ts";

export type HumanErrorCode =
  | "nao_autorizado" | "nao_encontrado" | "fora_do_escopo" | "papel_insuficiente" | "autoaprovacao"
  | "versao_desatualizada" | "estado_invalido" | "sem_aprovacao_valida" | "sem_mudanca" | "erro";

export class HumanDecisionError extends Error {
  code: HumanErrorCode;
  constructor(code: HumanErrorCode, message: string) {
    super(message);
    this.name = "HumanDecisionError";
    this.code = code;
  }
}

const CODES: ReadonlySet<string> = new Set(["nao_autorizado", "nao_encontrado", "fora_do_escopo", "papel_insuficiente", "autoaprovacao",
  "versao_desatualizada", "estado_invalido", "sem_aprovacao_valida", "sem_mudanca"]);

export async function call<T>(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    const m = /^([a-z_]+): ([\s\S]*)$/.exec(error.message);
    if (m && CODES.has(m[1]!)) throw new HumanDecisionError(m[1] as HumanErrorCode, m[2]!);
    throw new HumanDecisionError("erro", `${fn}: ${error.message}`);
  }
  return data as T;
}

export interface Deps {
  params: PolicyParams;
  /** Fatos atuais do pedido (padrão: consultas estruturadas do GOB-05). Injetável em testes. */
  loadFacts?: (orderId: string) => Promise<VerifiedFacts | null>;
  adapter?: ActionAdapter;
  exec?: ExecuteOptions;
}

/** Fatos atuais do banco. O que o banco não informa (preferência, suspeita) vem do snapshot gravado na proposta. */
export async function loadFactsFromDb(db: SupabaseClient, runId: string, orderId: string, snapshot?: Partial<VerifiedFacts> | null): Promise<VerifiedFacts | null> {
  const [order, tracking, production] = await Promise.all([
    getOrderEvidence(db, runId, orderId), getTrackingEvidence(db, runId, orderId), getProductionEvidence(db, runId, orderId),
  ]);
  return factsFromEvidence(orderId, order, tracking, production, {
    suspicionPending: snapshot?.suspicionPending ?? false, customerPreference: snapshot?.customerPreference ?? null,
  });
}

export interface ProposalRow {
  id: string; case_id: string; order_id: string; action: string; category: string; amount_cents: number | null;
  version: number; status: string; requested_by: string | null; facts_snapshot: Partial<VerifiedFacts> | null;
}

export async function loadProposal(db: SupabaseClient, id: string): Promise<ProposalRow> {
  const { data, error } = await db.from("action_proposals")
    .select("id, case_id, order_id, action, category, amount_cents, version, status, requested_by, facts_snapshot").eq("id", id).maybeSingle();
  if (error) throw new HumanDecisionError("erro", `proposta: ${error.message}`);
  if (!data) throw new HumanDecisionError("nao_encontrado", "proposta inexistente");
  return data as ProposalRow;
}

async function roleOf(db: SupabaseClient, staffId: string | null): Promise<Role> {
  if (!staffId) return "atendente"; // propostas da GoBIA seguem a alçada do atendente
  const { data } = await db.from("staff").select("role").eq("id", staffId).maybeSingle();
  return ((data?.role as Role | undefined) ?? "atendente");
}

/** Decisão do GOB-06 recalculada AGORA, com fatos atuais e (opcionalmente) a aprovação registrada. */
export async function reevaluate(
  db: SupabaseClient, runId: string, p: ProposalRow, deps: Deps, approval: ApprovalRecord | null, requestedCents: number | null,
): Promise<Decision> {
  const facts = await (deps.loadFacts ? deps.loadFacts(p.order_id) : loadFactsFromDb(db, runId, p.order_id, p.facts_snapshot));
  const merged = facts && p.facts_snapshot
    ? { ...facts, customerPreference: facts.customerPreference ?? p.facts_snapshot.customerPreference ?? null,
        suspicionPending: facts.suspicionPending || (p.facts_snapshot.suspicionPending ?? false) }
    : facts;
  if (!merged) {
    // Sem fatos atuais não há como confirmar: nunca executa.
    return { mode: "execucao", eligible: false, executable: false, approvalRequired: true, approvalValid: false, reviewWindowAllowed: false,
      amountCents: requestedCents, stage: "indeterminado", businessDaysLate: null, businessDaysStalled: null, reasons: [],
      blockers: ["fatos atuais do pedido indisponíveis"], warnings: [], handoff: null, policyVersion: deps.params.version };
  }
  const asOf = saoPauloDate(await scenarioClock(db, runId));
  return decide({
    asOf, category: p.category as Category, action: p.action as Action, requestedCents, facts: merged,
    actor: { id: p.requested_by ?? "gobia", role: await roleOf(db, p.requested_by) }, approval, params: deps.params,
  });
}

// ---------------------------------------------------------------------------
// Atribuição
// ---------------------------------------------------------------------------
export const assignCase = (db: SupabaseClient, a: { caseId: string; actorId: string; assigneeId: string; note?: string }) =>
  call<{ assigned_to: string; assignee_name: string }>(db, "assign_case", {
    p_case: a.caseId, p_actor: a.actorId, p_assignee: a.assigneeId, p_note: a.note ?? null,
  });

// ---------------------------------------------------------------------------
// Ajuste de valor (mudança material): nova versão, aprovação anterior invalidada
// ---------------------------------------------------------------------------
export async function adjustProposalAmount(
  db: SupabaseClient, runId: string, a: { proposalId: string; actorId: string; newAmountCents: number; note?: string }, deps: Deps,
): Promise<{ version: number; status: string; approvals_invalidated: number; decision: Decision }> {
  const p = await loadProposal(db, a.proposalId);
  if (!Number.isInteger(a.newAmountCents) || a.newAmountCents <= 0) throw new HumanDecisionError("estado_invalido", "valor inválido");
  const decision = await reevaluate(db, runId, p, deps, null, a.newAmountCents);
  const status =
    !decision.eligible || decision.blockers.some((b) => !/aprova/i.test(b)) ? "bloqueada"
    : decision.approvalRequired ? "aguardando_aprovacao"
    : "pronta";
  const key = proposalKey(p.case_id, p.order_id, p.action, decision.amountCents);
  const res = await call<{ version: number; status: string; approvals_invalidated: number }>(db, "adjust_proposal", {
    p_proposal: a.proposalId, p_actor: a.actorId, p_new_amount: a.newAmountCents, p_new_key: key, p_new_status: status,
    p_decision: decision, p_justification: [...decision.reasons, ...decision.blockers.map((b) => `bloqueio: ${b}`)], p_note: a.note ?? null,
  });
  return { ...res, decision };
}

// ---------------------------------------------------------------------------
// Decisão: aprovar (com revalidação e retomada), rejeitar, suspender
// ---------------------------------------------------------------------------
export interface DecisionOutcome {
  decision: "aprovada" | "rejeitada" | "suspensa";
  /** Aprovação registrada mas a revalidação não confirmou a execução. */
  released: boolean;
  proposalStatus: string;
  execution?: ExecutionReport;
  blockers?: string[];
}

export async function decideProposal(
  db: SupabaseClient, runId: string,
  a: { proposalId: string; actorId: string; decision: "aprovada" | "rejeitada" | "suspensa"; version: number; note?: string },
  deps: Deps,
): Promise<DecisionOutcome> {
  const res = await call<{ approval_id?: string; status?: string }>(db, "decide_proposal", {
    p_proposal: a.proposalId, p_actor: a.actorId, p_decision: a.decision, p_version: a.version, p_note: a.note ?? null,
  });
  if (a.decision !== "aprovada") return { decision: a.decision, released: false, proposalStatus: res.status ?? a.decision };

  // Revalida com os fatos de agora e a aprovação registrada (ação, pedido e valor vinculados à versão).
  const p = await loadProposal(db, a.proposalId);
  const { data: ap, error } = await db.from("proposal_approvals")
    .select("decided_by, decided_role, order_id, action, amount_cents")
    .eq("proposal_id", a.proposalId).eq("decision", "aprovada").is("superseded_at", null).maybeSingle();
  if (error) throw new HumanDecisionError("erro", `aprovação: ${error.message}`);
  if (!ap) throw new HumanDecisionError("sem_aprovacao_valida", "não há aprovação vigente");

  const decision = await reevaluate(db, runId, p, deps, {
    status: "aprovada", approverId: ap.decided_by as string, approverRole: ap.decided_role as Role, orderId: ap.order_id as string,
    action: ap.action as Action, amountCents: ap.amount_cents as number,
  }, p.amount_cents);

  const rel = await call<{ released: boolean }>(db, "release_proposal", { p_proposal: a.proposalId, p_revalidation: decision });
  if (!rel.released) {
    return { decision: "aprovada", released: false, proposalStatus: "bloqueada", blockers: decision.blockers };
  }
  if (!deps.adapter) return { decision: "aprovada", released: true, proposalStatus: "pronta" };
  const execution = await executeProposal(db, runId, a.proposalId, deps.adapter, deps.exec);
  return { decision: "aprovada", released: true, proposalStatus: execution.state === "concluida" || execution.state === "reuso" ? "concluida" : "pronta", execution };
}

/** Cobra e escala aprovações vencidas. Nunca aprova. */
export const escalateExpired = (db: SupabaseClient, runId: string, nextHours = 24) =>
  call<number>(db, "escalate_expired_approvals", { p_run: runId, p_next_hours: nextHours });
