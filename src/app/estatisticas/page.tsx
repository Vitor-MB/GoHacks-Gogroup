// GOB-11 · Estatísticas. Histórico importado, execução do MVP (simulada) e projeções ficam em seções SEPARADAS.
// Todo percentual mostra o denominador; custo indisponível aparece como tal; pesquisa ausente não é satisfação.
import { getCurrentStaff } from "../../server/auth/session";
import { createSessionClient } from "../../server/db/client";
import { loadHistory, loadMvp, type StatsFilters } from "../../server/metrics/load";
import { CHANNELS, computeHistory, computeMvp, DEFAULT_REOPEN_WINDOW_DAYS, SLA, type Channel, type Summary } from "../../server/metrics/model";

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

const nf = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const n0 = (v: number) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(v);
const pct = (num: number, den: number) => (den > 0 ? `${nf.format((num / den) * 100)}%` : "sem base");
const usd = (v: number) => `US$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`;
const brl = (c: number) => `R$ ${(c / 100).toFixed(2).replace(".", ",")}`;
const dur = (h: number) => (h < 1 ? `${nf.format(h * 60)} min` : h < 48 ? `${nf.format(h)} h` : `${nf.format(h / 24)} d`);
const mins = (m: number) => (m < 120 ? `${nf.format(m)} min` : dur(m / 60));

function SummaryRow({ label, s, fmt, unit }: { label: string; s: Summary | null; fmt: (v: number) => string; unit?: string }) {
  if (!s) return <p><strong>{label}:</strong> sem amostra (n = 0).</p>;
  return (
    <p>
      <strong>{label}</strong> (n = {s.n}{unit ? `, ${unit}` : ""}): média {fmt(s.mean)} · mediana {fmt(s.median)} · P90 {fmt(s.p90)}
      {s.n < 10 ? <> · <em className="muted">amostra pequena: leia com cautela</em></> : null}
    </p>
  );
}

function Card({ title, big, children }: { title: string; big?: string; children: React.ReactNode }) {
  return (
    <article className="stat-card">
      <h3>{title}</h3>
      {big && <p className="stat-big">{big}</p>}
      {children}
    </article>
  );
}

export default async function StatsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await getCurrentStaff();
  if (!staff) return <main className="page"><p>Conta sem funcionário ativo vinculado.</p></main>;
  if (staff.role === "atendente") {
    return <main className="page"><header className="page-head"><p className="eyebrow">Estatísticas</p><h1>Acesso restrito</h1><p className="muted">As estatísticas são para supervisor e analista.</p></header></main>;
  }

  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" && sp[k] !== "" ? (sp[k] as string) : null);
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

  const [mvpLoad, hist, modelRows] = await Promise.all([
    loadMvp(db, filters), loadHistory(db, filters),
    runId ? db.from("ai_usage").select("served_model, requested_model").eq("scenario_run_id", runId).limit(1000) : Promise.resolve({ data: [] }),
  ]);
  const mvp = computeMvp(mvpLoad.input);
  const h = computeHistory(hist.conversations, hist.surveys);
  const modelOptions = [...new Set(((modelRows.data ?? []) as { served_model: string | null; requested_model: string | null }[]).map((r) => r.served_model ?? r.requested_model).filter((m): m is string => !!m))];
  const r = mvp.resolution;

  return (
    <main className="page stats">
      <header className="page-head">
        <p className="eyebrow">Estatísticas</p>
        <h1>Desempenho e satisfação</h1>
        <p className="muted">Três fontes separadas: execução do MVP (simulada), histórico importado e projeções. Cada número mostra o que entra na conta.</p>
      </header>

      <form method="get" className="filters" aria-label="Filtros">
        <label>Cenário<select name="cenario" defaultValue={runId ?? ""}>{runList.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>De<input type="date" name="de" defaultValue={filters.from ?? ""} /></label>
        <label>Até<input type="date" name="ate" defaultValue={filters.to ?? ""} /></label>
        <label>Canal<select name="canal" defaultValue={filters.channel ?? ""}><option value="">Todos</option>{CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}</select></label>
        <label>Unidade<select name="unidade" defaultValue={filters.unit ?? ""}><option value="">Todas</option>{(units.data ?? []).map((u) => <option key={u.id as string} value={u.id as string}>{u.name as string}</option>)}</select></label>
        <label>Marca<select name="marca" defaultValue={filters.brand ?? ""}><option value="">Todas</option>{(brands.data ?? []).map((b) => <option key={b.id as string} value={b.id as string}>{b.name as string}</option>)}</select></label>
        <label>Modelo<select name="modelo" defaultValue={filters.model ?? ""}><option value="">Todos</option>{modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
        <label>Janela de reabertura (dias)<input type="number" name="janela" min={1} max={90} defaultValue={filters.reopenDays ?? DEFAULT_REOPEN_WINDOW_DAYS} /></label>
        <label>Premissa: min. humanos por caso<input type="number" name="premissa" min={1} step="any" defaultValue={filters.assumedMinutes ?? ""} placeholder="opcional" /></label>
        <button type="submit">Aplicar</button>
      </form>
      <p className="muted">Os filtros de cenário e modelo valem para a execução do MVP; o histórico importado ignora cenário e modelo. Período usa a data de abertura (horário de Brasília).</p>

      {/* ---------------------------------------------------------------- MVP */}
      <section aria-labelledby="mvp">
        <h2 id="mvp">Execução do MVP <span className="badge badge-media">simulada</span></h2>
        <p className="muted">
          Cenário {mvpLoad.runName ?? "—"}{mvpLoad.clockNow ? ` · relógio em ${new Date(mvpLoad.clockNow).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}` : ""}.
          Ações e respostas desta seção são simuladas; nada foi enviado a clientes nem a sistemas reais.
        </p>
        <div className="stat-grid">
          <Card title="Resolução autônoma" big={r.eligible > 0 ? `${r.eligibleResolvedAutonomous} de ${r.eligible} elegíveis (${pct(r.eligibleResolvedAutonomous, r.eligible)})` : "sem casos elegíveis"}>
            <p>Coorte elegível: assuntos que a GoBIA pode resolver no P0 (rastreio e atraso). Resolvido sem intervenção humana.</p>
            <ul>
              <li>Total recebido na coorte filtrada: <strong>{mvp.received}</strong> (não elegíveis: {r.notEligible})</li>
              <li>Elegíveis resolvidos com intervenção: {r.eligibleResolvedAssisted}</li>
              <li>Elegíveis ainda abertos: {r.eligibleOpen}</li>
            </ul>
            <p className="muted">Caso aberto, reaberto ou sem encerramento válido não conta como resolvido. Ausência de intervenção não confirma acerto.</p>
          </Card>
          <Card title="Resolução assistida" big={`${r.resolvedAssisted} de ${r.resolvedTotal} resolvidos (${pct(r.resolvedAssisted, r.resolvedTotal)})`}>
            <p>Resolvidos com intervenção humana identificada (aprovação, ajuste, atribuição, encaminhamento ou encerramento por pessoa). Ainda abertos: {r.open}.</p>
          </Card>
          <Card title="Tempo de resolução">
            <SummaryRow label="Abertura até resolução" s={mvp.resolutionTimeHours} fmt={dur} />
            <SummaryRow label="Idade dos casos ainda abertos" s={mvp.openAgesHours} fmt={dur} />
            <p className="muted">P90 por posto mais próximo. Abertura = primeira mensagem do contato; resolução = encerramento válido mais recente.</p>
          </Card>
          <Card title="Primeira resposta e SLA" big={mvp.firstResponse.slaDenominator > 0 ? `${mvp.firstResponse.withinSla} de ${mvp.firstResponse.slaDenominator} no prazo (${pct(mvp.firstResponse.withinSla, mvp.firstResponse.slaDenominator)})` : "sem base"}>
            <p>Só resposta substantiva conta; saudação automática não. WhatsApp: {SLA.whatsappBusinessMinutes} min no horário comercial ({SLA.businessStartHour}h–{SLA.businessEndHour}h); e-mail 24 h; Reclame Aqui 48 h (a resposta pública não é verificada aqui).</p>
            <ul>
              <li>Respondidos fora do prazo: {mvp.firstResponse.late} · sem resposta com prazo vencido: {mvp.firstResponse.unansweredOverdue} · sem resposta, ainda no prazo (fora da conta): {mvp.firstResponse.unansweredWaiting}</li>
            </ul>
            <SummaryRow label="Tempo até a primeira resposta" s={mvp.firstResponse.minutes} fmt={mins} />
            <table><thead><tr><th>Canal</th><th>Respondidos</th><th>No prazo</th><th>Vencidos sem resposta</th></tr></thead>
              <tbody>{CHANNELS.map((c) => { const b = mvp.firstResponse.byChannel[c]; return <tr key={c}><td>{CHANNEL_LABEL[c]}</td><td>{b.responded}</td><td>{b.withinSla}</td><td>{b.unansweredOverdue}</td></tr>; })}</tbody></table>
          </Card>
          <Card title="Custo por caso resolvido (IA)" big={mvp.cost.perResolvedUsd !== null ? `${usd(mvp.cost.perResolvedUsd)} por caso, em ${mvp.cost.resolvedKnown} de ${mvp.cost.resolvedCases}` : "custo indisponível"}>
            <p>Soma das chamadas de IA atribuídas ao caso, incluindo tentativas. O proxy de chat informa só tokens: sem preço por chamada o custo fica <strong>indisponível</strong>, nunca zero.</p>
            <ul>
              <li>Resolvidos com custo conhecido: {mvp.cost.resolvedKnown} · com custo indisponível: {mvp.cost.resolvedUnknown}</li>
              <li>Casos abertos (custo à parte): conhecido em {mvp.cost.openKnown}{mvp.cost.openKnown > 0 ? ` (${usd(mvp.cost.openTotalUsd)})` : ""}, indisponível em {mvp.cost.openUnknown}</li>
              <li>Custo humano e de canal por caso: indisponível neste cenário.</li>
            </ul>
          </Card>
          <Card title="CSAT e taxa de resposta" big={mvp.csat.csat !== null ? `${pct(mvp.csat.satisfied, mvp.csat.answered)} (notas 4–5: ${mvp.csat.satisfied} de ${mvp.csat.answered} respostas)` : "sem respostas"}>
            <p><strong>Taxa de resposta: {pct(mvp.csat.answered, mvp.csat.surveysRequested)}</strong> ({mvp.csat.answered} de {mvp.csat.surveysRequested} pesquisas solicitadas; {mvp.csat.awaitingAnswer} sem resposta, que não contam como satisfação).</p>
            <p>Problema resolvido — sim: {mvp.csat.resolvedYes} · parcialmente: {mvp.csat.resolvedPartially} · não: {mvp.csat.resolvedNo}. Uma pesquisa por encerramento válido.</p>
          </Card>
          <Card title="Reabertura (hipótese)" big={mvp.reopening.rate !== null ? `${mvp.reopening.reopened} de ${mvp.reopening.closures} encerramentos (${pct(mvp.reopening.reopened, mvp.reopening.closures)})` : "sem encerramentos"}>
            <p>Janela de {mvp.reopening.windowDays} dias (proposta inicial de 7, configurável). Registrada: {mvp.reopening.reopenedExplicit} · mesmo cliente, pedido e assunto de novo caso: {mvp.reopening.reopenedHypothesis} (hipótese, não confirma que é o mesmo problema).</p>
          </Card>
          <Card title="Intervenções" big={`${mvp.interventions.casesWithIntervention} de ${mvp.interventions.casesTotal} casos`}>
            <ul>{mvp.interventions.reasons.length === 0 ? <li>Nenhuma intervenção registrada.</li> : mvp.interventions.reasons.map((x) => <li key={x.reason}>{REASON_LABEL[x.reason] ?? x.reason.replace(/_/g, " ")}: {x.count}</li>)}</ul>
            <SummaryRow label="Tempo do pedido até a decisão" s={mvp.interventions.decisionHours} fmt={dur} />
            <SummaryRow label="Espera por pessoa (aguardando humano)" s={mvp.interventions.humanWaitHours} fmt={dur} />
            <p>Propostas ajustadas: {mvp.interventions.adjusted} de {mvp.interventions.proposals} ({pct(mvp.interventions.adjusted, mvp.interventions.proposals)}) · rejeitadas: {mvp.interventions.rejected} de {mvp.interventions.proposals} ({pct(mvp.interventions.rejected, mvp.interventions.proposals)}).</p>
          </Card>
          <Card title="Modelos">
            {mvp.models.length === 0 ? <p>Nenhuma chamada de IA registrada neste filtro. {mvpLoad.usageCasesWithoutRecord} caso(s) sem registro de uso: custo e tokens indisponíveis.</p> : (
              <table><thead><tr><th>Modelo · etapa · camada</th><th>Chamadas</th><th>Tokens</th><th>Latência</th><th>Trocas</th><th>Custo</th></tr></thead>
                <tbody>{mvp.models.map((m) => (
                  <tr key={`${m.model}|${m.step}`}>
                    <td>{m.model} · {m.step}{m.tier ? ` · ${m.tier}` : ""}{m.routeSwitches ? ` · ${m.routeSwitches} troca(s) de camada` : ""}{m.failures ? <><br /><span className="muted">{m.failures} falha(s)</span></> : null}</td>
                    <td>{m.calls}</td>
                    <td>{m.tokensUnknownCalls === m.calls ? "indisponível" : `${n0(m.promptTokens + m.completionTokens)}${m.tokensUnknownCalls ? ` (+${m.tokensUnknownCalls} sem dado)` : ""}`}</td>
                    <td>{m.latencyMs ? `${n0(m.latencyMs.mean)} ms (P90 ${n0(m.latencyMs.p90)})` : "indisponível"}</td>
                    <td>{m.swaps}</td>
                    <td>{m.costUnknownCalls === m.calls ? "indisponível" : `${usd(m.costUsd)}${m.costUnknownCalls ? ` (parcial: ${m.costUnknownCalls} sem preço)` : ""}`}</td>
                  </tr>))}</tbody></table>
            )}
          </Card>
          <Card title="Qualidade operacional">
            <ul>
              <li>Execuções que falharam: {mvp.quality.falhas} (propostas com execução falha: {mvp.quality.failedExecutions})</li>
              <li>Retentativas: {mvp.quality.retentativas} · falhas transitórias: {mvp.quality.falhasTransitorias}</li>
              <li>Execuções bloqueadas na revalidação: {mvp.quality.bloqueios} · propostas bloqueadas pela política: {mvp.quality.blockedProposals}</li>
              <li>Duplicidades efetivamente evitadas: <strong>não medido</strong> nesta versão (a proteção existe, mas o evento ainda não é registrado).</li>
            </ul>
          </Card>
          <Card title="Origem investigada">
            <p>Hipótese e causa confirmada ficam separadas; “indeterminada” é mantida. Não atribua custo ou falha a transportadora ou área com base em classificação provisória.</p>
            <table><thead><tr><th>Origem</th><th>Situação</th><th>Casos</th></tr></thead>
              <tbody>{mvp.origins.length === 0 ? <tr><td colSpan={3}>Sem casos.</td></tr> : mvp.origins.map((o) => <tr key={`${o.hypothesis}|${o.status}`}><td>{HYP_LABEL[o.hypothesis] ?? o.hypothesis}</td><td>{ORIGIN_STATUS[o.status] ?? o.status}</td><td>{o.count} de {mvp.received}</td></tr>)}</tbody></table>
          </Card>
        </div>
      </section>

      {/* ---------------------------------------------------------------- Histórico */}
      <section aria-labelledby="hist">
        <h2 id="hist">Histórico importado <span className="badge badge-baixa">dados da base</span></h2>
        <p className="muted">Conversas encerradas até 02/11/2026 08:00, amostra de 1 em cada 4 clientes (não é o volume total). Não é execução da GoBIA: não há resolução autônoma, custo por caso nem consumo de IA aqui.</p>
        <div className="stat-grid">
          <Card title="Conversas e situação" big={`${n0(h.conversations)} conversas`}>
            <ul>{h.byStatus.map((s) => <li key={s.status}>{s.status.replace(/_/g, " ")}: {s.count} de {h.conversations} ({pct(s.count, h.conversations)})</li>)}</ul>
            <p>Reabertas (cliente voltou): {h.reopenedConversations} de {h.conversations} ({pct(h.reopenedConversations, h.conversations)}).</p>
          </Card>
          <Card title="Tempo de resolução"><SummaryRow label="Abertura até encerramento (resolvidas com data)" s={h.resolutionTimeHours} fmt={dur} /></Card>
          <Card title="Primeira resposta humana e SLA" big={h.firstResponse.slaDenominator > 0 ? `${h.firstResponse.withinSla} de ${h.firstResponse.slaDenominator} no prazo (${pct(h.firstResponse.withinSla, h.firstResponse.slaDenominator)})` : "sem base"}>
            <p>Fora do prazo: {h.firstResponse.late} · sem resposta humana (só bot ou nenhuma): {h.firstResponse.withoutHumanResponse}.</p>
            <SummaryRow label="Tempo até a primeira resposta" s={h.firstResponse.minutes} fmt={mins} />
          </Card>
          <Card title="CSAT e taxa de resposta" big={h.csat.csat !== null ? `${pct(h.csat.satisfied, h.csat.answered)} (notas 4–5: ${h.csat.satisfied} de ${h.csat.answered})` : "sem respostas"}>
            <p><strong>Taxa de resposta: {pct(h.csat.answered, h.csat.sent)}</strong> ({h.csat.answered} de {h.csat.sent} pesquisas enviadas). Sem resposta não é satisfação.</p>
          </Card>
        </div>
      </section>

      {/* ---------------------------------------------------------------- Projeções */}
      <section aria-labelledby="proj">
        <h2 id="proj">Projeções <span className="badge badge-alta">premissa</span></h2>
        <p className="muted">Números abaixo derivam de premissas, não de medição.</p>
        <div className="stat-grid">
          <Card title="Tempo humano poupado (projeção)" big={mvp.projection.humanMinutesSaved !== null ? `${n0(mvp.projection.humanMinutesSaved)} min` : "informe a premissa"}>
            <p>{mvp.projection.assumedMinutesPerCase !== null
              ? `= ${mvp.resolution.resolvedAutonomous} casos resolvidos de forma autônoma × ${nf.format(mvp.projection.assumedMinutesPerCase)} min por caso (premissa informada no filtro). Não é tempo medido.`
              : "Sem premissa de minutos humanos por caso informada, nenhuma projeção é feita. Informe-a no filtro acima."}</p>
          </Card>
          <Card title="Valores financeiros">
            <p>Reembolsos simulados concluídos: <strong>{brl(mvp.projection.refundValueCents)}</strong>. É valor solicitado ao cliente — não é custo da IA e não é economia. Valor retido para análise também não é economia. Não há projeção de economia financeira sem premissa aprovada.</p>
          </Card>
        </div>
      </section>
    </main>
  );
}
