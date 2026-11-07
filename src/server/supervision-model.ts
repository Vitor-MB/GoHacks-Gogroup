// Fila de supervisão: regras puras de classificação, espera e filtro. Sem banco, roda no Next e em scripts.
import type { QueueItem } from "./cases.ts";

export type Tab = "todos" | "supervisor" | "agente";

// Propostas cujo estado ainda depende de uma pessoa.
const ATTENTION = new Set(["aguardando_aprovacao", "suspensa", "bloqueada", "falhou"]);

/** O que exige uma pessoa: caso aguardando humano ou proposta que depende de decisão. */
export const needsHuman = (c: QueueItem): boolean =>
  c.status === "aguardando_humano" || (!!c.proposal && ATTENTION.has(c.proposal.status));

/** Só o supervisor pode destravar: aprovação acima da alçada ou encaminhamento dirigido ao supervisor. */
export const requiresSupervisor = (c: QueueItem): boolean =>
  c.proposal?.status === "aguardando_aprovacao" || c.handoffTeam === "supervisor" || c.handoffReason === "aprovacao_supervisor";

const REASON: Record<string, string> = {
  aprovacao_supervisor: "Valor acima da alçada", acao_bloqueada: "Bloqueada pela política", continuidade_humana: "Continuidade humana",
  ia_indisponivel: "IA indisponível", execucao_falhou: "Execução falhou", proposta_rejeitada: "Proposta rejeitada",
  proposta_suspensa: "Proposta suspensa", revalidacao_bloqueada: "Revalidação bloqueou", pesquisa_negativa: "Pesquisa negativa",
};

/** Motivos curtos para a coluna "Motivo" (no máximo dois). */
export function reasonLines(c: QueueItem): string[] {
  const out: string[] = [];
  if (c.proposal?.status === "aguardando_aprovacao") out.push(c.proposal.overdue ? "Aprovação com prazo vencido" : "Valor acima da alçada");
  else if (c.handoffReason === "orientacao_e_encaminhamento") out.push(c.topic === "reacao_adversa" ? "Reação adversa" : "Orientação e encaminhamento");
  else if (c.handoffReason && REASON[c.handoffReason]) out.push(REASON[c.handoffReason]);
  else if (c.proposal?.status === "suspensa") out.push("Proposta suspensa");
  else if (c.proposal?.status === "bloqueada") out.push("Bloqueada pela política");
  else if (c.proposal?.status === "falhou") out.push("Execução falhou");
  else out.push("Aguardando uma pessoa");
  if (c.channels.includes("reclame_aqui")) out.push("Reclamação pública");
  return out.slice(0, 2);
}

/** "menos de 1 min", "18 min", "1 h 06". */
export function waitLabel(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return "menos de 1 min";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
}

/** Cor da espera: calma até 30 min, atenção até 2 h, urgente depois. */
export const waitTone = (ms: number): "calm" | "warn" | "hot" => (ms >= 2 * 3600_000 ? "hot" : ms >= 30 * 60_000 ? "warn" : "calm");

export interface SupervisionRow extends QueueItem {
  customerName: string | null;
  /** Primeiro item do pedido; "+N" quando há mais. */
  itemLabel: string | null;
  /** Valor da proposta ou, sem proposta, total do pedido. */
  amountCents: number | null;
  waitMs: number;
  /** Empresa: marca do caso e a unidade de negócio a que pertence. */
  brandName: string | null;
  unitName: string | null;
}

const norm = (v: string | null | undefined) => (v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export interface RowFilter { tab?: Tab; canal?: string; q?: string }

export function filterRows(rows: SupervisionRow[], f: RowFilter): SupervisionRow[] {
  const q = norm(f.q?.trim());
  return rows.filter((r) =>
    (f.tab === "supervisor" ? requiresSupervisor(r) : f.tab === "agente" ? !requiresSupervisor(r) : true)
    && (!f.canal || (r.channels as string[]).includes(f.canal))
    && (!q || [r.customerName, r.customerId, r.orderId, r.id, r.summary, r.itemLabel].some((x) => norm(x).includes(q))));
}

export function countTabs(rows: SupervisionRow[]): Record<Tab, number> {
  const sup = rows.filter(requiresSupervisor).length;
  return { todos: rows.length, supervisor: sup, agente: rows.length - sup };
}

export const parseTab = (v: string | undefined): Tab => (v === "supervisor" || v === "agente" ? v : "todos");
