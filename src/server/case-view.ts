// Detalhe do caso: regras puras de apresentação (número do processo, balões da conversa, nota interna). Sem banco.

/** Número curto do processo, estável e legível: 8 primeiros caracteres do id, em maiúsculas. */
export const processNumber = (id: string): string => id.replace(/-/g, "").slice(0, 8).toUpperCase();

export type Side = "cliente" | "equipe";

export interface Bubble {
  key: string;
  side: Side;
  /** "cliente" | "atendente" | "automatica" | "gobia" | "nota" */
  kind: "cliente" | "atendente" | "automatica" | "gobia" | "nota";
  author: string;
  at: string | null;
  text: string;
  /** Só para mensagens da GoBIA: situação do envio. */
  delivery?: "enviada" | "pendente" | "falhou";
}

export interface RawMessage { id: string; author: string; sentAt: string; body: string | null }
export interface RawOutbox { id: string; status: string; payload: unknown }

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Texto que o cliente recebeu (ou vai receber) de um aviso do outbox. */
export function outboxText(payload: unknown): string | null {
  const p = asObj(payload);
  const t = typeof p.text === "string" ? p.text : typeof p.message === "string" ? p.message : null;
  return t && t.trim() ? t.trim() : null;
}

export function messageBubbles(messages: RawMessage[], customerName: string | null): Bubble[] {
  return [...messages].sort((a, b) => a.sentAt.localeCompare(b.sentAt)).map((m) => {
    const cliente = m.author === "cliente";
    return {
      key: m.id, side: cliente ? "cliente" : "equipe", at: m.sentAt, text: m.body?.trim() || "(sem texto)",
      kind: cliente ? "cliente" : m.author === "bot" ? "automatica" : "atendente",
      author: cliente ? customerName ?? "Cliente" : m.author === "bot" ? "Resposta automática" : "Atendente",
    } satisfies Bubble;
  });
}

/** Avisos ao cliente gravados pela GoBIA. Não têm horário do cenário: ficam depois das mensagens, com a situação do envio. */
export function gobiaBubbles(rows: RawOutbox[]): Bubble[] {
  const out: Bubble[] = [];
  for (const r of rows) {
    const text = outboxText(r.payload);
    if (!text) continue;
    out.push({
      key: r.id, side: "equipe", kind: "gobia", author: "GoBIA", at: null, text,
      delivery: r.status === "enviada" ? "enviada" : r.status === "falhou" ? "falhou" : "pendente",
    });
  }
  return out;
}

export const DELIVERY_LABEL = { enviada: "enviada ao cliente", pendente: "na fila de envio", falhou: "envio falhou" } as const;

export interface NoteInput {
  origin: { hypothesis?: string; status?: string; summary?: string } | null;
  justification: string[];
}

/** Nota interna da GoBIA para a equipe, montada só com o que a proposta registrou (nada inventado). Nula sem conteúdo. */
export function internalNote(p: NoteInput | null): string | null {
  if (!p) return null;
  const parts: string[] = [];
  const o = p.origin?.summary ?? p.origin?.hypothesis;
  if (o) parts.push(`Origem investigada (${p.origin?.status === "confirmada" ? "confirmada" : "hipótese, não confirmada"}): ${o}`);
  if (p.justification[0]) parts.push(p.justification[0]);
  return parts.length ? parts.join(" ") : null;
}

/** Proposta que ainda decide o rumo do caso: a mais recente com pendência; senão, a mais recente. */
export function leadProposal<T extends { status: string }>(ps: T[]): T | null {
  const open = new Set(["aguardando_aprovacao", "suspensa", "bloqueada", "pronta", "em_janela_revisao", "executando", "falhou"]);
  return [...ps].reverse().find((p) => open.has(p.status)) ?? ps[ps.length - 1] ?? null;
}
