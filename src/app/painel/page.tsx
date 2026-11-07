import Link from "next/link";
import { getCurrentStaff } from "../../server/auth/session";
import { createSessionClient } from "../../server/db/client";
import { getSupervisionQueue } from "../../server/supervision";
import { countTabs, filterRows, parseTab, reasonLines, requiresSupervisor, waitLabel, waitTone, type Tab } from "../../server/supervision-model";

const CHANNEL_LABEL: Record<string, string> = { whatsapp: "WhatsApp", email: "E-mail", reclame_aqui: "Reclame Aqui" };
const TOPIC_LABEL: Record<string, string> = {
  rastreio_atraso: "Rastreio e atraso", troca_devolucao: "Troca ou devolução", avaria: "Avaria", personalizacao: "Personalização",
  brinde: "Brinde", reacao_adversa: "Reação adversa", cancelamento: "Cancelamento", outros: "Outros",
};
const brl = (c: number) => `R$ ${(c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MAX_ROWS = 50;

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

function href(p: { aba?: Tab; canal?: string; q?: string }) {
  const sp = new URLSearchParams();
  if (p.aba && p.aba !== "todos") sp.set("aba", p.aba);
  if (p.canal) sp.set("canal", p.canal);
  if (p.q) sp.set("q", p.q);
  const s = sp.toString();
  return s ? `/painel?${s}` : "/painel";
}

export default async function PanelPage({ searchParams }: { searchParams: Promise<Params> }) {
  const staff = await getCurrentStaff();
  if (!staff) return <main className="page"><p>Conta sem funcionário ativo vinculado.</p></main>;

  const sp = await searchParams;
  const tab = parseTab(one(sp.aba));
  const canalRaw = one(sp.canal);
  const canal = canalRaw && canalRaw in CHANNEL_LABEL ? canalRaw : undefined;
  const q = one(sp.q)?.slice(0, 80);

  const { runName, clockNow, rows: all } = await getSupervisionQueue();
  const counts = countTabs(all);
  const shown = filterRows(all, { tab, canal, q });
  const visible = shown.slice(0, MAX_ROWS);

  // Disponibilidade da IA: o aviso explica por que casos novos podem demorar e quando uma pessoa assume.
  const db = await createSessionClient();
  const [{ data: circuit }, { count: waiting }] = await Promise.all([
    db.from("ai_circuit").select("state").eq("name", "proxy").maybeSingle(),
    db.from("investigation_tasks").select("id", { count: "exact", head: true }).in("status", ["pendente", "reservada"]).not("last_error_kind", "is", null),
  ]);
  const aiDegraded = (!!circuit && circuit.state !== "closed") || (waiting ?? 0) > 0;

  const tabs: { key: Tab; label: string }[] = [
    { key: "todos", label: "Todos" }, { key: "supervisor", label: "Exigem supervisor" }, { key: "agente", label: "Atendimento pode resolver" },
  ];

  return (
    <main className="page sv">
      <header className="sv-head">
        <h1>Fila de supervisão</h1>
        <p className="muted">
          {all.length === 0 ? "Nenhum processo esperando uma decisão agora." : `${all.length} ${all.length === 1 ? "processo esperando" : "processos esperando"} uma decisão. Os que exigem supervisor só andam com a aprovação.`}
          {clockNow ? ` Relógio do cenário: ${new Date(clockNow).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}.` : runName === null ? " Cenário demo não encontrado." : ""}
        </p>
      </header>

      {aiDegraded && (
        <p role="status" className="sv-notice"><strong>IA instável ou indisponível.</strong> Novos casos já receberam a confirmação de recebimento e esperam nova tentativa{(waiting ?? 0) > 0 ? ` (${waiting} aguardando)` : ""}. Se a IA não voltar a tempo, o caso aparece aqui com o motivo “IA indisponível” para uma pessoa assumir. Nenhuma ação é aprovada ou executada nesse período.</p>
      )}

      <div className="sv-toolbar">
        <nav className="sv-tabs" aria-label="Filtrar a fila">
          {tabs.map((t) => (
            <Link key={t.key} href={href({ aba: t.key, canal, q })} className={t.key === tab ? "is-on" : undefined} aria-current={t.key === tab ? "true" : undefined}>
              {t.label} <b>{counts[t.key]}</b>
            </Link>
          ))}
        </nav>
        <details className="sv-select">
          <summary>Canal: {canal ? CHANNEL_LABEL[canal] : "todos"}</summary>
          <ul>
            <li><Link href={href({ aba: tab, q })}>Todos</Link></li>
            {Object.entries(CHANNEL_LABEL).map(([k, v]) => <li key={k}><Link href={href({ aba: tab, canal: k, q })}>{v}</Link></li>)}
          </ul>
        </details>
      </div>

      {q && <p className="muted">Busca por “{q}”: {shown.length} {shown.length === 1 ? "resultado" : "resultados"}. <Link href={href({ aba: tab, canal })}>Limpar busca</Link></p>}

      <div className="sv-card">
        <table className="sv-table">
          <thead>
            <tr><th>Cliente e canal</th><th>Resumo do agente</th><th>Item e valor</th><th>Motivo</th><th>Espera</th><th><span className="sr-only">Ação</span></th></tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const sup = requiresSupervisor(r);
              return (
                <tr key={r.id}>
                  <td>
                    <strong>{r.customerName ?? (r.customerId ? `Cliente ${r.customerId}` : "Cliente não identificado")}</strong>
                    <span className="sv-sub">{r.channels.map((c) => CHANNEL_LABEL[c] ?? c).join(", ") || "Canal desconhecido"}, {r.orderId ?? "sem pedido"}</span>
                  </td>
                  <td><span className="sv-clamp">{r.decisionRequested ?? r.summary ?? TOPIC_LABEL[r.topic] ?? r.topic}</span></td>
                  <td>
                    <strong>{r.itemLabel ?? (TOPIC_LABEL[r.topic] ?? r.topic)}</strong>
                    <span className="sv-sub sv-money">{r.amountCents !== null ? brl(r.amountCents) : "Valor indisponível"}</span>
                  </td>
                  <td>
                    <span className={sup ? "sv-pill sv-pill-red" : "sv-pill sv-pill-blue"}>{sup ? "Exige supervisor" : "Atendimento pode resolver"}</span>
                    {reasonLines(r).map((l) => <span key={l} className="sv-sub">{l}</span>)}
                  </td>
                  <td><span className={`sv-wait sv-wait-${waitTone(r.waitMs)}`}>{waitLabel(r.waitMs)}</span></td>
                  <td><Link href={`/fila/${r.id}`} className="sv-open">Abrir</Link></td>
                </tr>
              );
            })}
            {visible.length === 0 && <tr><td colSpan={6} className="sv-empty">{all.length === 0 ? "Nada aguardando decisão agora." : "Nenhum processo neste filtro."}</td></tr>}
          </tbody>
        </table>
      </div>
      {shown.length > MAX_ROWS && <p className="muted">Mostrando {MAX_ROWS} de {shown.length}. <Link href="/fila">Abrir todos os casos</Link>.</p>}
      <p className="muted sv-foot">Espera = tempo desde a abertura do contato, no relógio do cenário. Valor = valor da proposta ou, sem proposta, total do pedido.</p>
    </main>
  );
}
