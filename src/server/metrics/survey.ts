// GOB-11 · Encerramento válido, pesquisa de satisfação, revisão de respostas negativas e registro de uso de IA.
// As regras valem no banco (close_case, record_survey_response, complete_survey_review). Aqui só se orquestra e se traduz erro.
// Nenhuma resposta de pesquisa muda política, alçada, timer, permissão ou modelo: gera revisão humana e, se um supervisor
// ou analista marcar, candidato ao conjunto fixo de avaliação de versões futuras.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallObservation, ModelAdapter } from "../ai/adapter.ts";
import { call } from "../queue/approvals.ts";

export interface CloseResult {
  closure_id: string; survey_id: string | null; seq: number; resolution_mode: "autonoma" | "assistida";
  already_closed: boolean; survey_requested: boolean; channel?: string;
}

/** Encerra o caso se o encerramento for válido e solicita UMA pesquisa. `actorId` nulo = encerramento autônomo da GoBIA. */
export const closeCase = (db: SupabaseClient, input: { caseId: string; actorId: string | null; note?: string }) =>
  call<CloseResult>(db, "close_case", { p_case: input.caseId, p_actor: input.actorId, p_note: input.note ?? null });

export interface SurveyResult { survey_id: string; reused: boolean; score: number; resolved: string; review_id?: string | null; reopened?: boolean }

export const answerSurvey = (db: SupabaseClient, input: { surveyId: string; score: number; resolved: "sim" | "parcialmente" | "nao"; comment?: string }) =>
  call<SurveyResult>(db, "record_survey_response", { p_survey: input.surveyId, p_score: input.score, p_resolved: input.resolved, p_comment: input.comment ?? null });

export const completeSurveyReview = (db: SupabaseClient, input: { reviewId: string; actorId: string; note?: string; area?: string | null; evalSet: boolean }) =>
  call<{ review_id: string; status: string; eval_set: boolean }>(db, "complete_survey_review",
    { p_review: input.reviewId, p_actor: input.actorId, p_note: input.note ?? null, p_area: input.area ?? null, p_eval_set: input.evalSet });

/**
 * Observador para `withBudget(adapter, budget, observer)`: grava cada chamada ao modelo em ai_usage.
 * Custo/tokens ausentes ficam NULOS (indisponível). Falha ao gravar o uso nunca derruba o atendimento.
 */
export function usageRecorder(db: SupabaseClient, ctx: { runId: string; caseId: string | null; adapter: Pick<ModelAdapter, "kind" | "id">; step: string; occurredAt: () => string; simulated?: boolean }) {
  const requestedDefault = ctx.adapter.id.includes(":") ? ctx.adapter.id.slice(ctx.adapter.id.indexOf(":") + 1) : ctx.adapter.id;
  return async (o: CallObservation): Promise<void> => {
    // Com roteamento (GOB-13) o modelo pedido é o da camada escolhida nesta tentativa.
    const requested = o.route?.model ?? requestedDefault;
    const { error } = await db.from("ai_usage").insert({
      scenario_run_id: ctx.runId, case_id: ctx.caseId, step: ctx.step, adapter_kind: ctx.adapter.kind,
      requested_model: requested, served_model: o.servedModel, prompt_tokens: o.usage.promptTokens, completion_tokens: o.usage.completionTokens,
      cost_usd: o.usage.costUsd, latency_ms: o.latencyMs, ok: o.ok, error_kind: o.errorKind, attempt: o.call, occurred_at: ctx.occurredAt(),
      tier: o.route?.tier ?? null, strategy: o.route?.strategy ?? null, route_reason: o.route?.reason ?? null, switched_from: o.route?.switchedFrom ?? null,
    });
    if (error) console.error(`ai_usage não gravado: ${error.message}`);
  };
}
