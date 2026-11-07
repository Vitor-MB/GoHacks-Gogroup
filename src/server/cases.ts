// GOB-04 · Fila inicial e detalhe mínimo do caso. Use sempre o cliente da sessão: a RLS aplica o escopo do funcionário.
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPublicChannel, type Channel, type Source } from "./intake";

export interface QueueItem {
  id: string;
  status: string;
  topic: string;
  summary: string | null;
  clarification: string | null;
  orderId: string | null;
  brandId: string | null;
  channels: Channel[];
  conversations: number;
  updatedAt: string;
}

export interface CaseDetail extends QueueItem {
  customerId: string | null;
  businessUnitId: string | null;
  sources: Source[];
  conversationsDetail: {
    conversationId: string;
    channel: Channel;
    externalId: string | null;
    public: boolean;
    messages: { id: string; author: string; sentAt: string; body: string | null }[];
  }[];
}

type CaseRow = {
  id: string; status: string; topic: string; summary: string | null; clarification: string | null;
  order_id: string | null; brand_id: string | null; customer_id?: string | null; business_unit_id?: string | null;
  updated_at: string; sources?: Source[];
  case_conversations: { conversations: { conversation_id: string; channel: Channel } | null }[];
};

function toItem(row: CaseRow): QueueItem {
  const convs = row.case_conversations.map((c) => c.conversations).filter((c): c is NonNullable<typeof c> => !!c);
  return {
    id: row.id, status: row.status, topic: row.topic, summary: row.summary, clarification: row.clarification,
    orderId: row.order_id, brandId: row.brand_id, channels: [...new Set(convs.map((c) => c.channel))],
    conversations: convs.length, updatedAt: row.updated_at,
  };
}

export async function listQueue(db: SupabaseClient, runId: string): Promise<QueueItem[]> {
  const { data, error } = await db
    .from("cases")
    .select("id, status, topic, summary, clarification, order_id, brand_id, updated_at, case_conversations(conversations(conversation_id, channel))")
    .eq("scenario_run_id", runId)
    .neq("status", "resolvido")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`fila: ${error.message}`);
  return (data as unknown as CaseRow[]).map(toItem);
}

export async function getCaseDetail(db: SupabaseClient, id: string): Promise<CaseDetail | null> {
  const { data, error } = await db
    .from("cases")
    .select("id, status, topic, summary, clarification, order_id, brand_id, customer_id, business_unit_id, sources, updated_at, case_conversations(conversations(conversation_id, channel))")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`caso: ${error.message}`);
  if (!data) return null;
  const row = data as unknown as CaseRow;

  const ids = row.case_conversations.map((c) => c.conversations?.conversation_id).filter((v): v is string => !!v);
  const { data: convRows, error: cErr } = await db
    .from("conversations").select("conversation_id, channel, external_id, opened_at, messages(message_id, author, sent_at, body)")
    .in("conversation_id", ids.length ? ids : ["-"]).order("opened_at");
  if (cErr) throw new Error(`conversas: ${cErr.message}`);

  type Conv = { conversation_id: string; channel: Channel; external_id: string | null; messages: { message_id: string; author: string; sent_at: string; body: string | null }[] };
  return {
    ...toItem(row),
    customerId: row.customer_id ?? null,
    businessUnitId: row.business_unit_id ?? null,
    sources: row.sources ?? [],
    conversationsDetail: (convRows as unknown as Conv[]).map((c) => ({
      conversationId: c.conversation_id,
      channel: c.channel,
      externalId: c.external_id,
      public: isPublicChannel(c.channel),
      messages: [...c.messages].sort((a, b) => a.sent_at.localeCompare(b.sent_at))
        .map((m) => ({ id: m.message_id, author: m.author, sentAt: m.sent_at, body: m.body })),
    })),
  };
}
