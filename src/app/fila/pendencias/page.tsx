import Link from "next/link";
import { getCurrentStaff } from "../../../server/auth/session";
import { createSessionClient } from "../../../server/db/client";
import { listPending, type PendingRow } from "../../../server/pending";
import { decideAction, releaseAction } from "../[id]/actions";
import { advanceClockAction, processNowAction } from "./actions";

const ACTION_LABEL: Record<string, string> = {
  reembolsar: "Reembolso", reenviar_produto: "Reenvio", reimprimir_personalizacao: "Reimpressão", trocar_produto: "Troca",
  cancelar_pedido: "Cancelamento", abrir_chamado_transportadora: "Chamado à transportadora",
};
const STATUS_LABEL: Record<string, string> = {
  em_janela_revisao: "em janela de revisão", suspensa: "suspensa", rejeitada: "rejeitada", pronta: "liberada, aguardando execução", executando: "executando",
  concluida: "executada (simulada)", bloqueada: "bloqueada na revalidação", falhou: "falhou", aguardando_aprovacao: "aguardando aprovação",
};
const TASK_LABEL: Record<string, string> = {
  pendente: "aguardando o vencimento/rodada", reservada: "reservada por um processador", concluida: "concluída", cancelada: "cancelada (proposta mudou)", falhou: "falhou",
};
const brl = (c: number | null) => (c === null ? "—" : `R$ ${(c / 100).toFixed(2).replace(".", ",")}`);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—");

function Controls({ r, kind }: { r: PendingRow; kind: "revisao" | "aprovacao" }) {
  const hidden = (
    <>
      <input type="hidden" name="caseId" value={r.caseId} />
      <input type="hidden" name="proposalId" value={r.proposalId} />
      <input type="hidden" name="version" value={r.version} />
      <input type="hidden" name="returnTo" value="/fila/pendencias" />
    </>
  );
  const canRelease = kind === "revisao" && (r.status === "em_janela_revisao" || r.status === "suspensa" || r.status === "pronta");
  const canRestrict = r.status === "em_janela_revisao" || r.status === "suspensa" || r.status === "aguardando_aprovacao";
  return (
    <div className="controls">
      {canRelease && (
        <form action={releaseAction}>{hidden}<button type="submit">{r.status === "suspensa" ? "Retomar e executar" : r.status === "pronta" ? "Executar agora" : "Liberar agora"}</button></form>
      )}
      {r.status !== "suspensa" && canRestrict && (
        <form action={decideAction}>{hidden}<input type="hidden" name="decision" value="suspensa" />
          <input name="note" placeholder="Motivo da suspensão" aria-label="Motivo da suspensão" /> <button type="submit">Suspender</button></form>
      )}
      {canRestrict && (
        <form action={decideAction}>{hidden}<input type="hidden" name="decision" value="rejeitada" />
          <input name="note" placeholder="Motivo da rejeição" aria-label="Motivo da rejeição" /> <button type="submit">Rejeitar</button></form>
      )}
      {kind === "aprovacao" && <p className="muted">A aprovação é do supervisor, no <Link href={`/fila/${r.caseId}`}>detalhe do caso</Link>.</p>}
    </div>
  );
}

export default async function PendingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await getCurrentStaff();
  if (!staff) return <main className="queue"><p>Conta sem funcionário ativo vinculado.</p></main>;
  const sp = await searchParams;
  const ok = typeof sp.ok === "string" ? sp.ok : null;
  const erro = typeof sp.erro === "string" ? sp.erro : null;

  const db = await createSessionClient();
  const { data: run } = await db.from("scenario_runs").select("id").eq("name", "demo").maybeSingle();
  const view = run ? await listPending(db, run.id) : null;

  return (
    <main className="queue">
      <p><Link href="/fila">← Fila</Link></p>
      <h1>Pendências de execução</h1>
      {ok && <p role="status" className="notice-ok">{ok}</p>}
      {erro && <p role="alert" className="notice-err">{erro}</p>}
      {!view ? <p>Cenário &quot;demo&quot; não encontrado.</p> : (
        <>
          <p className="muted">
            Relógio do cenário: {when(view.clock)}. A contagem usa esse relógio, que só avança quando o supervisor o avança na demonstração.
            Vencer a janela torna a ação elegível para a próxima rodada do processador; não a executa no segundo exato.
          </p>

          {staff.role === "supervisor" && (
            <section className="controls" aria-label="Ferramentas de demonstração">
              <h2>Demonstração (só no cenário demo)</h2>
              <form action={advanceClockAction}>
                <label>Avançar o relógio em <select name="hours" defaultValue="2"><option value="1">1 h</option><option value="2">2 h</option><option value="3">3 h</option><option value="24">24 h</option></select></label>{" "}
                <button type="submit">Avançar</button>
              </form>
              <form action={processNowAction}><button type="submit">Rodar o processador agora</button></form>
            </section>
          )}

          <h2>Revisão opcional · janela de duas horas</h2>
          <p className="muted">Ações que a política já autoriza sem aprovação. Funcionário autorizado pode liberar antes, suspender ou rejeitar com justificativa. Duas horas é configuração proposta do MVP.</p>
          <table>
            <thead><tr><th>Ação</th><th>Pedido</th><th>Situação</th><th>Fim da janela</th><th>Tarefa</th><th>Responsável</th><th>Controles</th></tr></thead>
            <tbody>
              {view.review.map((r) => (
                <tr key={r.proposalId}>
                  <td><Link href={`/fila/${r.caseId}`}>{ACTION_LABEL[r.action] ?? r.action}</Link><br />{brl(r.amountCents)}</td>
                  <td>{r.orderId ?? "—"}</td>
                  <td>{STATUS_LABEL[r.status] ?? r.status}</td>
                  <td>{when(r.executeAfter)}{r.countdown ? <><br /><strong>{r.countdown}</strong></> : null}</td>
                  <td>{r.task ? <>{TASK_LABEL[r.task.status] ?? r.task.status}{r.task.attempts ? ` · ${r.task.attempts} tentativa(s)` : ""}{r.task.lastError ? <><br /><span className="muted">{r.task.lastError}</span></> : null}</> : "—"}</td>
                  <td>{r.assigneeName ?? "—"}</td>
                  <td><Controls r={r} kind="revisao" /></td>
                </tr>
              ))}
              {view.review.length === 0 && <tr><td colSpan={7}>Nenhuma ação em janela de revisão.</td></tr>}
            </tbody>
          </table>

          <h2>Aprovação obrigatória</h2>
          <p className="muted">Acima da alçada: o timer nunca libera. Prazo vencido cobra e escala o supervisor; nunca aprova.</p>
          <table>
            <thead><tr><th>Ação</th><th>Pedido</th><th>Situação</th><th>Prazo da decisão</th><th>Escalonamento</th><th>Responsável</th><th>Controles</th></tr></thead>
            <tbody>
              {view.approvals.map((r) => (
                <tr key={r.proposalId}>
                  <td><Link href={`/fila/${r.caseId}`}>{ACTION_LABEL[r.action] ?? r.action}</Link><br />{brl(r.amountCents)}</td>
                  <td>{r.orderId ?? "—"}</td>
                  <td>{STATUS_LABEL[r.status] ?? r.status}</td>
                  <td>{when(r.approvalDueAt)}{r.countdown ? <><br /><strong>{r.countdown}</strong></> : null}</td>
                  <td>{r.escalationLevel ? `nível ${r.escalationLevel}` : "—"}</td>
                  <td>{r.assigneeName ?? "—"}</td>
                  <td><Controls r={r} kind="aprovacao" /></td>
                </tr>
              ))}
              {view.approvals.length === 0 && <tr><td colSpan={7}>Nenhuma aprovação pendente.</td></tr>}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
