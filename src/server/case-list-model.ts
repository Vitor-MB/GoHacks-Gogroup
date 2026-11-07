// Todos os casos: filtros, abas por prioridade e ordenação. Funções puras (sem banco), rodam no Next e em scripts.
import type { SupervisionRow } from "./supervision-model.ts";

export type PrioTab = "todas" | "alta" | "media" | "baixa";
export type Order = "prioridade" | "espera";

export interface CaseFilter {
  prio?: PrioTab;
  canal?: string;
  situacao?: string;
  /** "eu" | "sem" */
  responsavel?: string;
  /** Marca (id). */
  empresa?: string;
  motivo?: string;
  /** "vencido" | "em_prazo" (aprovação do supervisor). */
  prazo?: string;
  q?: string;
}

const norm = (v: string | null | undefined) => (v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export const parsePrio = (v: string | undefined): PrioTab => (v === "alta" || v === "media" || v === "baixa" ? v : "todas");
export const parseOrder = (v: string | undefined): Order => (v === "espera" ? "espera" : "prioridade");

export function filterCases(rows: SupervisionRow[], f: CaseFilter, staffId: string): SupervisionRow[] {
  const q = norm(f.q?.trim());
  return rows.filter((r) =>
    (!f.prio || f.prio === "todas" || r.priority.level === f.prio)
    && (!f.canal || (r.channels as string[]).includes(f.canal))
    && (!f.situacao || r.status === f.situacao)
    && (!f.responsavel || (f.responsavel === "eu" ? r.assignedTo === staffId : f.responsavel === "sem" ? !r.assignedTo : r.assignedTo === f.responsavel))
    && (!f.empresa || r.brandId === f.empresa)
    && (!f.motivo || r.handoffReason === f.motivo)
    && (!f.prazo || (f.prazo === "vencido" ? !!r.proposal?.overdue : !!r.proposal && !r.proposal.overdue && r.proposal.status === "aguardando_aprovacao"))
    && (!q || [r.customerName, r.customerId, r.orderId, r.id, r.summary, r.itemLabel, r.brandName].some((x) => norm(x).includes(q))));
}

/** Contagem por aba de prioridade, sobre as linhas já filtradas pelos demais critérios. */
export function countPrio(rows: SupervisionRow[]): Record<PrioTab, number> {
  const c: Record<PrioTab, number> = { todas: rows.length, alta: 0, media: 0, baixa: 0 };
  for (const r of rows) c[r.priority.level]++;
  return c;
}

/** Prioridade: maior pontuação primeiro, empate pelo que espera há mais tempo. Espera: maior espera primeiro. Não altera a entrada. */
export function sortCases(rows: SupervisionRow[], order: Order): SupervisionRow[] {
  const byWait = (a: SupervisionRow, b: SupervisionRow) => b.waitMs - a.waitMs;
  return [...rows].sort(order === "espera" ? byWait : (a, b) => b.priority.score - a.priority.score || byWait(a, b));
}

/** Quantidade de filtros ativos no botão "Filtros" (a aba de prioridade e a busca não contam). */
export const activeFilterCount = (f: CaseFilter): number =>
  [f.canal, f.situacao, f.responsavel, f.empresa, f.motivo, f.prazo].filter(Boolean).length;
