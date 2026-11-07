import Link from "next/link";
import { getCurrentStaff } from "../../server/auth/session";
import { countTabs, filterResolved, isLow, parsePeriod, parseRTab, PERIOD_LABEL, scoreSummary, type Period, type RTab } from "../../server/resolved-model";
import { getResolved } from "../../server/resolved";
import { waitLabel } from "../../server/supervision-model";

const CHANNEL_LABEL: Record<string, string> = { whatsapp: "WhatsApp", email: "E-mail", reclame_aqui: "Reclame Aqui" };
const TOPIC_LABEL: Record<string, string> = {
  rastreio_atraso: "Rastreio e atraso", troca_devolucao: "Troca ou devolução", avaria: "Avaria", personalizacao: "Personalização",
  brinde: "Brinde", reacao_adversa: "Reação adversa", cancelamento: "Cancelamento", outros: "Outros",
};
const brl = (c: number) => `R$ ${(c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MAX_ROWS = 100;

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

interface Q { aba?: RTab; periodo?: Period; canal?: string; q?: string }
function href(p: Q) {
  const sp = new URLSearchParams();
  if (p.aba && p.aba !== "todos") sp.set("aba", p.aba);
  if (p.periodo && p.periodo !== "7") sp.set("periodo", p.periodo);
  if (p.canal) sp.set("canal", p.canal);
  if (p.q) sp.set("q", p.q);
  const s = sp.toString();
  return s ? `/resolvidos?${s}` : "/resolvidos";
}

export default async function ResolvedPage({ searchParams }: { searchParams: Promise<Params> }) {
  const staff = await getCurrentStaff();
  if (!staff) return <main className="page"><p>Conta sem funcionário ativo vinculado.</p></main>;

  const sp = await searchParams;
  const tab = parseRTab(one(sp.aba));
  const periodo = parsePeriod(one(sp.periodo));
  const canalRaw = one(sp.canal);
  const canal = canalRaw && canalRaw in CHANNEL_LABEL ? canalRaw : undefined;
  const q = one(sp.q)?.slice(0, 80);

  const { clockMs, rows: all } = await getResolved();
  // As abas contam sobre o período, o canal e a busca; assim o número bate com a lista ao clicar.
  const scope = filterResolved(all, { period: periodo, canal, q }, clockMs);
  const counts = countTabs(scope);
  const shown = filterResolved(all, { tab, period: periodo, canal, q }, clockMs);
  const visible = shown.slice(0, MAX_ROWS);
  const score = scoreSummary(scope);

  const tabs: { key: RTab; label: string }[] = [
    { key: "todos", label: "Todos" }, { key: "gobia", label: "Pela GoBIA" }, { key: "pessoa", label: "Com pessoa" }, { key: "baixa", label: "Nota baixa" },
  ];

  return (
    <main className="page sv">
      <header className="sv-head">
        <h1>Atendimentos resolvidos</h1>
        <p className="muted">
          {counts.todos} {counts.todos === 1 ? "atendimento resolvido" : "atendimentos resolvidos"} ({PERIOD_LABEL[periodo].toLowerCase()}, no relógio do cenário).
          {" "}A nota é a avaliação dada pelo cliente ao fim da conversa: sem resposta, não há nota.
          {score.answered > 0 ? ` Média ${score.mean!.toFixed(1).replace(".", ",")} de 5, com ${score.answered} de ${score.total} respostas.` : score.total > 0 ? " Nenhuma pesquisa respondida ainda." : ""}
        </p>
      </header>

      <div className="sv-toolbar">
        <nav className="sv-tabs" aria-label="Filtrar por quem resolveu">
          {tabs.map((t) => (
            <Link key={t.key} href={href({ aba: t.key, periodo, canal, q })} className={t.key === tab ? "is-on" : undefined} aria-current={t.key === tab ? "true" : undefined}>
              {t.label} <b>{counts[t.key]}</b>
            </Link>
          ))}
        </nav>
        <div className="rs-menus">
          <details className="sv-select">
            <summary>Canal: {canal ? CHANNEL_LABEL[canal] : "todos"}</summary>
            <ul>
              <li><Link href={href({ aba: tab, periodo, q })}>Todos</Link></li>
              {Object.entries(CHANNEL_LABEL).map(([k, v]) => <li key={k}><Link href={href({ aba: tab, periodo, canal: k, q })}>{v}</Link></li>)}
            </ul>
          </details>
          <details className="sv-select">
            <summary>{PERIOD_LABEL[periodo]}</summary>
            <ul>
              {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => <li key={p}><Link href={href({ aba: tab, periodo: p, canal, q })}>{PERIOD_LABEL[p]}</Link></li>)}
            </ul>
          </details>
        </div>
      </div>

      {q && <p className="muted">Busca por “{q}”: {shown.length} {shown.length === 1 ? "resultado" : "resultados"}. <Link href={href({ aba: tab, periodo, canal })}>Limpar busca</Link></p>}

      <div className="sv-card">
        <table className="sv-table rs-table">
          <thead>
            <tr><th>Cliente e canal</th><th>Resumo do atendimento</th><th>Resolvido por</th><th>Duração</th><th>Valor</th><th>Nota</th><th><span className="sr-only">Ação</span></th></tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.customerName ?? (r.customerId ? `Cliente ${r.customerId}` : "Cliente não identificado")}</strong>
                  <span className="sv-sub">{r.channels.map((c) => CHANNEL_LABEL[c] ?? c).join(", ") || "Canal desconhecido"}, {r.orderId ?? "sem pedido"}</span>
                </td>
                <td>
                  <span className="sv-clamp">{r.summary ?? TOPIC_LABEL[r.topic] ?? r.topic}</span>
                  {r.reopened && <span className="sv-sub">Já foi reaberto antes deste encerramento</span>}
                </td>
                <td>
                  <span className={r.mode === "autonoma" ? "sv-pill sv-pill-blue" : "sv-pill rs-pill-person"}>{r.mode === "autonoma" ? "GoBIA" : "Com pessoa"}</span>
                  {r.mode === "assistida" && r.resolverName && <span className="sv-sub">{r.resolverName}</span>}
                </td>
                <td><span className="rs-dur">{waitLabel(r.durationMs)}</span></td>
                <td>{r.amountCents !== null ? <span className="sv-money">{brl(r.amountCents)}</span> : <span className="sv-sub">Sem valor</span>}</td>
                <td>
                  {r.score !== null
                    ? <span className={isLow(r) ? "rs-score rs-score-low" : "rs-score"}>{r.score}<small>/5</small></span>
                    : <span className="sv-sub">{r.surveyStatus === "aguardando" ? "Aguardando resposta" : r.surveyStatus === "sem_pesquisa" ? "Sem pesquisa" : "Sem resposta"}</span>}
                </td>
                <td><Link href={`/fila/${r.id}`} className="sv-open">Abrir</Link></td>
              </tr>
            ))}
            {visible.length === 0 && <tr><td colSpan={7} className="sv-empty">{all.length === 0 ? "Nenhum atendimento resolvido ainda." : "Nenhum atendimento neste filtro."}</td></tr>}
          </tbody>
        </table>
      </div>
      {shown.length > MAX_ROWS && <p className="muted">Mostrando {MAX_ROWS} de {shown.length}. Use o período, o canal ou a busca para afunilar.</p>}
      <p className="muted sv-foot">Duração = do primeiro contato ao encerramento mais recente, no relógio do cenário. Valor = da última ação concluída ou, sem ação, o total do pedido. Nota baixa = 3 ou menos. Quem resolveu vem do tipo de encerramento: GoBIA (autônomo) ou com pessoa (assistido).</p>
    </main>
  );
}
