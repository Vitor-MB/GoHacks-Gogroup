// Simulação de chat: um funcionário faz o papel do cliente e conversa com a GoBIA.
// A mensagem entra como contato REAL no cenário (caso, investigação e confirmação de recebimento), e a GoBIA responde ao
// vivo só com fatos já consultados. Leituras de fatos usam o cliente da sessão (RLS); o cliente privilegiado só grava.
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ModelAdapter } from "./ai/adapter.ts";
import { composeCustomerReply, type ChatTurn, type CustomerChatReply, type PolicySnippet } from "./ai/customer-chat.ts";
import { maskText } from "./ai/mask.ts";
import { dbToolSet } from "./ai/tools.ts";
import { CHANNELS, ingestContact, type Channel } from "./intake.ts";
import { scenarioClock } from "./queries.ts";

export const MAX_TEXT = 1000;
/** Teto de mensagens por conversa simulada (cliente + GoBIA), contra loop e custo. */
export const MAX_MESSAGES = 40;
export const KEY_RE = /^sim-[a-z0-9-]{8,60}$/;

// A política interna (alçadas, custos) não é dita ao cliente.
const INTERNAL_CATEGORY = /limites_por_papel|custo/i;
const CATEGORY_HINTS: [RegExp, string][] = [
  [/atraso|atrasad|extravi|n[aã]o chegou|demor/i, "atraso_entrega"],
  [/onde est[aá]|rastre|status|entrega/i, "onde_esta_pedido"],
  [/avaria|vazamento|quebrad|amassad|danific/i, "avaria_vazamento"],
  [/falt(ou|ando|ante)|brinde/i, "item_faltante"],
  [/rea[cç][aã]o|alergia|irrita|coceira|vermelh/i, "reacao_adversa"],
];

export interface SimInput { runId: string; channel: Channel; customerId: string; orderId: string; conversationKey: string; text: string }
export interface SimDeps { session: SupabaseClient; admin: SupabaseClient; adapter: ModelAdapter | null }
export interface SimResult {
  caseId: string;
  conversationId: string;
  newCase: boolean;
  needsClarification: boolean;
  investigationQueued: boolean;
  reply: CustomerChatReply;
}

export class SimulationError extends Error {}

export function validateInput(i: Pick<SimInput, "channel" | "conversationKey" | "text" | "orderId" | "customerId">): string | null {
  if (!(CHANNELS as readonly string[]).includes(i.channel)) return "Canal inválido.";
  if (!KEY_RE.test(i.conversationKey)) return "Conversa inválida.";
  const t = i.text.trim();
  if (!t) return "Escreva uma mensagem.";
  if (t.length > MAX_TEXT) return `A mensagem passa de ${MAX_TEXT} caracteres.`;
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(i.orderId) || !/^[A-Za-z0-9_-]{1,40}$/.test(i.customerId)) return "Cliente ou pedido inválido.";
  return null;
}

export async function simulateCustomerMessage(deps: SimDeps, input: SimInput): Promise<SimResult> {
  const bad = validateInput(input);
  if (bad) throw new SimulationError(bad);
  const { session, admin } = deps;
  const text = input.text.trim();

  // Escopo: o pedido só existe para quem a RLS deixa ler, e precisa ser do cliente escolhido.
  const { data: order, error: oErr } = await session.from("orders").select("order_id, customer_id").eq("order_id", input.orderId).maybeSingle();
  if (oErr) throw new SimulationError("Não foi possível consultar o pedido.");
  if (!order || order.customer_id !== input.customerId) throw new SimulationError("Pedido fora do seu escopo ou de outro cliente.");
  const { data: customer } = await session.from("customers").select("full_name").eq("customer_id", input.customerId).maybeSingle();
  const firstName = ((customer?.full_name as string | undefined) ?? "").split(/\s+/)[0] || null;

  // Conversa já existente (mesmo canal e chave): conta mensagens e define o horário da próxima, em ordem crescente.
  const clock = Date.parse(await scenarioClock(admin, input.runId));
  const { data: existing } = await admin.from("conversations").select("conversation_id")
    .eq("scenario_run_id", input.runId).eq("channel", input.channel).eq("external_id", input.conversationKey).maybeSingle();
  let count = 0;
  if (existing) {
    const { count: c, error } = await admin.from("messages").select("message_id", { count: "exact", head: true }).eq("conversation_id", existing.conversation_id as string);
    if (error) throw new SimulationError("Não foi possível ler a conversa.");
    count = c ?? 0;
  }
  if (count >= MAX_MESSAGES) throw new SimulationError("Esta conversa chegou ao limite de mensagens. Comece uma nova conversa.");
  const receivedAt = new Date(clock + count * 1000).toISOString();

  const ing = await ingestContact(admin, input.runId, {
    channel: input.channel, externalEventId: `${input.conversationKey}-${randomUUID()}`, externalConversationId: input.conversationKey,
    customerId: input.customerId, orderId: input.orderId, text, receivedAt,
    ...(count === 0 ? { subject: text.slice(0, 120) } : {}),
  }, { enqueue: true });

  // Histórico da conversa (sem a mensagem atual, que acabou de ser gravada).
  const { data: msgs } = await admin.from("messages").select("author, body, sent_at").eq("conversation_id", ing.conversation_id).order("sent_at");
  const rows = (msgs ?? []) as { author: string; body: string | null; sent_at: string }[];
  const history: ChatTurn[] = rows.slice(0, -1).filter((m) => m.body).map((m) => ({ role: m.author === "cliente" ? "cliente" : "gobia", text: m.body! }));

  // Fatos e políticas, só leitura e pelo escopo da sessão.
  const tools = dbToolSet(session, input.runId);
  const [orderEv, trackEv, ...polEvs] = await Promise.all([
    tools.get_order({ order_id: input.orderId }),
    tools.get_tracking({ order_id: input.orderId }),
    ...CATEGORY_HINTS.filter(([re]) => re.test(text)).map(([, category]) => tools.search_knowledge({ category })),
    tools.search_knowledge({ query: maskText(text).slice(0, 300) }),
  ]);
  const seen = new Set<string>();
  const policies: PolicySnippet[] = [];
  for (const ev of polEvs) {
    for (const h of (ev.data as { hits?: { id: string; title: string; version: string; snippet: string; category: string | null }[] } | null)?.hits ?? []) {
      if (seen.has(h.id) || INTERNAL_CATEGORY.test(h.category ?? "") || INTERNAL_CATEGORY.test(h.title)) continue;
      seen.add(h.id);
      policies.push({ ref: h.id, title: h.title, version: h.version, snippet: h.snippet });
    }
  }
  const evs = [orderEv, trackEv] as { data: unknown; missing: string[]; conflicts: { field: string; detail: string }[] }[];

  const reply = await composeCustomerReply({
    adapter: deps.adapter, channel: input.channel, customerFirstName: firstName, orderId: input.orderId, history, message: text,
    facts: {
      order: orderEv.data, tracking: trackEv.data,
      conflicts: evs.flatMap((e) => e.conflicts.map((c) => `${c.field}: ${c.detail}`)), missing: evs.flatMap((e) => e.missing),
    },
    policies: policies.slice(0, 5),
  });

  // A resposta entra no histórico da conversa como mensagem automática e fica na auditoria do caso.
  const { error: mErr } = await admin.from("messages").insert({
    message_id: `SIM-BOT-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`, conversation_id: ing.conversation_id,
    author: "bot", sent_at: new Date(Date.parse(receivedAt) + 500).toISOString(), body: reply.text,
  });
  if (mErr) throw new SimulationError("Não foi possível gravar a resposta.");
  await admin.rpc("append_audit", {
    p_run: input.runId, p_case: ing.case_id, p_proposal: null, p_type: "resposta_chat_simulado", p_actor_type: "gobia", p_actor_id: null,
    p_data: { channel: input.channel, source: reply.source, flags: reply.flags, policies: policies.map((p) => p.ref).slice(0, 5), simulated: true }, p_correlation: `chat:${input.conversationKey}`,
  });

  return {
    caseId: ing.case_id, conversationId: ing.conversation_id, newCase: !!ing.new_case, needsClarification: !!ing.needs_clarification,
    investigationQueued: !!(ing as { investigation_task_id?: unknown }).investigation_task_id, reply,
  };
}
