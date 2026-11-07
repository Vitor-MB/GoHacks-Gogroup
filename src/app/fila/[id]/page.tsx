import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentStaff } from "../../../server/auth/session";
import { getCaseDetail, type DetailProposal } from "../../../server/cases";
import { createAdminClient } from "../../../server/db/admin";
import { createSessionClient } from "../../../server/db/client";
import { listAssignableStaff } from "../../../server/queue/staff";
import { adjustAction, answerSurveyAction, assignAction, closeCaseAction, completeReviewAction, decideAction, releaseAction } from "./actions";

const CHANNEL_LABEL = { whatsapp: "WhatsApp", email: "E-mail", reclame_aqui: "Reclame Aqui (público)" } as const;
const ACTION_LABEL: Record<string, string> = {
  reembolsar: "Reembolso", reenviar_produto: "Reenvio", reimprimir_personalizacao: "Reimpressão", trocar_produto: "Troca",
  cancelar_pedido: "Cancelamento", abrir_chamado_transportadora: "Chamado à transportadora", informar_status: "Informar situação",
};
const STATUS_LABEL: Record<string, string> = {
  aguardando_aprovacao: "aguardando aprovação", suspensa: "suspensa", rejeitada: "rejeitada", pronta: "pronta para executar",
  concluida: "concluída (simulada)", falhou: "falhou", bloqueada: "bloqueada", executando: "executando", em_janela_revisao: "em janela de revisão",
};
const brl = (c: number | null) => (c === null ? "—" : `R$ ${(c / 100).toFixed(2).replace(".", ",")}`);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—");

function ProposalCard({ p, caseId, role, staffId }: { p: DetailProposal; caseId: string; role: string; staffId: string }) {
  const open = ["aguardando_aprovacao", "suspensa", "pronta", "em_janela_revisao"].includes(p.status);
  const inWindow = p.status === "em_janela_revisao" || (p.status === "suspensa" && !p.approvalRequired && !!p.executeAfter);
  const canApprove = role === "supervisor" && p.approvalRequired && ["aguardando_aprovacao", "suspensa"].includes(p.status) && p.requestedBy !== staffId;
  const hidden = (
    <>
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="proposalId" value={p.id} />
      <input type="hidden" name="version" value={p.version} />
    </>
  );
  return (
    <article className="proposal">
      <h3>{ACTION_LABEL[p.action] ?? p.action} · {brl(p.amountCents)} · versão {p.version}</h3>
      <p>
        Situação: <strong>{STATUS_LABEL[p.status] ?? p.status}</strong> · Pedido: {p.orderId ?? "—"} · Política {p.policyVersion ?? "—"} · Proposta de {p.proposedBy}
        {p.approvalDueAt && p.status === "aguardando_aprovacao" ? <> · Prazo de aprovação: {when(p.approvalDueAt)}{p.overdue ? " (VENCIDO — a decisão continua com o supervisor)" : ""}</> : null}
      </p>
      {p.reviewCountdown && <p>Janela de revisão até {when(p.executeAfter)} · <strong>{p.reviewCountdown}</strong>. A ação já é autorizada pela política; pode ser liberada antes, suspensa ou rejeitada.</p>}
      {p.origin && <p>Origem investigada: {p.origin.summary ?? p.origin.hypothesis} — <em>{p.origin.status === "confirmada" ? "confirmada" : "hipótese, não confirmada"}</em></p>}
      <details open><summary>Justificativa verificável</summary><ul>{p.justification.map((j, i) => <li key={i}>{j}</li>)}</ul></details>
      <details><summary>Evidências ({p.evidence.length})</summary><ul>{p.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul></details>
      {p.executionRef && <p>Execução simulada: {p.executionRef}. O reembolso, quando houver, é uma solicitação: o crédito não está confirmado.</p>}
      {p.approvals.length > 0 && (
        <details open><summary>Decisões</summary>
          <ul>{p.approvals.map((a) => (
            <li key={a.id}>{a.decision} · {a.role} · versão {a.version} · {brl(a.amountCents)} · {when(a.decidedAt)}{a.note ? ` · ${a.note}` : ""}{a.supersededReason ? ` — invalidada: ${a.supersededReason}` : ""}</li>
          ))}</ul>
        </details>
      )}
      {open && (
        <div className="controls">
          {(inWindow || p.status === "pronta") && (
            <form action={releaseAction}>{hidden}<button type="submit">{p.status === "suspensa" ? "Retomar e executar" : p.status === "pronta" ? "Executar agora" : "Liberar agora (antes do vencimento)"}</button></form>
          )}
          {canApprove && (
            <form action={decideAction}>{hidden}<input type="hidden" name="decision" value="aprovada" />
              <input name="note" placeholder="Observação (opcional)" /> <button type="submit">Aprovar para este pedido, ação e valor</button>
            </form>
          )}
          {!canApprove && p.approvalRequired && ["aguardando_aprovacao", "suspensa"].includes(p.status) && (
            <p className="muted">{role !== "supervisor" ? "Só o supervisor aprova acima da alçada." : "Você solicitou esta proposta: outro supervisor deve aprovar."}</p>
          )}
          <form action={decideAction}>{hidden}<input type="hidden" name="decision" value="rejeitada" />
            <input name="note" placeholder="Motivo da rejeição" /> <button type="submit">Rejeitar</button>
          </form>
          {p.status !== "suspensa" && (
            <form action={decideAction}>{hidden}<input type="hidden" name="decision" value="suspensa" />
              <input name="note" placeholder="Motivo da suspensão" /> <button type="submit">Suspender</button>
            </form>
          )}
          {p.amountCents !== null && (
            <form action={adjustAction}>{hidden}
              <input name="amount" inputMode="decimal" placeholder="Novo valor (R$)" aria-label="Novo valor em reais" /> <button type="submit">Ajustar valor (invalida aprovação anterior)</button>
            </form>
          )}
        </div>
      )}
    </article>
  );
}

export default async function CasePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await getCurrentStaff();
  if (!staff) notFound();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const sp = await searchParams;
  const ok = typeof sp.ok === "string" ? sp.ok : null;
  const erro = typeof sp.erro === "string" ? sp.erro : null;

  const session = await createSessionClient();
  const detail = await getCaseDetail(session, id);
  if (!detail) notFound();
  // GOB-11: encerramentos, pesquisas e revisões do caso (RLS do escopo se aplica).
  const [closures, surveys, reviews] = await Promise.all([
    session.from("case_closures").select("id, seq, closed_at, resolution_mode, channel, reopened_at").eq("case_id", id).order("seq"),
    session.from("case_surveys").select("id, closure_id, channel, status, score, resolved, comment, requested_at, answered_at").eq("case_id", id).order("requested_at"),
    session.from("survey_reviews").select("id, survey_id, reason, status, improvement_area, eval_set, note").eq("case_id", id).order("created_at"),
  ]);
  const seqOf = new Map((closures.data ?? []).map((c) => [c.id as string, c.seq as number]));
  const canReview = staff.role === "supervisor" || staff.role === "analista";
  // Só o supervisor escolhe outra pessoa; a lista vem do servidor depois de confirmar acesso ao caso.
  const assignable = staff.role === "supervisor" ? await listAssignableStaff(createAdminClient(), { businessUnitId: detail.businessUnitId, brandId: detail.brandId }) : [];

  return (
    <main className="queue">
      <p><Link href="/fila">← Fila</Link></p>
      <h1>{detail.summary ?? "Caso"}</h1>
      {ok && <p role="status" className="notice-ok">{ok}</p>}
      {erro && <p role="alert" className="notice-err">{erro}</p>}
      <p className="muted">
        Situação: {detail.clarification ? "pendente de esclarecimento" : detail.status} · Pedido: {detail.orderId ?? "não confirmado"} ·
        Marca: {detail.brandId ?? "não confirmada"} · Unidade: {detail.businessUnitId ?? "não confirmada"}
      </p>
      {detail.clarification && <p role="status"><strong>Esclarecimento necessário:</strong> {detail.clarification}</p>}

      <h2>Prioridade: {detail.priority.level}</h2>
      <ul>{detail.priority.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>

      <h2>Responsável e decisão solicitada</h2>
      <p>Responsável: <strong>{detail.assigneeName ?? "sem responsável"}</strong>{detail.handoffReason ? <> · Motivo do encaminhamento: {detail.handoffReason.replace(/_/g, " ")}</> : null}{detail.handoffTeam ? ` · Equipe: ${detail.handoffTeam}` : ""}</p>
      {detail.decisionRequested && <p><strong>Decisão solicitada:</strong> {detail.decisionRequested}</p>}
      <form action={assignAction} className="inline">
        <input type="hidden" name="caseId" value={detail.id} />
        {assignable.length > 0 ? (
          <select name="assigneeId" defaultValue={staff.id} aria-label="Responsável">
            {assignable.map((s) => <option key={s.id} value={s.id}>{s.fullName} ({s.role})</option>)}
          </select>
        ) : null}
        <button type="submit">{assignable.length > 0 ? "Atribuir" : "Assumir o caso"}</button>
      </form>

      <h2>Pedido e produto</h2>
      {detail.order ? (
        <>
          <p>Valor do pedido: {brl(detail.order.totalCents)}</p>
          <ul>{detail.order.items.map((it, i) => <li key={i}>{it.quantity}× {it.description ?? it.sku ?? "item"}{it.sku ? ` (${it.sku})` : ""}</li>)}</ul>
        </>
      ) : <p>Pedido não confirmado.</p>}

      <h2>Propostas e aprovações</h2>
      {detail.proposals.length === 0 && <p>Nenhuma proposta de ação para este caso.</p>}
      {detail.proposals.map((p) => <ProposalCard key={p.id} p={p} caseId={detail.id} role={staff.role} staffId={staff.id} />)}

      <h2>Encerramento e pesquisa de satisfação</h2>
      <p className="muted">Caso resolvido é diferente de conversa encerrada: só há encerramento válido sem proposta pendente de decisão, execução ou correção. Cada encerramento gera uma única pesquisa, em um único canal.</p>
      {detail.status !== "resolvido" && (
        <form action={closeCaseAction} className="inline">
          <input type="hidden" name="caseId" value={detail.id} />
          <input name="note" placeholder="Observação do encerramento (opcional)" /> <button type="submit">Encerrar caso como resolvido</button>
        </form>
      )}
      {(closures.data ?? []).map((c) => (
        <p key={c.id as string}>Encerramento {c.seq as number}: {when(c.closed_at as string)} (relógio do cenário) · resolução {c.resolution_mode === "autonoma" ? "autônoma" : "assistida"} · pesquisa pelo canal {CHANNEL_LABEL[c.channel as keyof typeof CHANNEL_LABEL]}{c.reopened_at ? <> · <strong>reaberto em {when(c.reopened_at as string)}</strong></> : null}</p>
      ))}
      {(surveys.data ?? []).map((sv) => (
        <article key={sv.id as string} className="proposal">
          <h3>Pesquisa do encerramento {seqOf.get(sv.closure_id as string) ?? "?"} · {sv.status === "respondida" ? "respondida" : "aguardando resposta"}</h3>
          {sv.status === "respondida" ? (
            <p>Nota {sv.score as number}/5 · problema resolvido: <strong>{sv.resolved as string}</strong>{sv.comment ? <> · “{sv.comment as string}”</> : null}</p>
          ) : (
            <form action={answerSurveyAction} className="controls">
              <input type="hidden" name="caseId" value={detail.id} />
              <input type="hidden" name="surveyId" value={sv.id as string} />
              <p className="muted">Sem resposta não há satisfação presumida. O canal real de resposta do cliente não existe no MVP: registre aqui a resposta recebida (simulada).</p>
              <label>Nota <select name="score" defaultValue="" required><option value="" disabled>—</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
              <label>O problema foi resolvido? <select name="resolved" defaultValue="" required><option value="" disabled>—</option><option value="sim">Sim</option><option value="parcialmente">Parcialmente</option><option value="nao">Não</option></select></label>
              <input name="comment" placeholder="Comentário (opcional)" maxLength={1000} />
              <button type="submit">Registrar resposta</button>
            </form>
          )}
        </article>
      ))}
      {(reviews.data ?? []).map((r) => (
        <article key={r.id as string} className="proposal">
          <h3>Revisão de pesquisa · {r.status === "pendente" ? "pendente" : "concluída"}</h3>
          <p>{r.reason as string}</p>
          {r.status === "concluida" ? (
            <p>Área de melhoria: {(r.improvement_area as string | null) ?? "—"} · {r.eval_set ? "candidato ao conjunto fixo de avaliação" : "fora do conjunto de avaliação"}{r.note ? ` · ${r.note as string}` : ""}</p>
          ) : canReview ? (
            <form action={completeReviewAction} className="controls">
              <input type="hidden" name="caseId" value={detail.id} />
              <input type="hidden" name="reviewId" value={r.id as string} />
              <select name="area" defaultValue="" aria-label="Área de melhoria"><option value="">Área de melhoria (opcional)</option><option value="prompt">Prompt</option><option value="conhecimento">Conhecimento</option><option value="roteamento">Roteamento</option><option value="politica">Política (só para análise humana)</option><option value="outro">Outro</option></select>
              <input name="note" placeholder="Conclusão da revisão" />
              <label><input type="checkbox" name="evalSet" /> Incluir no conjunto fixo de avaliação de versões futuras</label>
              <button type="submit">Concluir revisão</button>
            </form>
          ) : <p className="muted">Só supervisor ou analista conclui a revisão.</p>}
        </article>
      ))}

      <h2>Avisos internos</h2>
      <ul>{detail.notifications.map((n) => <li key={n.id}><strong>{n.title}</strong> — {n.body} <span className="muted">({when(n.createdAt)})</span></li>)}
        {detail.notifications.length === 0 && <li>Nenhum aviso.</li>}</ul>

      <h2>Fontes</h2>
      <ul>
        {detail.sources.map((s, i) => <li key={i}>{s.type}: {s.id}{s.detail ? ` (${s.detail})` : ""}</li>)}
        {detail.sources.length === 0 && <li>Nenhuma fonte verificada.</li>}
      </ul>

      <h2>Histórico por canal</h2>
      {detail.conversationsDetail.map((c) => (
        <section key={c.conversationId}>
          <h3>{CHANNEL_LABEL[c.channel]} · {c.conversationId}</h3>
          <ul>
            {c.messages.map((m) => (
              <li key={m.id}><strong>{m.author}</strong> · {when(m.sentAt)}: {m.body}</li>
            ))}
          </ul>
        </section>
      ))}

      <h2>Linha do tempo (auditoria)</h2>
      <ol>{detail.timeline.map((t) => <li key={t.id}>{when(t.at)} · {t.type.replace(/_/g, " ")} · {t.actorType}</li>)}</ol>
    </main>
  );
}
