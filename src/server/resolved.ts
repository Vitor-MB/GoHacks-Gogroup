// Atendimentos resolvidos: carrega os casos resolvidos do cenário (RLS pelo cliente da sessão) e monta as linhas da tela.
import { cache } from "react";
import { createSessionClient } from "./db/client";
import { scenarioClock } from "./queries.ts";
import type { ResolvedRow } from "./resolved-model.ts";
import { itemLabelOf, loadLookups } from "./supervision.ts";

type Raw = {
  id: string; topic: string; summary: string | null; order_id: string | null; customer_id: string | null; assignee_name: string | null;
  case_conversations: { conversations: { channel: string; opened_at: string } | null }[];
  case_closures: { id: string; seq: number; closed_at: string; resolution_mode: "autonoma" | "assistida"; reopened_at: string | null }[];
  case_surveys: { closure_id: string; status: string; score: number | null }[];
  action_proposals: { amount_cents: number | null; status: string; created_at: string }[];
};

export interface ResolvedData { clockNow: string | null; clockMs: number; rows: ResolvedRow[] }

export const getResolved = cache(async (): Promise<ResolvedData> => {
  const db = await createSessionClient();
  const { data: run } = await db.from("scenario_runs").select("id").eq("name", "demo").maybeSingle();
  if (!run) return { clockNow: null, clockMs: 0, rows: [] };
  const clock = await scenarioClock(db, run.id as string);
  const clockMs = Date.parse(clock);

  const { data, error } = await db.from("cases")
    .select("id, topic, summary, order_id, customer_id, assignee_name, case_conversations(conversations(channel, opened_at)), case_closures(id, seq, closed_at, resolution_mode, reopened_at), case_surveys(closure_id, status, score), action_proposals(amount_cents, status, created_at)")
    .eq("scenario_run_id", run.id as string).eq("status", "resolvido");
  if (error) throw new Error(`resolvidos: ${error.message}`);
  const raws = ((data ?? []) as unknown as Raw[]).filter((r) => r.case_closures.length > 0);

  const L = await loadLookups(db,
    [...new Set(raws.map((r) => r.customer_id).filter((v): v is string => !!v))],
    [...new Set(raws.map((r) => r.order_id).filter((v): v is string => !!v))]);

  const rows = raws.map((r): ResolvedRow => {
    const closure = [...r.case_closures].sort((a, b) => b.seq - a.seq)[0]!;
    const convs = r.case_conversations.map((c) => c.conversations).filter((c): c is NonNullable<typeof c> => !!c);
    const opened = Math.min(...convs.map((c) => Date.parse(c.opened_at)).filter(Number.isFinite), Date.parse(closure.closed_at));
    const survey = r.case_surveys.find((s) => s.closure_id === closure.id);
    // Valor: o da última ação concluída; sem ação, o total do pedido.
    const done = [...r.action_proposals].filter((p) => p.status === "concluida").sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    return {
      id: r.id,
      customerName: r.customer_id ? L.nameOf.get(r.customer_id) ?? null : null,
      customerId: r.customer_id,
      orderId: r.order_id,
      channels: [...new Set(convs.map((c) => c.channel))],
      topic: r.topic, summary: r.summary,
      itemLabel: itemLabelOf(r.order_id ? L.itemsOf.get(r.order_id) : undefined),
      amountCents: done?.amount_cents ?? (r.order_id ? L.totalOf.get(r.order_id) ?? null : null),
      mode: closure.resolution_mode,
      resolverName: r.assignee_name,
      closedAt: closure.closed_at,
      durationMs: Math.max(0, Date.parse(closure.closed_at) - opened),
      score: survey?.status === "respondida" ? survey.score : null,
      surveyStatus: !survey ? "sem_pesquisa" : survey.status === "respondida" ? "respondida" : "aguardando",
      reopened: r.case_closures.some((c) => !!c.reopened_at),
    };
  }).sort((a, b) => b.closedAt.localeCompare(a.closedAt));
  return { clockNow: clock, clockMs, rows };
});
