import Link from "next/link";
import { getCurrentStaff } from "../../../server/auth/session";
import { createSessionClient } from "../../../server/db/client";
import { listPending, type PendingRow } from "../../../server/pending";
import { decideAction, releaseAction } from "../[id]/actions";
import { advanceClockAction, processNowAction } from "./actions";

const CHANNEL_LABEL: Record<string, string> = { whatsapp: "WhatsApp", email: "E-mail", reclame_aqui: "Reclame Aqui" };
const ACTION_LABEL: Record<string, string> = {
  reembolsar: "Reembolso", reenviar_produto: "Reenvio", reimprimir_personalizacao: "Reimpressão", trocar_produto: "Troca",
  cancelar_pedido: "Cancelamento", abrir_chamado_transportadora: "Chamado à transportadora",
};
const STATUS_LABEL: Record<string, string> = {
  em_janela_revisao: "Em janela de revisão", suspensa: "Suspensa", rejeitada: "Rejeitada", pronta: "Liberada, aguardando execução", executando: "Executando",
  concluida: "Executada (simulada)", bloqueada: "Bloqueada na revalidação", falhou: "Falhou", aguardando_aprovacao: "Aguardando aprovação",
};
const TASK_LABEL: Record<string, string> = {
  pendente: "aguardando a próxima rodada", reservada: "reservada por um processador", concluida: "concluída", cancelada: "cancelada (proposta mudou)", falhou: "falhou",
};
const brl = (c: number | null) => (c === null ? "Sem valor" : `R$ ${(c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const SP = "America/Sao_Paulo";
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: SP }) : "—");
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { timeZone: SP, hour: "2-digit", minute: "2-digit" });
const OPEN = new Set(["em_janela_revisao", "suspensa", "pronta"]);

function Hidden({ r }: { r: PendingRow }) {
  return (
    <>
      <input type="hidden" name="caseId" value={r.caseId} />
      <input type="hidden" name="proposalId" value={r.proposalId} />
      <input type="hidden" name="version" value={r.version} />
      <input type="hidden" name="returnTo" value="/fila/pendencias" />
    </>
  );
}

/** Uma decisão que pede motivo: abre um campo de texto no próprio lugar (como "Negar" no protótipo). */
function ReasonForm({ r, decision, label, title, hint, danger }: { r: PendingRow; decision: "rejeitada" | "suspensa"; label: string; title: string; hint: string; danger?: boolean }) {
  return (
    <details className="au-reason">
      <summary className={danger ? "au-btn au-btn-danger" : "au-btn"}>{label}</summary>
      <form action={decideAction}>
        <Hidden r={r} />
        <input type="hidden" name="decision" value={decision} />
        <label>{title}<textarea name="note" required rows={3} maxLength={500} /></label>
        <p className="muted">{hint}</p>
        <button type="submit" className={danger ? "au-btn au-btn-danger" : "au-btn au-btn-primary"}>{label}</button>
      </form>
    </details>
  );
}

function Actions({ r, kind }: { r: PendingRow; kind: "revisao" | "aprovacao" }) {
  const canRelease = kind === "revisao" && (r.status === "em_janela_revisao" || r.status === "suspensa" || r.status === "pronta");
  const canRestrict = r.status === "em_janela_revisao" || r.status === "suspensa" || r.status === "aguardando_aprovacao";
  if (!canRelease && !canRestrict) return <Link href={`/fila/${r.caseId}`} className="sv-open">Abrir</Link>;
  return (
    <div className="au-actions">
      {canRelease && (
        <form action={releaseAction}><Hidden r={r} /><button type="submit" className="au-btn au-btn-primary">{r.status === "suspensa" ? "Retomar e executar" : r.status === "pronta" ? "Executar agora" : "Liberar agora"}</button></form>
      )}
      {kind === "aprovacao" && <Link href={`/fila/${r.caseId}`} className="au-btn au-btn-primary">Decidir no caso</Link>}
      {r.status !== "suspensa" && canRestrict && (
        <ReasonForm r={r} decision="suspensa" label="Suspender" title="Motivo da suspensão" hint="Nada é executado até nova decisão. O motivo fica na auditoria." />
      )}
      {canRestrict && (
        <ReasonForm r={r} decision="rejeitada" label="Rejeitar" title="Motivo da rejeição" danger
          hint="O caso segue com atendimento humano. O motivo fica na auditoria; esta tela não envia mensagem ao cliente." />
      )}
    </div>
  );
}

function Who({ r }: { r: PendingRow }) {
  return (
    <td>
      <strong>{r.customerName ?? "Cliente não identificado"}</strong>
      <span className="sv-sub">{r.channels.map((c) => CHANNEL_LABEL[c] ?? c).join(", ") || "Canal desconhecido"}, {r.orderId ?? "sem pedido"}</span>
    </td>
  );
}

function Summary({ r }: { r: PendingRow }) {
  return <td><span className="sv-clamp">{r.summary ?? "Sem resumo"}</span><Link href={`/fila/${r.caseId}`} className="au-link">Ver o caso</Link></td>;
}

function Value({ r }: { r: PendingRow }) {
  return (
    <td>
      <strong>{ACTION_LABEL[r.action] ?? r.action}{r.itemLabel ? `: ${r.itemLabel}` : ""}</strong>
      <span className="sv-sub sv-money">{brl(r.amountCents)}</span>
    </td>
  );
}

const tone = (ms: number | null) => (ms === null ? "calm" : ms < 15 * 60_000 ? "hot" : ms < 60 * 60_000 ? "warn" : "calm");

export default async function PendingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await getCurrentStaff();
  if (!staff) return <main className="page"><p>Conta sem funcionário ativo vinculado.</p></main>;
  const sp = await searchParams;
  const ok = typeof sp.ok === "string" ? sp.ok : null;
  const erro = typeof sp.erro === "string" ? sp.erro : null;

  const db = await createSessionClient();
  const { data: run } = await db.from("scenario_runs").select("id").eq("name", "demo").maybeSingle();
  const view = run ? await listPending(db, run.id) : null;

  const waiting = view?.review.filter((r) => r.status === "em_janela_revisao") ?? [];
  const waitingTotal = waiting.reduce((a, r) => a + (r.amountCents ?? 0), 0);
  const first = waiting.map((r) => r.executeAfter).filter((v): v is string => !!v).sort()[0];
  const history = view?.review.filter((r) => r.status !== "em_janela_revisao") ?? [];

  return (
    <main className="page sv">
      <header className="sv-head st-head">
        <div>
          <h1>Ações em espera</h1>
          <p className="muted">
            A GoBIA só propõe o que a política já autoriza. Cada ação segue sozinha quando a janela de revisão termina: libere antes, suspenda ou rejeite com motivo.
          </p>
        </div>
        {view && <p className="muted au-clock">Relógio do cenário: {when(view.clock)}</p>}
      </header>

      {ok && <p role="status" className="sv-notice au-ok">{ok}</p>}
      {erro && <p role="alert" className="sv-notice au-err">{erro}</p>}
      {!view ? <p>Cenário &quot;demo&quot; não encontrado.</p> : (
        <>
          <p className="au-banner">
            {waiting.length === 0
              ? "Nenhuma ação em janela de revisão agora."
              : <><strong>{waiting.length} {waiting.length === 1 ? "ação aguardando" : "ações aguardando"}, {brl(waitingTotal)} no total.</strong> {first ? `A primeira fica elegível às ${hhmm(first)} (relógio do cenário), na rodada seguinte do processador, se ninguém agir.` : ""}</>}
          </p>

          {staff.role === "supervisor" && (
            <details className="au-demo">
              <summary>Ferramentas de demonstração (só no cenário demo)</summary>
              <div>
                <form action={advanceClockAction}>
                  <label>Avançar o relógio em <select name="hours" defaultValue="2"><option value="1">1 h</option><option value="2">2 h</option><option value="3">3 h</option><option value="24">24 h</option></select></label>{" "}
                  <button type="submit" className="au-btn">Avançar</button>
                </form>
                <form action={processNowAction}><button type="submit" className="au-btn">Rodar o processador agora</button></form>
                <p className="muted">O relógio só avança quando você o avança. Vencer a janela torna a ação elegível; não a executa no segundo exato.</p>
              </div>
            </details>
          )}

          <h2 className="au-h2">Revisão opcional · janela de duas horas</h2>
          <div className="sv-card">
            <table className="sv-table au-table">
              <thead><tr><th>Cliente e canal</th><th>Resumo do caso</th><th>Ação e valor</th><th>Tempo restante</th><th>Ações</th></tr></thead>
              <tbody>
                {waiting.map((r) => (
                  <tr key={r.proposalId}>
                    <Who r={r} /><Summary r={r} /><Value r={r} />
                    <td>
                      <span className={`sv-wait sv-wait-${tone(r.remainingMs)}`}>{r.countdown ?? "—"}</span>
                      {r.executeAfter && <span className="sv-sub">Elegível às {hhmm(r.executeAfter)}</span>}
                      {r.task && <span className="sv-sub">Tarefa: {TASK_LABEL[r.task.status] ?? r.task.status}{r.task.attempts ? ` · ${r.task.attempts} tentativa(s)` : ""}</span>}
                    </td>
                    <td><Actions r={r} kind="revisao" /></td>
                  </tr>
                ))}
                {waiting.length === 0 && <tr><td colSpan={5} className="sv-empty">Nenhuma ação em janela de revisão.</td></tr>}
              </tbody>
            </table>
          </div>

          {history.length > 0 && (
            <>
              <h2 className="au-h2">Já decididas ou em execução</h2>
              <div className="sv-card">
                <table className="sv-table au-table">
                  <thead><tr><th>Cliente e canal</th><th>Resumo do caso</th><th>Ação e valor</th><th>Situação</th><th>Ações</th></tr></thead>
                  <tbody>
                    {history.map((r) => (
                      <tr key={r.proposalId}>
                        <Who r={r} /><Summary r={r} /><Value r={r} />
                        <td>
                          <span className={`sv-pill ${r.status === "concluida" ? "au-pill-ok" : r.status === "rejeitada" || r.status === "falhou" || r.status === "bloqueada" ? "sv-pill-red" : "sv-pill-blue"}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                          {r.task?.lastError && <span className="sv-sub">{r.task.lastError}</span>}
                          {r.assigneeName && <span className="sv-sub">Com {r.assigneeName}</span>}
                        </td>
                        <td>{OPEN.has(r.status) ? <Actions r={r} kind="revisao" /> : <Link href={`/fila/${r.caseId}`} className="sv-open">Abrir</Link>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <h2 className="au-h2">Aprovação obrigatória</h2>
          <p className="muted au-lead">Acima da alçada o tempo nunca libera. Prazo vencido cobra e escala o supervisor, nunca aprova.</p>
          <div className="sv-card">
            <table className="sv-table au-table">
              <thead><tr><th>Cliente e canal</th><th>Resumo do caso</th><th>Ação e valor</th><th>Prazo da decisão</th><th>Ações</th></tr></thead>
              <tbody>
                {view.approvals.map((r) => (
                  <tr key={r.proposalId}>
                    <Who r={r} /><Summary r={r} /><Value r={r} />
                    <td>
                      <span className={`sv-wait sv-wait-${r.remainingMs !== null && r.remainingMs <= 0 ? "hot" : tone(r.remainingMs)}`}>{r.countdown ?? "—"}</span>
                      {r.approvalDueAt && <span className="sv-sub">Até {when(r.approvalDueAt)}</span>}
                      <span className="sv-sub">{STATUS_LABEL[r.status] ?? r.status}{r.escalationLevel ? ` · escalonamento nível ${r.escalationLevel}` : ""}</span>
                    </td>
                    <td><Actions r={r} kind="aprovacao" /></td>
                  </tr>
                ))}
                {view.approvals.length === 0 && <tr><td colSpan={5} className="sv-empty">Nenhuma aprovação pendente.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="muted sv-foot">Tempo = prazo menos o relógio do cenário. Toda decisão fica registrada na auditoria do caso, com ator, motivo e resultado.</p>
        </>
      )}
    </main>
  );
}
