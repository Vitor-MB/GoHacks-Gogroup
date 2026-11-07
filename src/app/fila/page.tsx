import Link from "next/link";
import { getCurrentStaff } from "../../server/auth/session";
import { activeFilterCount, countPrio, filterCases, parseOrder, parsePrio, sortCases, type CaseFilter, type Order, type PrioTab } from "../../server/case-list-model";
import { getAllCases } from "../../server/supervision";
import { reasonLines, waitLabel, waitTone } from "../../server/supervision-model";

const CHANNEL_LABEL: Record<string, string> = { whatsapp: "WhatsApp", email: "E-mail", reclame_aqui: "Reclame Aqui" };
const TOPIC_LABEL: Record<string, string> = {
  rastreio_atraso: "Rastreio e atraso", troca_devolucao: "Troca ou devolução", avaria: "Avaria", personalizacao: "Personalização",
  brinde: "Brinde", reacao_adversa: "Reação adversa", cancelamento: "Cancelamento", outros: "Outros",
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
const PRIO_LABEL = { alta: "Alta", media: "Média", baixa: "Baixa" } as const;
const brl = (c: number) => `R$ ${(c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MAX_ROWS = 100;

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const pick = (v: string | undefined, allowed: readonly string[]) => (v && allowed.includes(v) ? v : undefined);

interface Link4 extends CaseFilter { ordem?: Order }
function href(p: Link4) {
  const sp = new URLSearchParams();
  if (p.prio && p.prio !== "todas") sp.set("prio", p.prio);
  for (const k of ["canal", "situacao", "responsavel", "empresa", "motivo", "prazo", "q"] as const) if (p[k]) sp.set(k, p[k]!);
  if (p.ordem && p.ordem !== "prioridade") sp.set("ordem", p.ordem);
  const s = sp.toString();
  return s ? `/fila?${s}` : "/fila";
}

export default async function CasesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const staff = await getCurrentStaff();
  if (!staff) return <main className="page"><p>Conta sem funcionário ativo vinculado.</p></main>;

  const sp = await searchParams;
  const prio: PrioTab = parsePrio(one(sp.prio));
  const ordem = parseOrder(one(sp.ordem));
  const f: CaseFilter = {
    canal: pick(one(sp.canal), Object.keys(CHANNEL_LABEL)),
    situacao: pick(one(sp.situacao), Object.keys(STATUS_LABEL)),
    responsavel: pick(one(sp.responsavel), ["eu", "sem"]),
    empresa: one(sp.empresa)?.slice(0, 60),
    motivo: pick(one(sp.motivo), Object.keys(REASON_LABEL)),
    prazo: pick(one(sp.prazo), ["vencido", "em_prazo"]),
    q: one(sp.q)?.slice(0, 80),
  };

  const { runName, clockNow, rows: all } = await getAllCases();
  // As abas contam sobre o que os demais filtros deixam passar, para o número bater com a lista ao clicar.
  const counts = countPrio(filterCases(all, f, staff.id));
  const shown = sortCases(filterCases(all, { ...f, prio }, staff.id), ordem);
  const visible = shown.slice(0, MAX_ROWS);
  const nFilters = activeFilterCount(f);

  const brands = [...new Map(all.filter((r) => r.brandId && r.brandName).map((r) => [r.brandId!, r.brandName!])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const tabs: { key: PrioTab; label: string }[] = [{ key: "todas", label: "Todos" }, { key: "alta", label: "Alta" }, { key: "media", label: "Média" }, { key: "baixa", label: "Baixa" }];
  const base: Link4 = { ...f, ordem };

  return (
    <main className="page sv">
      <header className="sv-head st-head">
        <div>
          <h1>Todos os casos</h1>
          <p className="muted">
            {all.length === 0 ? "Nenhum caso aberto." : `${all.length} ${all.length === 1 ? "caso aberto" : "casos abertos"}, do mais urgente para o menos urgente.`}
            {clockNow ? ` Relógio do cenário: ${new Date(clockNow).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}.` : runName === null ? " Cenário demo não encontrado." : ""}
          </p>
        </div>
        <div className="cl-actions">
          <Link href="/fila/pendencias" className="sv-open">Pendências de execução</Link>
          <details className="st-filters">
            <summary>Filtros{nFilters > 0 && <b>{nFilters}</b>}</summary>
            <form method="get" action="/fila">
              {prio !== "todas" && <input type="hidden" name="prio" value={prio} />}
              {f.q && <input type="hidden" name="q" value={f.q} />}
              <label>Canal de origem
                <select name="canal" defaultValue={f.canal ?? ""}><option value="">Todos</option>{Object.entries(CHANNEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </label>
              <label>Empresa (marca)
                <select name="empresa" defaultValue={f.empresa ?? ""}><option value="">Todas</option>{brands.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
              </label>
              <label>Situação
                <select name="situacao" defaultValue={f.situacao ?? ""}><option value="">Todas</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </label>
              <label>Motivo do encaminhamento
                <select name="motivo" defaultValue={f.motivo ?? ""}><option value="">Todos</option>{Object.entries(REASON_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              </label>
              <label>Responsável
                <select name="responsavel" defaultValue={f.responsavel ?? ""}><option value="">Todos</option><option value="eu">Eu</option><option value="sem">Sem responsável</option></select>
              </label>
              <label>Prazo de aprovação
                <select name="prazo" defaultValue={f.prazo ?? ""}><option value="">Todos</option><option value="vencido">Vencido</option><option value="em_prazo">Em prazo</option></select>
              </label>
              <label>Ordenar por
                <select name="ordem" defaultValue={ordem}><option value="prioridade">Prioridade</option><option value="espera">Maior espera</option></select>
              </label>
              <div className="st-filters-actions"><button type="submit">Aplicar</button><Link href={href({ prio, q: f.q })}>Limpar</Link></div>
            </form>
          </details>
        </div>
      </header>

      <div className="sv-toolbar">
        <nav className="sv-tabs" aria-label="Filtrar por prioridade">
          {tabs.map((t) => (
            <Link key={t.key} href={href({ ...base, prio: t.key })} className={t.key === prio ? "is-on" : undefined} aria-current={t.key === prio ? "true" : undefined}>
              {t.label} <b>{counts[t.key]}</b>
            </Link>
          ))}
        </nav>
        <form method="get" action="/fila" className="cl-search" role="search">
          {prio !== "todas" && <input type="hidden" name="prio" value={prio} />}
          {(["canal", "situacao", "responsavel", "empresa", "motivo", "prazo"] as const).map((k) => f[k] && <input key={k} type="hidden" name={k} value={f[k]} />)}
          {ordem !== "prioridade" && <input type="hidden" name="ordem" value={ordem} />}
          <input type="search" name="q" defaultValue={f.q ?? ""} placeholder="Cliente, pedido ou item" aria-label="Buscar por cliente, pedido ou item" maxLength={80} />
        </form>
      </div>

      {f.q && <p className="muted">Busca por “{f.q}”: {shown.length} {shown.length === 1 ? "resultado" : "resultados"}. <Link href={href({ ...base, q: undefined })}>Limpar busca</Link></p>}

      <div className="sv-card">
        <table className="sv-table cl-table">
          <thead>
            <tr>
              <th>#</th><th>Prioridade</th><th>Cliente e origem</th><th>Empresa</th><th>Assunto</th><th>Item e valor</th><th>Situação</th><th>Espera</th><th><span className="sr-only">Ação</span></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => {
              const reasons = r.priority.reasons;
              const status = r.clarification ? "Pendente de esclarecimento" : STATUS_LABEL[r.status] ?? r.status;
              const why = reasonLines(r)[0];
              return (
                <tr key={r.id}>
                  <td className="cl-rank">{i + 1}</td>
                  <td title={reasons.join("\n")}>
                    <span className={`cl-prio cl-prio-${r.priority.level}`}>{PRIO_LABEL[r.priority.level]}<small>{r.priority.score}</small></span>
                    <span className="sv-sub">{reasons[0]!.replace(/ \(\+\d+\)$/, "")}</span>
                  </td>
                  <td>
                    <strong>{r.customerName ?? (r.customerId ? `Cliente ${r.customerId}` : "Cliente não identificado")}</strong>
                    <span className="cl-chips">
                      {r.channels.map((c) => <span key={c} className={`cl-chip${c === "reclame_aqui" ? " cl-chip-public" : ""}`}>{CHANNEL_LABEL[c] ?? c}</span>)}
                      {r.conversations > 1 && <span className="cl-chip">{r.conversations} conversas</span>}
                    </span>
                    <span className="sv-sub">{r.orderId ? `Pedido ${r.orderId}` : "Sem pedido"}</span>
                  </td>
                  <td>
                    <strong>{r.brandName ?? "Não identificada"}</strong>
                    {r.unitName && <span className="sv-sub">{r.unitName}</span>}
                  </td>
                  <td>
                    <strong>{TOPIC_LABEL[r.topic] ?? r.topic}</strong>
                    <span className="sv-sub sv-clamp">{r.decisionRequested ?? r.summary ?? "Sem resumo"}</span>
                  </td>
                  <td>
                    <strong>{r.itemLabel ?? "—"}</strong>
                    <span className="sv-sub sv-money">{r.amountCents !== null ? brl(r.amountCents) : "Valor indisponível"}</span>
                    {r.proposal?.amountCents ? <span className="sv-sub">Proposta pendente</span> : null}
                  </td>
                  <td>
                    <span className="sv-pill sv-pill-blue">{status}</span>
                    {r.handoffReason && <span className="sv-sub">{why}</span>}
                    <span className="sv-sub">{r.assigneeName ? `Com ${r.assigneeName}` : "Sem responsável"}</span>
                  </td>
                  <td><span className={`sv-wait sv-wait-${waitTone(r.waitMs)}`}>{waitLabel(r.waitMs)}</span></td>
                  <td><Link href={`/fila/${r.id}`} className="sv-open">Abrir</Link></td>
                </tr>
              );
            })}
            {visible.length === 0 && <tr><td colSpan={9} className="sv-empty">{all.length === 0 ? "Nenhum caso aberto." : "Nenhum caso com esses filtros."}</td></tr>}
          </tbody>
        </table>
      </div>
      {shown.length > MAX_ROWS && <p className="muted">Mostrando {MAX_ROWS} de {shown.length}. Use os filtros ou a busca para afunilar.</p>}
      <p className="muted sv-foot">Prioridade = prazo, valor e pendências do caso (passe o mouse para ver os motivos); sentimento do cliente não entra. Espera = tempo desde a abertura do contato, no relógio do cenário. Casos resolvidos ficam em Estatísticas.</p>
    </main>
  );
}
