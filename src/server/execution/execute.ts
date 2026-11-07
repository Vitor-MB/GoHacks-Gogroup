// GOB-08 · Persistência da investigação, proposta e execução idempotente.
// A IA propõe (GOB-07) e o GOB-06 valida; aqui só se grava e executa o que o servidor deixou "pronta".
// Mensagem ao cliente só nasce, no outbox, na mesma transação que grava o resultado confirmado do adaptador.
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { InvestigationOutcome } from "../ai/investigate.ts";
import type { VerifiedFacts } from "../policy/decision.ts";
import { AdapterFailure, composeNotification, reviewWindowMessage, type ActionAdapter, type AdapterSuccess, type ExecutionRequest } from "./adapters.ts";

/** Mesma proposta (caso, pedido, ação e valor) = mesma chave: reprocessar devolve o registro existente. */
export const proposalKey = (caseId: string, orderId: string, action: string, amountCents: number | null): string =>
  createHash("sha256").update(`${caseId}|${orderId}|${action}|${amountCents ?? ""}`).digest("hex");

type ProposalStatus = "pronta" | "aguardando_aprovacao" | "bloqueada" | "em_janela_revisao";
type BaseStatus = "pronta" | "aguardando_aprovacao" | "bloqueada";

/** Só vira proposta persistida o que o GOB-06 avaliou como execução; o restante fica na auditoria. */
export function proposalStatusFor(o: InvestigationOutcome): BaseStatus | null {
  const action = o.proposal?.action;
  if (!action || action === "informar_status" || !o.decision || o.decision.mode !== "execucao") return null;
  if (o.status === "proposta_validada") return "pronta";
  if (o.status === "aguardando_aprovacao") return "aguardando_aprovacao";
  if (o.status === "bloqueada") return "bloqueada";
  return null;
}

const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

export interface RecordResult { proposalId: string | null; status: ProposalStatus | null; duplicate: boolean }

/** Grava a investigação na trilha e, quando houver ação avaliada, a proposta com justificativa, política e evidências. */
export interface RecordOptions {
  /** Fatos verificados usados na decisão: a revalidação pós-aprovação reaproveita o que o banco não informa. */
  facts?: VerifiedFacts;
  /** Funcionário que pediu a proposta (nunca pode aprová-la). Ausente = proposta da GoBIA. */
  requestedBy?: string;
  /** Prazo para a decisão do supervisor, em horas do relógio do cenário (premissa do MVP; a política não define). */
  approvalDueHours?: number;
  /** GOB-10: com valor, ação elegível ao timer entra na janela de revisão (execute_after) em vez de ficar pronta. Ausente = sem janela. */
  reviewWindowHours?: number;
}

const brl = (c: number) => `R$ ${(c / 100).toFixed(2).replace(".", ",")}`;
const ACTION_LABEL: Record<string, string> = {
  reembolsar: "reembolso", reenviar_produto: "reenvio", reimprimir_personalizacao: "reimpressão",
  trocar_produto: "troca", cancelar_pedido: "cancelamento", abrir_chamado_transportadora: "chamado à transportadora",
};

/** Encaminhamento persistido (motivo, equipe, decisão solicitada e notificação interna). Não cria pendência para o que a GoBIA resolve sozinha. */
function handoffFor(o: InvestigationOutcome, proposalId: string | null, dueHours: number): Record<string, unknown> | null {
  const d = o.decision;
  const label = ACTION_LABEL[o.proposal?.action ?? ""] ?? "ação";
  switch (o.status) {
    case "aguardando_aprovacao":
      return {
        reason: "aprovacao_supervisor", team: "supervisor", target_role: "supervisor", proposal_id: proposalId, approval_due_hours: dueHours,
        title: "Aprovação do supervisor necessária",
        decision_requested: `Aprovar ou rejeitar ${label}${d?.amountCents ? ` de ${brl(d.amountCents)}` : ""}, acima da alçada`,
        body: (d?.reasons ?? []).join(" · "),
      };
    case "orientacao":
      return {
        reason: "orientacao_e_encaminhamento", team: o.handoff?.team ?? "atendimento", target_role: o.handoff?.team === "supervisor" ? "supervisor" : undefined,
        title: "Caso encaminhado com orientação",
        decision_requested: o.handoff?.guidance ?? "Orientar o cliente e acompanhar o encaminhamento",
        body: [...o.humanActions, o.handoff?.guidance].filter(Boolean).join(" · "),
      };
    case "bloqueada":
      return {
        reason: "acao_bloqueada", team: "atendimento", proposal_id: proposalId, title: "Ação bloqueada pela política",
        decision_requested: "Resolver o bloqueio antes de qualquer ação", body: (d?.blockers ?? []).join(" · "),
      };
    case "continuidade_humana":
      return {
        reason: "continuidade_humana", team: "atendimento", title: "A GoBIA não concluiu a investigação",
        decision_requested: "Assumir o atendimento e revisar as evidências", body: o.warnings.join(" · ") || "Falha ou indisponibilidade na investigação",
      };
    default:
      return null;
  }
}

export async function recordInvestigation(
  db: SupabaseClient, runId: string, caseId: string, orderId: string | null, outcome: InvestigationOutcome,
  opts: RecordOptions = {},
): Promise<RecordResult> {
  const status = proposalStatusFor(outcome);
  let rec: RecordResult = { proposalId: null, status: null, duplicate: false };

  if (status && outcome.decision && outcome.proposal?.action && orderId) {
    const d = outcome.decision;
    const data = must(await db.rpc("record_proposal", {
      p_run: runId, p_case: caseId,
      p: {
        action: outcome.proposal.action, category: outcome.category, order_id: orderId, amount_cents: d.amountCents,
        status, idempotency_key: proposalKey(caseId, orderId, outcome.proposal.action, d.amountCents),
        justification: [...d.reasons, ...d.blockers.map((b) => `bloqueio: ${b}`)],
        evidence: outcome.evidenceRefs, policy_version: d.policyVersion, decision: d, origin: outcome.origin,
        proposed_by: `gobia:${outcome.adapter}`,
        ...(opts.requestedBy ? { requested_by: opts.requestedBy } : {}), ...(opts.facts ? { facts: opts.facts } : {}),
      },
    }), "registrar proposta") as { proposal_id: string; status: BaseStatus; duplicate: boolean };
    rec = { proposalId: data.proposal_id, status: data.status, duplicate: data.duplicate };
    // Janela de revisão só para ação já autorizada pela política; a mensagem ao cliente nasce junto com a programação registrada.
    if (opts.reviewWindowHours && data.status === "pronta" && !data.duplicate && d.reviewWindowAllowed && !d.approvalRequired) {
      must(await db.rpc("schedule_review_window", {
        p_proposal: data.proposal_id, p_hours: opts.reviewWindowHours, p_message: reviewWindowMessage(outcome.proposal.action, opts.reviewWindowHours),
      }), "agendar janela de revisão");
      rec = { ...rec, status: "em_janela_revisao" };
    }
  }

  must(await db.rpc("append_audit", {
    p_run: runId, p_case: caseId, p_proposal: rec.proposalId, p_type: "investigacao_concluida", p_actor_type: "gobia",
    p_actor_id: outcome.adapter,
    p_data: {
      status: outcome.status, category: outcome.category, steps: outcome.steps, origin: outcome.origin,
      evidence: outcome.evidenceRefs, handoff: outcome.handoff, human_actions: outcome.humanActions,
      warnings: outcome.warnings, proposal_status: rec.status, proposal_duplicate: rec.duplicate,
    },
    p_correlation: rec.proposalId ? `proposta:${rec.proposalId}` : `caso:${caseId}`,
  }), "auditar investigação");

  const handoff = handoffFor(outcome, rec.proposalId, opts.approvalDueHours ?? 24);
  if (handoff) must(await db.rpc("create_handoff", { p_run: runId, p_case: caseId, p: handoff }), "encaminhar para atendimento humano");
  return rec;
}

export type ExecutionState = "concluida" | "reuso" | "falhou" | "em_andamento";

export interface ExecutionReport {
  state: ExecutionState;
  attempts: number;
  externalRef?: string;
  result?: unknown;
  error?: string;
}

export interface ExecuteOptions {
  maxAttempts?: number;
  /** Espera entre tentativas transitórias, em ms (cresce ×2). Injetável para testes. */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type Begin = { mode: "run" | "reuse" | "reconcile" | "busy" | "failed"; execution_id: string; attempt: number; external_ref?: string; result?: unknown; error?: string };

export async function executeProposal(
  db: SupabaseClient, runId: string, proposalId: string, adapter: ActionAdapter, opts: ExecuteOptions = {},
): Promise<ExecutionReport> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const p = must(await db.from("action_proposals").select("case_id, action, order_id, amount_cents, idempotency_key, scenario_run_id")
    .eq("id", proposalId).single(), "proposta");
  if (p!.scenario_run_id !== runId) throw new Error("proposta de outro cenário");
  const order = must(await db.from("orders").select("carrier, tracking_code").eq("order_id", p!.order_id).maybeSingle(), "pedido");

  const req = (attempt: number): ExecutionRequest => ({
    runId, proposalId, key: `exec:${p!.idempotency_key}`, action: p!.action as string, orderId: p!.order_id as string,
    amountCents: p!.amount_cents as number | null, carrier: (order?.carrier as string) ?? null,
    trackingCode: (order?.tracking_code as string) ?? null, attempt,
  });

  const finish = async (executionId: string, outcome: Record<string, unknown>) =>
    must(await db.rpc("finish_execution", { p_execution: executionId, p_outcome: outcome }), "gravar resultado") as { status: string };

  const done = (executionId: string, s: AdapterSuccess) =>
    finish(executionId, {
      // `ticket` só entra quando existe: JSON null chegaria ao Postgres como jsonb 'null' (não NULL) e tentaria criar um chamado.
      status: "concluida", external_ref: s.externalRef, result: s.result, ...(s.ticket ? { ticket: s.ticket } : {}), case_status: s.caseStatus,
      notification: composeNotification(p!.action as string, s, p!.amount_cents as number | null),
    });

  for (let guard = 0; guard < maxAttempts * 3 + 3; guard++) {
    const b = must(await db.rpc("begin_execution", { p_proposal: proposalId, p_adapter: adapter.id, p_max_attempts: maxAttempts }), "reservar execução") as Begin;

    if (b.mode === "reuse") return { state: "reuso", attempts: b.attempt, externalRef: b.external_ref, result: b.result };
    if (b.mode === "busy") return { state: "em_andamento", attempts: b.attempt };
    if (b.mode === "failed") return { state: "falhou", attempts: b.attempt, error: b.error };

    if (b.mode === "reconcile") {
      // Resultado incerto: consultar o estado externo ANTES de repetir uma ação.
      let found: AdapterSuccess | null;
      try {
        found = await adapter.reconcile(req(b.attempt));
      } catch (e) {
        return { state: "em_andamento", attempts: b.attempt, error: `reconciliação adiada: ${(e as Error).message}` };
      }
      if (found) {
        await done(b.execution_id, found);
        return { state: "concluida", attempts: b.attempt, externalRef: found.externalRef, result: found.result };
      }
      await finish(b.execution_id, { status: "falhou", retryable: true, error: "operação não consta no sistema externo após resultado incerto" });
      continue;
    }

    try {
      const success = await adapter.execute(req(b.attempt));
      await done(b.execution_id, success);
      return { state: "concluida", attempts: b.attempt, externalRef: success.externalRef, result: success.result };
    } catch (e) {
      const f = e instanceof AdapterFailure ? e : new AdapterFailure("transitoria", (e as Error).message);
      if (f.kind === "incerta") {
        await finish(b.execution_id, { status: "incerta", error: f.message });
        continue; // próxima volta cai em reconcile
      }
      await finish(b.execution_id, { status: "falhou", retryable: f.kind === "transitoria", error: f.message });
      if (f.kind === "transitoria" && b.attempt < maxAttempts) {
        await sleep((opts.backoffMs ?? 500) * 2 ** (b.attempt - 1));
        continue;
      }
      // Falha definitiva: o caso volta para uma pessoa, com notificação interna persistida.
      must(await db.rpc("create_handoff", {
        p_run: runId, p_case: p!.case_id, p: {
          reason: "execucao_falhou", team: "atendimento", proposal_id: proposalId, title: "A execução falhou",
          decision_requested: "Decidir como seguir: a ação não foi concluída e nenhuma mensagem de sucesso foi enviada ao cliente", body: f.message,
        },
      }), "encaminhar falha de execução");
      return { state: "falhou", attempts: b.attempt, error: f.message };
    }
  }
  return { state: "em_andamento", attempts: maxAttempts, error: "limite de passos de execução atingido" };
}
