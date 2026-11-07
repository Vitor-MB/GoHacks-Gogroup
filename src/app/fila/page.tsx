import Link from "next/link";
import { getCurrentStaff } from "../../server/auth/session";
import { filterQueue, listQueue, type QueueFilters } from "../../server/cases";
import { createSessionClient } from "../../server/db/client";

const CHANNEL_LABEL = { whatsapp: "WhatsApp", email: "E-mail", reclame_aqui: "Reclame Aqui" } as const;
const TOPIC_LABEL: Record<string, string> = {
  rastreio_atraso: "Rastreio e atraso", troca_devolucao: "Troca ou devolução", avaria: "Avaria",
  personalizacao: "Personalização", brinde: "Brinde", reacao_adversa: "Reação adversa",
  cancelamento: "Cancelamento", outros: "Outros",
};
const STATUS_LABEL: Record<string, string> = {
  novo: "Novo", em_investigacao: "Em investigação", aguardando_cliente: "Aguardando cliente", aguardando_humano: "Aguardando pessoa",
  aguardando_terceiro: "Aguardando terceiro", em_execucao: "Em execução", reaberto: "Reaberto",
};
const REASON_LABEL: Record<string, string> = {
  aprovacao_supervisor: "Aprovação do supervisor", orientacao_e_encaminhamento: "Orientação e encaminhamento", acao_bloqueada: "Ação bloqueada",
  continuidade_humana: "Continuidade humana", ia_indisponivel: "IA indisponível", execucao_falhou: "Execução falhou", proposta_rejeitada: "Proposta rejeitada",
  proposta_suspensa: "Proposta suspensa", revalidacao_bloqueada: "Revalidação bloqueou",
};
const ACTION_LABEL: Record<string, string> = {
  reembolsar: "reembolso", reenviar_produto: "reenvio", reimprimir_personalizacao: "reimpressão", trocar_produto: "troca",
  cancelar_pedido: "cancelamento", abrir_chamado_transportadora: "chamado à transportadora",
};
const brl = (c: number) => `R$ ${(c / 100).toFixed(2).replace(".", ",")}`;

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function QueuePage({ searchParams }: { searchParams: Promise<Params> }) {
  const staff = await getCurrentStaff();
  if (!staff) return <main className="queue"><p>Conta sem funcionário ativo vinculado.</p></main>;

  const sp = await searchParams;
  const filters: QueueFilters = {
    canal: one(sp.canal) as QueueFilters["canal"], situacao: one(sp.situacao), responsavel: one(sp.responsavel),
    prazo: one(sp.prazo), motivo: one(sp.motivo),
  };

  const db = await createSessionClient();
  const { data: run } = await db.from("scenario_runs").select("id, clock_now").eq("name", "demo").maybeSingle();
  const all = run ? await listQueue(db, run.id) : [];
  const items = filterQueue(all, filters, staff.id);

  return (
    <main className="queue">
      <h1>Fila de atendimento</h1>
      <p><Link href="/fila/pendencias">Pendências de execução: janela de revisão e aprovações</Link></p>
      {run ? <p className="muted">Relógio do cenário: {new Date(run.clock_now).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</p> : <p>Cenário &quot;demo&quot; não encontrado.</p>}

      <form method="get" className="filters">
        <label>Canal
          <select name="canal" defaultValue={filters.canal ?? ""}>
            <option value="">Todos</option>
            {Object.entries(CHANNEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Situação
          <select name="situacao" defaultValue={filters.situacao ?? ""}>
            <option value="">Todas</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Responsável
          <select name="responsavel" defaultValue={filters.responsavel ?? ""}>
            <option value="">Todos</option>
            <option value="eu">Eu</option>
            <option value="sem">Sem responsável</option>
          </select>
        </label>
        <label>Prazo
          <select name="prazo" defaultValue={filters.prazo ?? ""}>
            <option value="">Todos</option>
            <option value="vencido">Aprovação vencida</option>
            <option value="em_prazo">Aprovação em prazo</option>
          </select>
        </label>
        <label>Motivo
          <select name="motivo" defaultValue={filters.motivo ?? ""}>
            <option value="">Todos</option>
            {Object.entries(REASON_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <button type="submit">Filtrar</button> <Link href="/fila">Limpar</Link>
      </form>

      <table>
        <thead><tr><th>Prioridade</th><th>Assunto</th><th>Pedido</th><th>Canais</th><th>Situação</th><th>Motivo / decisão pedida</th><th>Responsável</th></tr></thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td title={c.priority.reasons.join("\n")}>
                <strong className={`prio prio-${c.priority.level}`}>{c.priority.level}</strong>
                <details><summary>por quê</summary><ul>{c.priority.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></details>
              </td>
              <td><Link href={`/fila/${c.id}`}>{TOPIC_LABEL[c.topic] ?? c.topic}</Link></td>
              <td>{c.orderId ?? "—"}{c.proposal?.amountCents ? <><br />{ACTION_LABEL[c.proposal.action] ?? c.proposal.action} {brl(c.proposal.amountCents)}</> : null}</td>
              <td>{c.channels.map((ch) => CHANNEL_LABEL[ch]).join(", ")}</td>
              <td>{c.clarification ? "Pendente de esclarecimento" : STATUS_LABEL[c.status] ?? c.status}{c.proposal?.overdue ? <><br /><strong>aprovação vencida</strong></> : null}</td>
              <td>{c.handoffReason ? <strong>{REASON_LABEL[c.handoffReason] ?? c.handoffReason}</strong> : "—"}{c.decisionRequested ? <><br />{c.decisionRequested}</> : null}</td>
              <td>{c.assigneeName ?? "—"}</td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={7}>Nenhum caso na fila{all.length ? " com esses filtros" : ""}.</td></tr>}
        </tbody>
      </table>
    </main>
  );
}
