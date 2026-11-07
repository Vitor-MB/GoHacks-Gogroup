"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentStaff } from "../../../server/auth/session";
import { createAdminClient } from "../../../server/db/admin";
import { createSessionClient } from "../../../server/db/client";
import { createSimulatedAdapter } from "../../../server/execution/adapters";
import { loadPolicyParams } from "../../../server/policy/load";
import { releaseReviewWindow } from "../../../server/jobs/review";
import { adjustProposalAmount, assignCase, decideProposal, HumanDecisionError } from "../../../server/queue/approvals";
import { answerSurvey, closeCase, completeSurveyReview } from "../../../server/metrics/survey";

const UUID = /^[0-9a-f-]{36}$/i;

/** Identidade e escopo vêm da sessão. A leitura do caso pelo cliente da sessão já passa pela RLS do escopo. */
async function context(caseId: string) {
  const staff = await getCurrentStaff();
  if (!staff) throw new HumanDecisionError("nao_autorizado", "sessão sem funcionário ativo");
  if (!UUID.test(caseId)) throw new HumanDecisionError("nao_encontrado", "caso inválido");
  const { data } = await (await createSessionClient()).from("cases").select("scenario_run_id").eq("id", caseId).maybeSingle();
  if (!data) throw new HumanDecisionError("fora_do_escopo", "caso inexistente ou fora do seu escopo");
  const admin = createAdminClient();
  return { staff, runId: data.scenario_run_id as string, admin, params: await loadPolicyParams(admin) };
}

/** Volta para a tela de origem. Só aceita destinos internos conhecidos (nada de redirecionamento aberto). */
const RETURN_TO = new Set(["/fila/pendencias"]);

function back(caseId: string, kind: "ok" | "erro", message: string, returnTo?: string): never {
  revalidatePath(`/fila/${caseId}`);
  revalidatePath("/fila");
  revalidatePath("/fila/pendencias");
  const path = returnTo && RETURN_TO.has(returnTo) ? returnTo : `/fila/${caseId}`;
  redirect(`${path}?${kind}=${encodeURIComponent(message)}`);
}

async function run(caseId: string, work: () => Promise<string>, returnTo?: string): Promise<never> {
  let message: string;
  try {
    message = await work();
  } catch (e) {
    return back(caseId, "erro", e instanceof HumanDecisionError ? e.message : "Não foi possível concluir a operação.", returnTo);
  }
  return back(caseId, "ok", message, returnTo);
}

const field = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

export async function assignAction(formData: FormData) {
  const caseId = field(formData, "caseId");
  await run(caseId, async () => {
    const { staff, admin } = await context(caseId);
    // Sem destino informado, o funcionário assume o caso para si.
    const assigneeId = field(formData, "assigneeId") || staff.id;
    const r = await assignCase(admin, { caseId, actorId: staff.id, assigneeId, note: field(formData, "note") || undefined });
    return `Caso atribuído a ${r.assignee_name}.`;
  });
}

export async function decideAction(formData: FormData) {
  const caseId = field(formData, "caseId");
  const returnTo = field(formData, "returnTo") || undefined;
  await run(caseId, async () => {
    const { staff, runId, admin, params } = await context(caseId);
    const decision = field(formData, "decision");
    if (decision !== "aprovada" && decision !== "rejeitada" && decision !== "suspensa") throw new HumanDecisionError("estado_invalido", "decisão inválida");
    const version = Number(field(formData, "version"));
    if (!Number.isInteger(version)) throw new HumanDecisionError("estado_invalido", "versão inválida");
    const r = await decideProposal(admin, runId, {
      proposalId: field(formData, "proposalId"), actorId: staff.id, decision, version, note: field(formData, "note") || undefined,
    }, { params, adapter: createSimulatedAdapter(admin) });
    if (decision === "rejeitada") return "Proposta rejeitada. O caso segue com atendimento humano.";
    if (decision === "suspensa") return "Proposta suspensa. Nada será executado até nova decisão.";
    if (!r.released) return `Aprovação registrada, mas a revalidação bloqueou a execução: ${(r.blockers ?? []).join("; ")}`;
    return r.execution?.state === "concluida" || r.execution?.state === "reuso"
      ? "Aprovada e executada (simulada). A solicitação foi registrada; a notificação ao cliente já está na saída."
      : "Aprovada e liberada. A execução será concluída no processamento.";
  }, returnTo);
}

/** Liberação antecipada da janela de revisão (ou retomada de uma suspensão). Revalida antes de executar. */
export async function releaseAction(formData: FormData) {
  const caseId = field(formData, "caseId");
  const returnTo = field(formData, "returnTo") || undefined;
  await run(caseId, async () => {
    const { staff, runId, admin, params } = await context(caseId);
    const r = await releaseReviewWindow(admin, runId, { proposalId: field(formData, "proposalId"), actorId: staff.id, note: field(formData, "note") || undefined },
      { params, adapter: createSimulatedAdapter(admin) });
    if (!r.released) return `A revalidação bloqueou a execução: ${(r.blockers ?? []).join("; ")}`;
    const s = r.execution?.state;
    return s === "concluida" || s === "reuso"
      ? "Liberada e executada (simulada). A solicitação foi registrada; a notificação ao cliente já está na saída."
      : "Liberada. A execução será concluída no processamento.";
  }, returnTo);
}

export async function adjustAction(formData: FormData) {
  const caseId = field(formData, "caseId");
  await run(caseId, async () => {
    const { staff, runId, admin, params } = await context(caseId);
    const reais = Number(field(formData, "amount").replace(",", "."));
    if (!Number.isFinite(reais) || reais <= 0) throw new HumanDecisionError("estado_invalido", "Informe um valor válido.");
    const r = await adjustProposalAmount(admin, runId, {
      proposalId: field(formData, "proposalId"), actorId: staff.id, newAmountCents: Math.round(reais * 100), note: field(formData, "note") || undefined,
    }, { params });
    return `Valor ajustado (versão ${r.version}). ${r.approvals_invalidated ? "A aprovação anterior foi invalidada. " : ""}Situação: ${r.status.replace(/_/g, " ")}.`;
  });
}

/** GOB-11 · Encerramento válido: o banco recusa se houver proposta pendente; uma pesquisa por encerramento. */
export async function closeCaseAction(formData: FormData) {
  const caseId = field(formData, "caseId");
  await run(caseId, async () => {
    const { staff, admin } = await context(caseId);
    const r = await closeCase(admin, { caseId, actorId: staff.id, note: field(formData, "note") || undefined });
    if (r.already_closed) return "O caso já estava resolvido: nenhuma nova pesquisa foi solicitada.";
    return `Caso resolvido (${r.resolution_mode === "autonoma" ? "autônoma" : "assistida"}). Pesquisa de satisfação solicitada uma vez, pelo canal ${r.channel}.`;
  });
}

/** Registro MANUAL da resposta do cliente (o canal real de resposta não existe no MVP): fica identificado como simulado. */
export async function answerSurveyAction(formData: FormData) {
  const caseId = field(formData, "caseId");
  await run(caseId, async () => {
    const { admin } = await context(caseId); // sessão e escopo do caso
    const surveyId = field(formData, "surveyId");
    // A pesquisa precisa pertencer a ESTE caso (a leitura pelo cliente da sessão respeita a RLS do escopo).
    const { data: owned } = await (await createSessionClient()).from("case_surveys").select("id").eq("id", surveyId).eq("case_id", caseId).maybeSingle();
    if (!owned) throw new HumanDecisionError("nao_encontrado", "Pesquisa não encontrada neste caso.");
    const score = Number(field(formData, "score"));
    const resolved = field(formData, "resolved");
    if (!Number.isInteger(score) || score < 1 || score > 5) throw new HumanDecisionError("estado_invalido", "Informe a nota de 1 a 5.");
    if (resolved !== "sim" && resolved !== "parcialmente" && resolved !== "nao") throw new HumanDecisionError("estado_invalido", "Informe se o problema foi resolvido.");
    const r = await answerSurvey(admin, { surveyId, score, resolved, comment: field(formData, "comment") || undefined });
    if (r.reused) return "Esta pesquisa já tinha resposta; a primeira resposta foi mantida.";
    return r.reopened ? "Resposta registrada. O caso voltou à fila humana para revisão e continuidade." : r.review_id ? "Resposta registrada. Revisão criada." : "Resposta registrada.";
  });
}

export async function completeReviewAction(formData: FormData) {
  const caseId = field(formData, "caseId");
  await run(caseId, async () => {
    const { staff, admin } = await context(caseId);
    await completeSurveyReview(admin, {
      reviewId: field(formData, "reviewId"), actorId: staff.id, note: field(formData, "note") || undefined,
      area: field(formData, "area") || null, evalSet: field(formData, "evalSet") === "on",
    });
    return "Revisão concluída. Nada foi alterado automaticamente: mudanças de prompt, conhecimento ou roteamento exigem avaliação em conjunto fixo antes de ativar.";
  });
}
