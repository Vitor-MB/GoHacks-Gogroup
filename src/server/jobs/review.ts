// GOB-10 · Janela opcional de revisão (duas horas, configuração proposta do MVP).
// Só ação que a política já permite executar sem aprovação entra na janela. Vencer a janela torna a ação elegível
// para a PRÓXIMA rodada do processador, que revalida antes de executar. Suspensão ou rejeição antes disso impede a execução.
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_REVIEW_WINDOW_HOURS, reviewWindowMessage } from "../execution/adapters.ts";
import { executeProposal, type ExecutionReport } from "../execution/execute.ts";
import { call, HumanDecisionError, loadProposal, reevaluate, type Deps } from "../queue/approvals.ts";

export { DEFAULT_REVIEW_WINDOW_HOURS, reviewWindowMessage };

export interface ScheduleResult { scheduled: boolean; duplicate: boolean; execute_after: string }

export const scheduleReviewWindow = (db: SupabaseClient, proposalId: string, action: string, hours = DEFAULT_REVIEW_WINDOW_HOURS) =>
  call<ScheduleResult>(db, "schedule_review_window", { p_proposal: proposalId, p_hours: hours, p_message: reviewWindowMessage(action, hours) });

export interface ReleaseOutcome {
  released: boolean;
  /** Já estava liberada/executando/concluída: nada novo foi decidido (a execução segue idempotente). */
  already: boolean;
  source: "vencimento" | "liberacao_antecipada" | null;
  execution?: ExecutionReport;
  blockers?: string[];
}

/**
 * Libera a janela e executa pelo caminho idempotente do GOB-08.
 * actorId nulo = vencimento (processador); com actorId = liberação antecipada por funcionário autorizado.
 * Antes de liberar, a decisão do GOB-06 é recalculada com fatos de agora; se deixou de ser executável, não executa.
 */
export async function releaseReviewWindow(
  db: SupabaseClient, runId: string, a: { proposalId: string; actorId: string | null; note?: string }, deps: Deps,
): Promise<ReleaseOutcome> {
  const p = await loadProposal(db, a.proposalId);
  if (p.status === "pronta" || p.status === "executando" || p.status === "concluida") {
    // Já revalidada na liberação anterior: só garante a execução idempotente (retomada após falha ou timeout).
    const execution = deps.adapter ? await executeProposal(db, runId, a.proposalId, deps.adapter, deps.exec) : undefined;
    return { released: true, already: true, source: null, execution };
  }
  if (p.status !== "em_janela_revisao" && p.status !== "suspensa") {
    throw new HumanDecisionError("estado_invalido", `proposta em ${p.status} não está em janela de revisão`);
  }
  const decision = await reevaluate(db, runId, p, deps, null, p.amount_cents);
  const rel = await call<{ released: boolean; already: boolean; source: ReleaseOutcome["source"] }>(db, "release_review_window", {
    p_proposal: a.proposalId, p_actor: a.actorId, p_revalidation: decision, p_note: a.note ?? null,
  });
  if (!rel.released) return { released: false, already: false, source: rel.source, blockers: decision.blockers };
  const execution = deps.adapter ? await executeProposal(db, runId, a.proposalId, deps.adapter, deps.exec) : undefined;
  return { released: true, already: rel.already, source: rel.source, execution };
}
