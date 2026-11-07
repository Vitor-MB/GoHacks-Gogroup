// Estatísticas: séries e distribuições para os gráficos. Funções puras sobre os registros já carregados (sem banco).
import type { CaseRecord, Channel, HistoryConversation } from "./model.ts";

/** Dia (America/Sao_Paulo, sem horário de verão) de um instante, "AAAA-MM-DD". */
export const spDay = (ms: number): string => new Date(ms - 3 * 3600_000).toISOString().slice(0, 10);
export const spMonth = (ms: number): string => spDay(ms).slice(0, 7);

export interface SeriesPoint { key: string; label: string; a: number; b: number }

const dayLabel = (k: string) => `${k.slice(8, 10)}/${k.slice(5, 7)}`;
const monthLabel = (k: string) => `${k.slice(5, 7)}/${k.slice(2, 4)}`;

/** Agrupa por dia ou mês; só aparecem períodos com registro (os últimos `last`). `a` e `b` são as duas séries empilhadas. */
export function groupSeries(items: { at: number; a: boolean }[], grain: "day" | "month", last: number): SeriesPoint[] {
  const keyOf = grain === "day" ? spDay : spMonth;
  const m = new Map<string, { a: number; b: number }>();
  for (const it of items) {
    const k = keyOf(it.at);
    const cur = m.get(k) ?? { a: 0, b: 0 };
    if (it.a) cur.a++; else cur.b++;
    m.set(k, cur);
  }
  return [...m.entries()].sort(([x], [y]) => x.localeCompare(y)).slice(-last)
    .map(([key, v]) => ({ key, label: grain === "day" ? dayLabel(key) : monthLabel(key), a: v.a, b: v.b }));
}

/** MVP: encerramentos válidos mais recentes por dia, autônomo (a) x assistido (b). Caso aberto não conta. */
export function mvpResolutionsByDay(cases: CaseRecord[], last = 14): SeriesPoint[] {
  const items: { at: number; a: boolean }[] = [];
  for (const c of cases) {
    if (c.status !== "resolvido" || c.closures.length === 0) continue;
    const z = [...c.closures].sort((x, y) => y.seq - x.seq)[0]!;
    items.push({ at: z.closedAt, a: z.mode === "autonoma" });
  }
  return groupSeries(items, "day", last);
}

/** Histórico: conversas abertas por mês, resolvidas (a) x demais (b). */
export function historyByMonth(conversations: HistoryConversation[], last = 12): SeriesPoint[] {
  return groupSeries(conversations.map((c) => ({ at: c.openedAt, a: c.status === "resolvido" })), "month", last);
}

/** Notas 5→1 (mais alta primeiro) com quantidade de respostas. */
export function scoreDistribution(scores: (number | null)[]): { score: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const s of scores) if (s !== null && Number.isInteger(s) && s >= 1 && s <= 5) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [5, 4, 3, 2, 1].map((score) => ({ score, count: counts.get(score) ?? 0 }));
}

export function channelCounts(channels: Channel[]): { channel: Channel; count: number }[] {
  const m = new Map<Channel, number>();
  for (const c of channels) m.set(c, (m.get(c) ?? 0) + 1);
  return [...m.entries()].map(([channel, count]) => ({ channel, count })).sort((x, y) => y.count - x.count);
}

export const meanScore = (scores: (number | null)[]): number | null => {
  const v = scores.filter((s): s is number => s !== null && s >= 1 && s <= 5);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
