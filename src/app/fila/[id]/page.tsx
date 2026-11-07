import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentStaff } from "../../../server/auth/session";
import { DELIVERY_LABEL, gobiaBubbles, internalNote, leadProposal, messageBubbles, processNumber, type Bubble } from "../../../server/case-view";
import { getCaseDetail, type DetailProposal } from "../../../server/cases";
import { createAdminClient } from "../../../server/db/admin";
import { createSessionClient } from "../../../server/db/client";
import { scenarioClock } from "../../../server/queries";
import { listAssignableStaff } from "../../../server/queue/staff";
import { reasonLines, requiresSupervisor, waitLabel } from "../../../server/supervision-model";
import { adjustAction, answerSurveyAction, assignAction, closeCaseAction, completeReviewAction, decideAction, releaseAction } from "./actions";

const CHANNEL_LABEL = { whatsapp: "WhatsApp", email: "E-mail", reclame_aqui: "Reclame Aqui (público)" } as const;
const CHANNEL_SHORT = { whatsapp: "WhatsApp", email: "e-mail", reclame_aqui: "Reclame Aqui" } as const;
const TOPIC_LABEL: Record<string, string> = {
  rastreio_atraso: "Rastreio e atraso", troca_devolucao: "Troca ou devolução", avaria: "Avaria", personalizacao: "Personalização",
  brinde: "Brinde", reacao_adversa: "Reação adversa", cancelamento: "Cancelamento", outros: "Outros",
};
const STATUS_CASE: Record<string, string> = {
  novo: "Novo", em_investigacao: "Em investigação", aguardando_cliente: "Aguardando cliente", aguardando_humano: "Aguardando pessoa",
  aguardando_terceiro: "Aguardando terceiro", em_execucao: "Em execução", reaberto: "Reaberto", resolvido: "Resolvido",
};
const DELIVERY_STATUS: Record<string, string> = {
  aguardando_separacao: "Aguardando separação", em_transito: "Em trânsito", entregue: "Entregue", extraviado: "Extraviado", devolvido: "Devolvido", cancelado: "Cancelado",
};
const ACTION_LABEL: Record<string, string> = {
  reembolsar: "Reembolso", reenviar_produto: "Reenvio", reimprimir_personalizacao: "Reimpressão", trocar_produto: "Troca",
  cancelar_pedido: "Cancelamento", abrir_chamado_transportadora: "Chamado à transportadora", informar_status: "Informar situação",
};
const STATUS_LABEL: Record<string, string> = {
  aguardando_aprovacao: "aguardando aprovação", suspensa: "suspensa", rejeitada: "rejeitada", pronta: "pronta para executar",
  concluida: "concluída (simulada)", falhou: "falhou", bloqueada: "bloqueada", executando: "executando", em_janela_revisao: "em janela de revisão",
};
const brl = (c: number | null) => (c === null ? "—" : `R$ ${(c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—");
const short = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—");

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

function Bubbles({ items }: { items: Bubble[] }) {
  return (
    <div className="cd-thread">
      {items.map((b) => (
        <div key={b.key} className={`cd-msg cd-msg-${b.side}${b.kind === "nota" ? " cd-msg-note" : ""}`}>
          <span className="cd-msg-meta"><strong>{b.author}</strong>{b.at ? ` ${short(b.at)}` : ""}</span>
          <p className="cd-bubble">{b.text}</p>
          {b.delivery && <span className={`cd-msg-state cd-msg-state-${b.delivery}`}>{DELIVERY_LABEL[b.delivery]}</span>}
        </div>
      ))}
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => <><dt>{k}</dt><dd>{v}</dd></>;

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
  // GOB-11: encerramentos, pesquisas e revisões do caso (RLS do escopo se aplica). O restante alimenta o cabeçalho, o chat e os cartões.
  const [closures, surveys, reviews, outbox, runRow, customer, order, brand, unit] = await Promise.all([
    session.from("case_closures").select("id, seq, closed_at, resolution_mode, channel, reopened_at").eq("case_id", id).order("seq"),
    session.from("case_surveys").select("id, closure_id, channel, status, score, resolved, comment, requested_at, answered_at").eq("case_id", id).order("requested_at"),
    session.from("survey_reviews").select("id, survey_id, reason, status, improvement_area, eval_set, note").eq("case_id", id).order("created_at"),
    session.from("outbox_events").select("id, status, payload").eq("case_id", id).eq("kind", "notificacao_cliente").order("created_at"),
    session.from("cases").select("scenario_run_id").eq("id", id).maybeSingle(),
    detail.customerId ? session.from("customers").select("full_name, orders_count, contacts_12m, city, uf").eq("customer_id", detail.customerId).maybeSingle() : Promise.resolve({ data: null }),
    detail.orderId ? session.from("orders").select("ordered_at, delivery_status, carrier, delivered_on, separated_at").eq("order_id", detail.orderId).maybeSingle() : Promise.resolve({ data: null }),
    detail.brandId ? session.from("brands").select("name").eq("id", detail.brandId).maybeSingle() : Promise.resolve({ data: null }),
    detail.businessUnitId ? session.from("business_units").select("name").eq("id", detail.businessUnitId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const runId = (runRow.data as { scenario_run_id?: string } | null)?.scenario_run_id;
  const clockMs = runId ? Date.parse(await scenarioClock(session, runId)) : Date.parse(detail.openedAt);
  const seqOf = new Map((closures.data ?? []).map((c) => [c.id as string, c.seq as number]));
  const canReview = staff.role === "supervisor" || staff.role === "analista";
  // Só o supervisor escolhe outra pessoa; a lista vem do servidor depois de confirmar acesso ao caso.
  const assignable = staff.role === "supervisor" ? await listAssignableStaff(createAdminClient(), { businessUnitId: detail.businessUnitId, brandId: detail.brandId }) : [];

  const customerName = (customer.data?.full_name as string | undefined) ?? null;
  const lead = leadProposal(detail.proposals);
  const note = internalNote(lead);
  const sup = requiresSupervisor(detail);
  const openedAgo = waitLabel(Math.max(0, clockMs - Date.parse(detail.openedAt)));
  const channelNames = detail.channels.map((c) => CHANNEL_SHORT[c]).join(" e ") || "canal desconhecido";
  const outbound = gobiaBubbles((outbox.data ?? []) as { id: string; status: string; payload: unknown }[]);
  const why = reasonLines(detail)[0];

  return (
    <main className="queue cd">
      <nav className="cd-crumbs" aria-label="Você está em"><Link href="/fila">Todos os casos</Link><span aria-hidden="true">/</span><span>Processo #{processNumber(detail.id)}</span></nav>
      <header className="cd-head">
        <h1>{TOPIC_LABEL[detail.topic] ?? detail.topic}
          {sup && <span className="sv-pill sv-pill-red">Exige supervisor</span>}
          <span className={`cl-prio cl-prio-${detail.priority.level}`}>Prioridade {detail.priority.level === "media" ? "média" : detail.priority.level}<small>{detail.priority.score}</small></span>
        </h1>
        <p className="muted">
          {customerName ?? (detail.customerId ? `Cliente ${detail.customerId}` : "Cliente não identificado")}, por {channelNames}, processo #{processNumber(detail.id)}, aberto há {openedAgo}.
          {" "}Situação: <strong>{detail.clarification ? "pendente de esclarecimento" : STATUS_CASE[detail.status] ?? detail.status}</strong>.
        </p>
      </header>
      {ok && <p role="status" className="notice-ok">{ok}</p>}
      {erro && <p role="alert" className="notice-err">{erro}</p>}
      {detail.clarification && <p role="status" className="cd-clarify"><strong>Esclarecimento necessário:</strong> {detail.clarification}</p>}

      <div className="cd-grid">
        <div className="cd-main">
          {detail.conversationsDetail.length === 0 && <section className="cd-card"><h2>Conversa</h2><p className="muted">Nenhuma mensagem registrada.</p></section>}
          {detail.conversationsDetail.map((c, i) => {
            const items: Bubble[] = [...messageBubbles(c.messages, customerName)];
            // Avisos da GoBIA e nota interna ficam na última conversa, depois das mensagens do cliente.
            if (i === detail.conversationsDetail.length - 1) {
              items.push(...outbound);
              if (note) items.push({ key: "nota", side: "equipe", kind: "nota", author: "Nota interna da GoBIA", at: null, text: note });
            }
            return (
              <section key={c.conversationId} className="cd-card">
                <h2>Conversa por {CHANNEL_SHORT[c.channel]}{c.public && <span className="cl-chip cl-chip-public">pública</span>}</h2>
                <p className="cd-sub">{CHANNEL_LABEL[c.channel]} · {c.externalId ?? c.conversationId}{c.public ? " · tudo o que for respondido aqui é público" : ""}</p>
                {items.length ? <Bubbles items={items} /> : <p className="muted">Sem mensagens.</p>}
              </section>
            );
          })}

          <section className="cd-card" id="decisao">
            <h2>Propostas e aprovações</h2>
            {detail.proposals.length === 0 && <p className="muted">Nenhuma proposta de ação para este caso.</p>}
            {detail.proposals.map((p) => <ProposalCard key={p.id} p={p} caseId={detail.id} role={staff.role} staffId={staff.id} />)}
          </section>
        </div>

        <aside className="cd-side">
          <section className="cd-card">
            <h2>Resumo do caso</h2>
            <p>{detail.summary ?? "Sem resumo."}</p>
            {detail.decisionRequested && <p className="cd-callout"><strong>Decisão solicitada:</strong> {detail.decisionRequested}</p>}
            {why && detail.handoffReason && <p className="cd-sub">Motivo do encaminhamento: {why}{detail.handoffTeam ? ` · equipe ${detail.handoffTeam}` : ""}</p>}
          </section>

          <section className="cd-card">
            <h2>Dados do pedido</h2>
            <dl className="cd-dl">
              <Row k="Pedido" v={detail.orderId ?? "não confirmado"} />
              {detail.order && <Row k="Valor" v={brl(detail.order.totalCents)} />}
              {detail.order?.items.map((it, i) => <Row key={i} k={i === 0 ? "Item" : ""} v={`${it.quantity}× ${it.description ?? it.sku ?? "item"}${it.sku ? ` (${it.sku})` : ""}`} />)}
              {order.data && <Row k="Comprado em" v={day(order.data.ordered_at as string)} />}
              {order.data?.delivery_status && <Row k="Entrega" v={`${DELIVERY_STATUS[order.data.delivery_status as string] ?? order.data.delivery_status}${order.data.carrier ? ` · ${order.data.carrier}` : ""}`} />}
              {order.data?.delivered_on && <Row k="Entregue em" v={day(order.data.delivered_on as string)} />}
              <Row k="Marca" v={(brand.data?.name as string | undefined) ?? "não confirmada"} />
              <Row k="Unidade" v={(unit.data?.name as string | undefined) ?? "não confirmada"} />
              {customer.data && <Row k="Histórico" v={`${(customer.data.orders_count as number | null) ?? 0} compras, ${(customer.data.contacts_12m as number | null) ?? 0} contatos em 12 meses`} />}
              {customer.data?.city && <Row k="Cidade" v={`${customer.data.city as string}${customer.data.uf ? `/${customer.data.uf as string}` : ""}`} />}
            </dl>
            {!detail.order && <p className="muted">Pedido não confirmado.</p>}
          </section>

          <section className="cd-card">
            <h2>Diretriz aplicada</h2>
            {lead && lead.justification.length > 0 ? (
              <>
                <ul className="cd-list">{lead.justification.slice(0, 4).map((j, i) => <li key={i}>{j}</li>)}</ul>
                <p className="cd-sub">Política {lead.policyVersion ?? "—"}{lead.evidence.length ? ` · ${lead.evidence.length} evidência(s) na proposta` : ""}</p>
              </>
            ) : <p className="muted">Nenhuma diretriz registrada: ainda não há proposta com justificativa.</p>}
          </section>

          <section className="cd-card">
            <h2>Responsável</h2>
            <p>{detail.assigneeName ?? "Sem responsável"}</p>
            <form action={assignAction} className="inline">
              <input type="hidden" name="caseId" value={detail.id} />
              {assignable.length > 0 ? (
                <select name="assigneeId" defaultValue={staff.id} aria-label="Responsável">
                  {assignable.map((s) => <option key={s.id} value={s.id}>{s.fullName} ({s.role})</option>)}
                </select>
              ) : null}
              <button type="submit">{assignable.length > 0 ? "Atribuir" : "Assumir o caso"}</button>
            </form>
          </section>

          <details className="cd-card cd-fold">
            <summary>Por que esta prioridade</summary>
            <ul className="cd-list">{detail.priority.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
          </details>
        </aside>
      </div>

      <details className="cd-fold cd-wide" open={detail.status === "resolvido" || (surveys.data ?? []).length > 0}>
        <summary>Encerramento e pesquisa de satisfação</summary>
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
      </details>

      <details className="cd-fold cd-wide">
        <summary>Avisos internos ({detail.notifications.length})</summary>
        <ul>{detail.notifications.map((n) => <li key={n.id}><strong>{n.title}</strong> — {n.body} <span className="muted">({when(n.createdAt)})</span></li>)}
          {detail.notifications.length === 0 && <li>Nenhum aviso.</li>}</ul>
      </details>

      <details className="cd-fold cd-wide">
        <summary>Fontes verificadas ({detail.sources.length})</summary>
        <ul>
          {detail.sources.map((s, i) => <li key={i}>{s.type}: {s.id}{s.detail ? ` (${s.detail})` : ""}</li>)}
          {detail.sources.length === 0 && <li>Nenhuma fonte verificada.</li>}
        </ul>
      </details>

      <details className="cd-fold cd-wide">
        <summary>Linha do tempo (auditoria) ({detail.timeline.length})</summary>
        <ol>{detail.timeline.map((t) => <li key={t.id}>{when(t.at)} · {t.type.replace(/_/g, " ")} · {t.actorType}</li>)}</ol>
      </details>
    </main>
  );
}
