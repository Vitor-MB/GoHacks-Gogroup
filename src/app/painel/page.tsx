import Link from "next/link";
import { getCurrentStaff } from "../../server/auth/session";
import { listQueue, type QueueItem } from "../../server/cases";
import { createSessionClient } from "../../server/db/client";

const REASON_LABEL: Record<string, string> = {
  aprovacao_supervisor: "Aprovação do supervisor", orientacao_e_encaminhamento: "Orientação e encaminhamento", acao_bloqueada: "Ação bloqueada",
  continuidade_humana: "Continuidade humana", execucao_falhou: "Execução falhou", proposta_rejeitada: "Proposta rejeitada",
  proposta_suspensa: "Proposta suspensa", revalidacao_bloqueada: "Revalidação bloqueou",
};
const TOPIC_LABEL: Record<string, string> = {
  rastreio_atraso: "Rastreio e atraso", troca_devolucao: "Troca ou devolução", avaria: "Avaria", personalizacao: "Personalização",
  brinde: "Brinde", reacao_adversa: "Reação adversa", cancelamento: "Cancelamento", outros: "Outros",
};
const brl = (c: number) => `R$ ${(c / 100).toFixed(2).replace(".", ",")}`;
const ATTENTION = new Set(["aguardando_aprovacao", "suspensa", "bloqueada", "falhou"]);

/** O que exige uma pessoa: caso aguardando humano ou proposta que depende de decisão. */
const needsHuman = (c: QueueItem) => c.status === "aguardando_humano" || (!!c.proposal && ATTENTION.has(c.proposal.status));

export default async function PanelPage() {
  const staff = await getCurrentStaff();
  if (!staff) return <main className="page"><p>Conta sem funcionário ativo vinculado.</p></main>;

  const db = await createSessionClient();
  const { data: run } = await db.from("scenario_runs").select("id, clock_now").eq("name", "demo").maybeSingle();
  const all = run ? await listQueue(db, run.id) : [];
  const items = all.filter(needsHuman);

  const kpis = [
    { label: "Aguardando aprovação", value: items.filter((c) => c.proposal?.status === "aguardando_aprovacao").length, tone: "blue" },
    { label: "Aprovações vencidas", value: items.filter((c) => c.proposal?.overdue).length, tone: "pink" },
    { label: "Sem responsável", value: items.filter((c) => !c.assignedTo).length, tone: "blue" },
    { label: "Prioridade alta", value: items.filter((c) => c.priority.level === "alta").length, tone: "pink" },
  ];

  return (
    <main className="page">
      <header className="page-head">
        <p className="eyebrow">Painel</p>
        <h1>Olá, {staff.fullName.split(" ")[0]}</h1>
        <p className="muted">
          {run ? `Relógio do cenário: ${new Date(run.clock_now).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.` : "Cenário demo não encontrado."}{" "}
          Casos que aguardam uma decisão ou ação de pessoa, do mais urgente ao menos.
        </p>
      </header>

      <section className="kpis" aria-label="Resumo">
        {kpis.map((k) => (
          <div key={k.label} className={`kpi kpi-${k.tone}`}>
            <strong>{k.value}</strong>
            <span>{k.label}</span>
          </div>
        ))}
      </section>

      <section aria-labelledby="para-verificar">
        <div className="section-head">
          <h2 id="para-verificar">Para verificar</h2>
          <Link href="/fila">Ver toda a fila</Link>
        </div>
        <table>
          <thead><tr><th>Prioridade</th><th>Assunto</th><th>Pedido</th><th>Motivo / decisão pedida</th><th>Responsável</th></tr></thead>
          <tbody>
            {items.slice(0, 12).map((c) => (
              <tr key={c.id}>
                <td><span className={`badge badge-${c.priority.level}`}>{c.priority.level}</span></td>
                <td><Link href={`/fila/${c.id}`}>{TOPIC_LABEL[c.topic] ?? c.topic}</Link></td>
                <td>{c.orderId ?? "—"}{c.proposal?.amountCents ? <><br /><span className="muted">{brl(c.proposal.amountCents)}</span></> : null}</td>
                <td>{c.handoffReason ? <strong>{REASON_LABEL[c.handoffReason] ?? c.handoffReason}</strong> : "—"}{c.proposal?.overdue ? <> · <span className="badge badge-alta">vencida</span></> : null}{c.decisionRequested ? <><br />{c.decisionRequested}</> : null}</td>
                <td>{c.assigneeName ?? "—"}</td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={5}>Nada aguardando verificação agora.</td></tr>}
          </tbody>
        </table>
        {items.length > 12 && <p className="muted">Mostrando 12 de {items.length}. <Link href="/fila">Abrir a fila completa</Link>.</p>}
      </section>
    </main>
  );
}
