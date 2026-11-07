// Atendimentos resolvidos: filtros, abas, período e médias. Funções puras (sem banco).

export type RTab = "todos" | "gobia" | "pessoa" | "baixa";
export type Period = "7" | "30" | "90" | "todos";

/** Nota até este valor conta como baixa (4 e 5 são satisfeito, como nas Estatísticas). */
export const LOW_SCORE_MAX = 3;

export interface ResolvedRow {
  id: string;
  customerName: string | null;
  customerId: string | null;
  orderId: string | null;
  channels: string[];
  topic: string;
  summary: string | null;
  itemLabel: string | null;
  amountCents: number | null;
  mode: "autonoma" | "assistida";
  /** Nome de quem assumiu; só faz sentido na resolução assistida. */
  resolverName: string | null;
  closedAt: string;
  /** Do primeiro contato ao encerramento mais recente, no relógio do cenário. */
  durationMs: number;
  /** Nota da pesquisa do encerramento vigente; nula sem resposta (nunca presumida). */
  score: number | null;
  surveyStatus: "respondida" | "aguardando" | "sem_pesquisa";
  reopened: boolean;
}

export const parseRTab = (v: string | undefined): RTab => (v === "gobia" || v === "pessoa" || v === "baixa" ? v : "todos");
export const parsePeriod = (v: string | undefined): Period => (v === "30" || v === "90" || v === "todos" ? v : "7");
export const PERIOD_LABEL: Record<Period, string> = { "7": "Últimos 7 dias", "30": "Últimos 30 dias", "90": "Últimos 90 dias", todos: "Todo o período" };

export const isLow = (r: ResolvedRow): boolean => r.score !== null && r.score <= LOW_SCORE_MAX;

const norm = (v: string | null | undefined) => (v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export interface ResolvedFilter { tab?: RTab; period?: Period; canal?: string; q?: string }

export const inPeriod = (r: ResolvedRow, period: Period, clockMs: number): boolean =>
  period === "todos" || Date.parse(r.closedAt) >= clockMs - Number(period) * 86_400_000;

/** `tab` filtra por quem resolveu ou nota baixa; os demais critérios valem para as contagens das abas também. */
export function filterResolved(rows: ResolvedRow[], f: ResolvedFilter, clockMs: number): ResolvedRow[] {
  const q = norm(f.q?.trim());
  return rows.filter((r) =>
    inPeriod(r, f.period ?? "7", clockMs)
    && (!f.canal || r.channels.includes(f.canal))
    && (f.tab === "gobia" ? r.mode === "autonoma" : f.tab === "pessoa" ? r.mode === "assistida" : f.tab === "baixa" ? isLow(r) : true)
    && (!q || [r.customerName, r.customerId, r.orderId, r.id, r.summary, r.itemLabel].some((x) => norm(x).includes(q))));
}

export function countTabs(rows: ResolvedRow[]): Record<RTab, number> {
  return {
    todos: rows.length,
    gobia: rows.filter((r) => r.mode === "autonoma").length,
    pessoa: rows.filter((r) => r.mode === "assistida").length,
    baixa: rows.filter(isLow).length,
  };
}

/** Média das notas respondidas e quantas respostas a compõem; sem resposta, média nula. */
export function scoreSummary(rows: ResolvedRow[]): { mean: number | null; answered: number; total: number } {
  const s = rows.map((r) => r.score).filter((v): v is number => v !== null);
  return { mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null, answered: s.length, total: rows.length };
}
