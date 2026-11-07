// Estatísticas (GOB-11). Histórico importado, execução do MVP (simulada) e projeções ficam em abas SEPARADAS.
// Todo percentual mostra o denominador; custo indisponível aparece como tal; pesquisa sem resposta não é satisfação.
import Link from "next/link";
import { getCurrentStaff } from "../../server/auth/session";
import { createSessionClient } from "../../server/db/client";
import { channelCounts, historyByMonth, meanScore, mvpResolutionsByDay, scoreDistribution } from "../../server/metrics/charts";
import { loadHistory, loadMvp, type StatsFilters } from "../../server/metrics/load";
import { CHANNELS, computeHistory, computeMvp, DEFAULT_REOPEN_WINDOW_DAYS, type Channel } from "../../server/metrics/model";
import { BarsH, ChartCard, ColumnsStacked, Empty, Kpi, type Bar } from "./charts";

const CHANNEL_LABEL: Record<Channel, string> = { whatsapp: "WhatsApp", email: "E-mail", reclame_aqui: "Reclame Aqui" };
const REASON_LABEL: Record<string, string> = {
  aprovacao_registrada: "Aprovação registrada", caso_atribuido: "Caso atribuído", proposta_ajustada: "Proposta ajustada", encaminhamento_humano: "Encaminhamento humano",
  janela_revisao_liberada: "Janela de revisão liberada", responsavel_atribuido: "Responsável atribuído", aprovacao_humana: "Aprovação humana", encerrado_por_pessoa: "Encerrado por pessoa",
  revisao_pesquisa_concluida: "Revisão de pesquisa concluída",
};
const HYP_LABEL: Record<string, string> = {
  transporte: "Transporte", producao_personalizacao: "Produção / personalização", separacao_embalagem: "Separação / embalagem", produto_lote: "Produto / lote",
  pagamento_cadastro: "Pagamento / cadastro", indeterminada: "Indeterminada",
};
const ORIGIN_STATUS: Record<string, string> = { hipotese: "hipótese", confirmada: "confirmada", nao_investigada: "não investigada" };
const SCORE_TONE: Record<number, string> = { 5: "green", 4: "blue", 3: "amber", 2: "orange", 1: "pink" };

const nf = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const n0 = (v: number) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(v);
const pct = (num: number, den: number) => (den > 0 ? `${nf.format((num / den) * 100)}%` : "sem base");
const usd = (v: number) => `US$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`;
const brl = (c: number) => `R$ ${(c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dur = (h: number) => (h < 1 ? `${nf.format(h * 60)} min` : h < 48 ? `${nf.format(h)} h` : `${nf.format(h / 24)} d`);

type Fonte = "mvp" | "historico" | "projecoes";
const FONTES: { key: Fonte; label: string; note?: string }[] = [
  { key: "mvp", label: "Execução do MVP", note: "simulada" },
  { key: "historico", label: "Histórico importado" },
  { key: "projecoes", label: "Projeções", note: "premissa" },
];

const scoreBars = (dist: { score: number; count: number }[]): Bar[] => dist.map((d) => ({ label: `${d.score}`, value: d.count, tone: SCORE_TONE[d.score] }));

export default async function StatsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await getCurrentStaff();
  if (!staff) return <main className="page"><p>Conta sem funcionário ativo vinculado.</p></main>;
  if (staff.role === "atendente") {
    return <main className="page"><header className="page-head"><h1>Acesso restrito</h1><p className="muted">As estatísticas são para supervisor e analista.</p></header></main>;
  }

  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" && sp[k] !== "" ? (sp[k] as string) : null);
  const fonte: Fonte = one("fonte") === "historico" ? "historico" : one("fonte") === "projecoes" ? "projecoes" : "mvp";
  const db = await createSessionClient();
  const [runs, units, brands] = await Promise.all([
    db.from("scenario_runs").select("id, name").order("created_at"),
    db.from("business_units").select("id, name").order("name"),
    db.from("brands").select("id, name").order("name"),
  ]);
  const runList = (runs.data ?? []) as { id: string; name: string }[];
  const runId = one("cenario") ?? runList.find((r) => r.name === "demo")?.id ?? runList[0]?.id ?? null;
  const date = (k: string) => { const v = one(k); return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; };
  const ch = one("canal");
  const reopen = Number(one("janela"));
  const assumed = Number(one("premissa"));
  const filters: StatsFilters = {
    runId, from: date("de"), to: date("ate"), channel: ch && (CHANNELS as string[]).includes(ch) ? (ch as Channel) : null,
    unit: one("unidade"), brand: one("marca"), model: one("modelo"),
    reopenDays: Number.isFinite(reopen) && reopen >= 1 && reopen <= 90 ? Math.round(reopen) : DEFAULT_REOPEN_WINDOW_DAYS,
    assumedMinutes: one("premissa") !== null && Number.isFinite(assumed) && assumed > 0 ? assumed : null,
  };
  const activeFilters = [filters.from, filters.to, filters.channel, filters.unit, filters.brand, filters.model, filters.assumedMinutes,
    filters.reopenDays !== DEFAULT_REOPEN_WINDOW_DAYS ? filters.reopenDays : null, one("cenario") && one("cenario") !== runList.find((r) => r.name === "demo")?.id ? one("cenario") : null]
    .filter((v) => v !== null && v !== "").length;

  const [mvpLoad, hist, modelRows] = await Promise.all([
    loadMvp(db, filters), loadHistory(db, filters),
    runId ? db.from("ai_usage").select("served_model, requested_model").eq("scenario_run_id", runId).limit(1000) : Promise.resolve({ data: [] }),
  ]);
  const mvp = computeMvp(mvpLoad.input);
  const h = computeHistory(hist.conversations, hist.surveys);
  const modelOptions = [...new Set(((modelRows.data ?? []) as { served_model: string | null; requested_model: string | null }[]).map((r) => r.served_model ?? r.requested_model).filter((m): m is string => !!m))];
  const r = mvp.resolution;

  const tabHref = (f: Fonte) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && v !== "" && k !== "fonte") q.set(k, v);
    if (f !== "mvp") q.set("fonte", f);
    const s = q.toString();
    return s ? `/estatisticas?${s}` : "/estatisticas";
  };

  const mvpScores = mvpLoad.input.surveys.filter((s) => s.status === "respondida").map((s) => s.score);
  const histScores = hist.surveys.filter((s) => s.answered).map((s) => s.score);
  const mvpDist = scoreDistribution(mvpScores);
  const histDist = scoreDistribution(histScores);
  const mvpMean = meanScore(mvpScores);
  const histMean = meanScore(histScores);

  return (
    <main className="page st">
      <header className="st-head">
        <div>
          <h1>Estatísticas</h1>
          <p className="muted">
            {fonte === "mvp" ? `Execução do MVP, simulada${mvpLoad.runName ? ` · cenário ${mvpLoad.runName}` : ""}${mvpLoad.clockNow ? ` · relógio ${new Date(mvpLoad.clockNow).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}` : ""}`
              : fonte === "historico" ? "Histórico importado: conversas encerradas até 02/11/2026, amostra de 1 em cada 4 clientes"
                : "Projeções: derivam de premissas, não de medição"}
          </p>
        </div>

        <details className="st-filters">
          <summary>Filtros{activeFilters > 0 ? <b>{activeFilters}</b> : null}</summary>
          <form method="get" aria-label="Filtros das estatísticas">
            {fonte !== "mvp" && <input type="hidden" name="fonte" value={fonte} />}
            <label>Cenário<select name="cenario" defaultValue={runId ?? ""}>{runList.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
            <label>De<input type="date" name="de" defaultValue={filters.from ?? ""} /></label>
            <label>Até<input type="date" name="ate" defaultValue={filters.to ?? ""} /></label>
            <label>Canal<select name="canal" defaultValue={filters.channel ?? ""}><option value="">Todos</option>{CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}</select></label>
            <label>Unidade<select name="unidade" defaultValue={filters.unit ?? ""}><option value="">Todas</option>{(units.data ?? []).map((u) => <option key={u.id as string} value={u.id as string}>{u.name as string}</option>)}</select></label>
            <label>Marca<select name="marca" defaultValue={filters.brand ?? ""}><option value="">Todas</option>{(brands.data ?? []).map((b) => <option key={b.id as string} value={b.id as string}>{b.name as string}</option>)}</select></label>
            <label>Modelo<select name="modelo" defaultValue={filters.model ?? ""}><option value="">Todos</option>{modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
            <label>Janela de reabertura (dias)<input type="number" name="janela" min={1} max={90} defaultValue={filters.reopenDays ?? DEFAULT_REOPEN_WINDOW_DAYS} /></label>
            <label>Minutos humanos por caso (premissa)<input type="number" name="premissa" min={1} step="any" defaultValue={filters.assumedMinutes ?? ""} placeholder="opcional" /></label>
            <div className="st-filters-actions">
              <button type="submit">Aplicar</button>
              <Link href={fonte === "mvp" ? "/estatisticas" : `/estatisticas?fonte=${fonte}`}>Limpar</Link>
            </div>
            <p className="muted">Cenário e modelo valem só para o MVP. Período usa a data de abertura (Brasília).</p>
          </form>
        </details>
      </header>

      <nav className="st-tabs" aria-label="Fonte dos dados">
        {FONTES.map((f) => (
          <Link key={f.key} href={tabHref(f.key)} className={f.key === fonte ? "is-on" : undefined} aria-current={f.key === fonte ? "page" : undefined}>
            {f.label}{f.note ? <small>{f.note}</small> : null}
          </Link>
        ))}
      </nav>

      {fonte === "mvp" && (
        <>
          <div className="st-kpis">
            <Kpi label="Casos resolvidos" value={n0(r.resolvedTotal)} sub={`de ${n0(mvp.received)} recebidos · ${r.resolvedAutonomous} autônomos · ${r.resolvedAssisted} assistidos`} />
            <Kpi label="Resolução autônoma" value={r.eligible > 0 ? pct(r.eligibleResolvedAutonomous, r.eligible) : "sem base"} sub={r.eligible > 0 ? `${r.eligibleResolvedAutonomous} de ${r.eligible} elegíveis` : "nenhum caso elegível"} />
            <Kpi label="Satisfação (notas 4–5)" value={mvp.csat.csat !== null ? pct(mvp.csat.satisfied, mvp.csat.answered) : "sem respostas"} sub={`${mvp.csat.answered} de ${mvp.csat.surveysRequested} respostas (${pct(mvp.csat.answered, mvp.csat.surveysRequested)})`} />
            <Kpi label="Precisaram de pessoa" value={n0(mvp.interventions.casesWithIntervention)} sub={`de ${n0(mvp.interventions.casesTotal)} casos (${pct(mvp.interventions.casesWithIntervention, mvp.interventions.casesTotal)})`} tone="pink" />
            <Kpi label="Tempo mediano de resolução" value={mvp.resolutionTimeHours ? dur(mvp.resolutionTimeHours.median) : "sem amostra"} sub={mvp.resolutionTimeHours ? `n = ${mvp.resolutionTimeHours.n} · P90 ${dur(mvp.resolutionTimeHours.p90)}` : "nenhum caso resolvido"} />
            <Kpi label="Custo de IA por caso" value={mvp.cost.perResolvedUsd !== null ? usd(mvp.cost.perResolvedUsd) : "indisponível"} sub={mvp.cost.perResolvedUsd !== null ? `${mvp.cost.resolvedKnown} de ${mvp.cost.resolvedCases} resolvidos` : "o proxy informa só tokens"} tone="muted" />
          </div>

          <div className="st-grid">
            <ChartCard title="Resoluções por dia" sub="Encerramento válido mais recente de cada caso" wide>
              <ColumnsStacked name="Resoluções por dia" aLabel="Autônoma" bLabel="Assistida" data={mvpResolutionsByDay(mvpLoad.input.cases).map((p) => ({ label: p.label, a: p.a, b: p.b }))} />
            </ChartCard>
            <ChartCard title="Notas dos clientes" sub={mvpMean !== null ? `${mvpScores.filter((s) => s !== null).length} avaliações · média ${nf.format(mvpMean)} de 5` : "nenhuma avaliação"}>
              <BarsH name="Notas dos clientes" rows={scoreBars(mvpDist)} />
            </ChartCard>
            <ChartCard title="Casos por canal" sub={`${mvp.received} casos no filtro`}>
              <BarsH name="Casos por canal" rows={channelCounts(mvpLoad.input.cases.map((c) => c.channel)).map((c) => ({ label: CHANNEL_LABEL[c.channel], value: c.count }))} />
            </ChartCard>
            <ChartCard title="Por que uma pessoa entrou no caso" sub={`${mvp.interventions.casesWithIntervention} de ${mvp.interventions.casesTotal} casos`}>
              <BarsH name="Motivos de intervenção" rows={mvp.interventions.reasons.map((x) => ({ label: REASON_LABEL[x.reason] ?? x.reason.replace(/_/g, " "), value: x.count, tone: "pink" }))} />
            </ChartCard>
            <ChartCard title="Primeira resposta no prazo" sub="Por canal; só resposta substantiva conta">
              <BarsH name="Primeira resposta no prazo por canal" max={100} rows={CHANNELS.map((c) => {
                const b = mvp.firstResponse.byChannel[c];
                const den = b.responded + b.unansweredOverdue;
                return { label: CHANNEL_LABEL[c], value: den > 0 ? (b.withinSla / den) * 100 : 0, display: den > 0 ? `${b.withinSla} de ${den}` : "sem base", tone: "green" };
              })} />
            </ChartCard>
            <ChartCard title="Origem investigada" sub="Hipótese e causa confirmada separadas">
              <BarsH name="Origem investigada" rows={mvp.origins.map((o) => ({ label: `${HYP_LABEL[o.hypothesis] ?? o.hypothesis} (${ORIGIN_STATUS[o.status] ?? o.status})`, value: o.count, display: `${o.count} de ${mvp.received}`, tone: o.status === "confirmada" ? "green" : "blue" }))} />
            </ChartCard>
            <ChartCard title="Modelos de IA" sub="Tokens e custo só quando o proxy informa" wide>
              {mvp.models.length === 0 ? <Empty text="Nenhuma chamada de IA registrada neste filtro." /> : (
                <div className="st-table-wrap">
                  <table className="st-table">
                    <thead><tr><th>Modelo · etapa</th><th>Camada</th><th>Chamadas</th><th>Tokens</th><th>Latência</th><th>Custo</th></tr></thead>
                    <tbody>{mvp.models.map((m) => (
                      <tr key={`${m.model}|${m.step}|${m.tier ?? ""}`}>
                        <td>{m.model} · {m.step}{m.failures ? <span className="st-warn"> · {m.failures} falha(s)</span> : null}</td>
                        <td>{m.tier ?? "—"}{m.routeSwitches ? ` · ${m.routeSwitches} troca(s)` : ""}</td>
                        <td>{m.calls}</td>
                        <td>{m.tokensUnknownCalls === m.calls ? "indisponível" : n0(m.promptTokens + m.completionTokens)}</td>
                        <td>{m.latencyMs ? `${n0(m.latencyMs.mean)} ms` : "indisponível"}</td>
                        <td>{m.costUnknownCalls === m.calls ? "indisponível" : usd(m.costUsd)}</td>
                      </tr>))}</tbody>
                  </table>
                </div>
              )}
            </ChartCard>
            <ChartCard title="Qualidade operacional">
              <ul className="st-list">
                <li><span>Execuções que falharam</span><b>{mvp.quality.falhas}</b></li>
                <li><span>Retentativas</span><b>{mvp.quality.retentativas}</b></li>
                <li><span>Bloqueadas na revalidação</span><b>{mvp.quality.bloqueios}</b></li>
                <li><span>Reabertura ({mvp.reopening.windowDays} dias)</span><b>{mvp.reopening.rate !== null ? `${mvp.reopening.reopened} de ${mvp.reopening.closures}` : "sem base"}</b></li>
              </ul>
            </ChartCard>
          </div>

          <details className="st-notes">
            <summary>Como ler estes números</summary>
            <ul>
              <li>Execução simulada: nada foi enviado a clientes nem a sistemas reais.</li>
              <li>Resolução autônoma considera só os assuntos que a GoBIA resolve no P0 (rastreio e atraso). Caso aberto, reaberto ou sem encerramento válido não conta como resolvido.</li>
              <li>Pesquisa sem resposta não é satisfação. Taxa de resposta: {pct(mvp.csat.answered, mvp.csat.surveysRequested)} ({mvp.csat.answered} de {mvp.csat.surveysRequested}).</li>
              <li>Custo em US$ indisponível quando o proxy não informa preço: nunca é zero. Custo humano e de canal não existem neste cenário.</li>
              <li>Reabertura inclui hipótese (mesmo cliente, pedido e assunto): {mvp.reopening.reopenedHypothesis} caso(s), sem confirmar que é o mesmo problema.</li>
              <li>Duplicidades evitadas: não medido nesta versão.</li>
            </ul>
          </details>
        </>
      )}

      {fonte === "historico" && (
        <>
          <div className="st-kpis">
            <Kpi label="Conversas" value={n0(h.conversations)} sub={`${n0(h.resolved)} resolvidas (${pct(h.resolved, h.conversations)})`} />
            <Kpi label="Tempo mediano de resolução" value={h.resolutionTimeHours ? dur(h.resolutionTimeHours.median) : "sem amostra"} sub={h.resolutionTimeHours ? `n = ${n0(h.resolutionTimeHours.n)} · P90 ${dur(h.resolutionTimeHours.p90)}` : undefined} />
            <Kpi label="Primeira resposta no prazo" value={h.firstResponse.slaDenominator > 0 ? pct(h.firstResponse.withinSla, h.firstResponse.slaDenominator) : "sem base"} sub={`${n0(h.firstResponse.withinSla)} de ${n0(h.firstResponse.slaDenominator)} · ${n0(h.firstResponse.withoutHumanResponse)} sem resposta humana`} />
            <Kpi label="Satisfação (notas 4–5)" value={h.csat.csat !== null ? pct(h.csat.satisfied, h.csat.answered) : "sem respostas"} sub={`${n0(h.csat.answered)} respostas`} />
            <Kpi label="Taxa de resposta" value={pct(h.csat.answered, h.csat.sent)} sub={`${n0(h.csat.answered)} de ${n0(h.csat.sent)} pesquisas enviadas`} />
            <Kpi label="Conversas reabertas" value={pct(h.reopenedConversations, h.conversations)} sub={`${n0(h.reopenedConversations)} de ${n0(h.conversations)}`} tone="pink" />
          </div>
          <div className="st-grid">
            <ChartCard title="Conversas por mês" sub="Pela data de abertura; só meses com registro" wide>
              <ColumnsStacked name="Conversas por mês" aLabel="Resolvidas" bLabel="Demais" data={historyByMonth(hist.conversations).map((p) => ({ label: p.label, a: p.a, b: p.b }))} />
            </ChartCard>
            <ChartCard title="Notas dos clientes" sub={histMean !== null ? `${n0(histScores.filter((s) => s !== null).length)} avaliações · média ${nf.format(histMean)} de 5` : "nenhuma avaliação"}>
              <BarsH name="Notas dos clientes" rows={scoreBars(histDist)} />
            </ChartCard>
            <ChartCard title="Conversas por canal" sub={`${n0(h.conversations)} conversas`}>
              <BarsH name="Conversas por canal" rows={channelCounts(hist.conversations.map((c) => c.channel)).map((c) => ({ label: CHANNEL_LABEL[c.channel], value: c.count, display: n0(c.count) }))} />
            </ChartCard>
            <ChartCard title="Situação das conversas">
              <BarsH name="Situação das conversas" rows={h.byStatus.map((s) => ({ label: s.status.replace(/_/g, " "), value: s.count, display: `${n0(s.count)} de ${n0(h.conversations)}` }))} />
            </ChartCard>
          </div>
          <details className="st-notes">
            <summary>Como ler estes números</summary>
            <ul>
              <li>Amostra de 1 em cada 4 clientes: não é o volume total e não é execução da GoBIA.</li>
              <li>Não há resolução autônoma, custo por caso nem consumo de IA nesta fonte.</li>
              <li>Pesquisa sem resposta não é satisfação.</li>
            </ul>
          </details>
        </>
      )}

      {fonte === "projecoes" && (
        <>
          <div className="st-kpis st-kpis-2">
            <Kpi label="Tempo humano poupado (projeção)" value={mvp.projection.humanMinutesSaved !== null ? `${n0(mvp.projection.humanMinutesSaved)} min` : "informe a premissa"}
              sub={mvp.projection.assumedMinutesPerCase !== null ? `${mvp.resolution.resolvedAutonomous} casos autônomos × ${nf.format(mvp.projection.assumedMinutesPerCase)} min (premissa)` : "use Filtros → minutos humanos por caso"} />
            <Kpi label="Reembolsos simulados concluídos" value={brl(mvp.projection.refundValueCents)} sub="valor solicitado ao cliente: não é custo da IA nem economia" tone="muted" />
          </div>
          <details className="st-notes" open>
            <summary>Como ler estes números</summary>
            <ul>
              <li>Sem premissa informada, nenhuma projeção é feita. Não é tempo medido.</li>
              <li>Valor retido para análise também não é economia. Não há projeção financeira sem premissa aprovada.</li>
            </ul>
          </details>
        </>
      )}
    </main>
  );
}
