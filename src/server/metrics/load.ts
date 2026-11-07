// GOB-11 · Leitura e normalização dos registros para o cálculo das métricas (src/server/metrics/model.ts).
// Funciona com o cliente da sessão (RLS limita ao escopo do funcionário) ou com o privilegiado (scripts de verificação).
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CHANNELS, DEFAULT_REOPEN_WINDOW_DAYS, type Channel, type CaseRecord, type ClosureRecord, type HistoryConversation,
  type HistorySurvey, type MvpInput, type ProposalRecord, type SurveyRecord, type UsageRecord,
} from "./model.ts";

export interface StatsFilters {
  runId: string | null;
  from?: string | null; // YYYY-MM-DD (America/Sao_Paulo)
  to?: string | null;
  channel?: Channel | null;
  unit?: string | null;
  brand?: string | null;
  model?: string | null;
  reopenDays?: number | null;
  assumedMinutes?: number | null;
}

const PAGE = 1000;
type Row = Record<string, unknown>;

async function fetchAll(build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>, what: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(`${what}: ${error.message}`);
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

const ms = (v: unknown): number | null => (typeof v === "string" && v ? Date.parse(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export const periodBounds = (f: StatsFilters) => ({
  fromMs: f.from ? Date.parse(`${f.from}T00:00:00-03:00`) : null,
  toMs: f.to ? Date.parse(`${f.to}T23:59:59.999-03:00`) : null,
});
const inPeriod = (t: number, b: { fromMs: number | null; toMs: number | null }) => (b.fromMs === null || t >= b.fromMs) && (b.toMs === null || t <= b.toMs);

export interface MvpLoad { input: MvpInput; runName: string | null; clockNow: string | null; usageCasesWithoutRecord: number }

export async function loadMvp(db: SupabaseClient, f: StatsFilters): Promise<MvpLoad> {
  const empty: MvpInput = { asOf: 0, cases: [], surveys: [], proposals: [], usage: [], audit: { falhas: 0, retentativas: 0, bloqueios: 0, falhasTransitorias: 0 },
    reopenWindowDays: f.reopenDays ?? DEFAULT_REOPEN_WINDOW_DAYS, assumedMinutesPerCase: f.assumedMinutes ?? null };
  if (!f.runId) return { input: empty, runName: null, clockNow: null, usageCasesWithoutRecord: 0 };

  const run = await db.from("scenario_runs").select("name, clock_now").eq("id", f.runId).maybeSingle();
  if (run.error) throw new Error(`cenário: ${run.error.message}`);
  if (!run.data) return { input: empty, runName: null, clockNow: null, usageCasesWithoutRecord: 0 };
  const asOf = Date.parse(run.data.clock_now as string);

  const rid = f.runId;
  const [caseRows, events, closureRows, surveyRows, proposalRows, auditRows, usageRows] = await Promise.all([
    fetchAll((a, b) => {
      let q = db.from("cases").select("id, status, topic, customer_id, order_id, business_unit_id, brand_id, handoff_reason, created_at, case_conversations(conversations(channel, opened_at, first_response_at))")
        .eq("scenario_run_id", rid).order("id").range(a, b);
      if (f.unit) q = q.eq("business_unit_id", f.unit);
      if (f.brand) q = q.eq("brand_id", f.brand);
      return q;
    }, "casos"),
    fetchAll((a, b) => db.from("case_events").select("id, case_id, event_type, occurred_at, data").eq("scenario_run_id", rid)
      .in("event_type", ["caso_aberto", "status_alterado", "primeira_resposta", "intervencao_humana"]).order("id").range(a, b), "eventos"),
    fetchAll((a, b) => db.from("case_closures").select("id, case_id, seq, closed_at, resolution_mode, reopened_at").eq("scenario_run_id", rid).order("id").range(a, b), "encerramentos"),
    fetchAll((a, b) => db.from("case_surveys").select("id, case_id, closure_id, status, score, resolved").eq("scenario_run_id", rid).order("id").range(a, b), "pesquisas"),
    fetchAll((a, b) => db.from("action_proposals").select("id, case_id, action, status, version, amount_cents, proposal_approvals(decision, scenario_at), action_executions(status, attempt)")
      .eq("scenario_run_id", rid).order("id").range(a, b), "propostas"),
    fetchAll((a, b) => db.from("audit_events").select("id, proposal_id, event_type, scenario_at").eq("scenario_run_id", rid)
      .in("event_type", ["proposta_registrada", "execucao_falhou", "execucao_nova_tentativa", "execucao_falha_transitoria", "revalidacao_bloqueou"]).order("id").range(a, b), "auditoria"),
    fetchAll((a, b) => db.from("ai_usage").select("id, case_id, step, requested_model, served_model, prompt_tokens, completion_tokens, cost_usd, latency_ms, ok").eq("scenario_run_id", rid).order("id").range(a, b), "uso de IA"),
  ]);

  const usage: UsageRecord[] = usageRows.map((u) => ({
    caseId: str(u.case_id), step: String(u.step), requestedModel: str(u.requested_model), servedModel: str(u.served_model),
    promptTokens: num(u.prompt_tokens), completionTokens: num(u.completion_tokens), costUsd: num(u.cost_usd), latencyMs: num(u.latency_ms), ok: u.ok !== false,
  }));
  const usageByCase = new Map<string, UsageRecord[]>();
  for (const u of usage) if (u.caseId) usageByCase.set(u.caseId, [...(usageByCase.get(u.caseId) ?? []), u]);

  const evByCase = new Map<string, Row[]>();
  for (const e of events) evByCase.set(String(e.case_id), [...(evByCase.get(String(e.case_id)) ?? []), e]);
  const closuresByCase = new Map<string, ClosureRecord[]>();
  for (const c of closureRows) {
    const rec: ClosureRecord = { id: String(c.id), seq: Number(c.seq), closedAt: ms(c.closed_at) as number,
      mode: c.resolution_mode === "autonoma" ? "autonoma" : "assistida", reopenedAt: ms(c.reopened_at) };
    closuresByCase.set(String(c.case_id), [...(closuresByCase.get(String(c.case_id)) ?? []), rec]);
  }
  const originByCase = new Map<string, { hypothesis: string; status: string }>();
  // Origem investigada vem da proposta mais recente que a registrou.
  const proposalOrigin = await fetchAll((a, b) => db.from("action_proposals").select("case_id, origin, created_at").eq("scenario_run_id", rid).not("origin", "is", null).order("created_at").range(a, b), "origem");
  for (const p of proposalOrigin) {
    const o = p.origin as { hypothesis?: string; status?: string } | null;
    if (o?.hypothesis && o.status) originByCase.set(String(p.case_id), { hypothesis: o.hypothesis, status: o.status });
  }

  const bounds = periodBounds(f);
  const cases: CaseRecord[] = [];
  for (const r of caseRows) {
    const convs = ((r.case_conversations as { conversations: { channel: string; opened_at: string; first_response_at: string | null } | null }[] | null) ?? [])
      .map((x) => x.conversations).filter((x): x is NonNullable<typeof x> => !!x);
    const evs = evByCase.get(String(r.id)) ?? [];
    const openedFrom = [...convs.map((c) => Date.parse(c.opened_at)), ...evs.filter((e) => e.event_type === "caso_aberto").map((e) => ms(e.occurred_at) as number)];
    const openedAt = openedFrom.length ? Math.min(...openedFrom) : (ms(r.created_at) as number);
    const earliest = [...convs].sort((x, y) => Date.parse(x.opened_at) - Date.parse(y.opened_at))[0];
    const channel = (CHANNELS as string[]).includes(earliest?.channel ?? "") ? (earliest.channel as Channel) : "email";

    const frCandidates = [
      ...evs.filter((e) => e.event_type === "primeira_resposta").map((e) => ms(e.occurred_at) as number),
      ...convs.filter((c) => c.first_response_at).map((c) => Date.parse(c.first_response_at as string)),
    ];
    // Espera humana: tempo acumulado em aguardando_humano (inclui o intervalo ainda em curso).
    let humanWaitMs = 0;
    let since: number | null = null;
    for (const e of evs.filter((x) => x.event_type === "status_alterado")) {
      const at = ms(e.occurred_at) as number;
      const to = (e.data as { para?: string } | null)?.para;
      if (since !== null) { humanWaitMs += Math.max(0, at - since); since = null; }
      if (to === "aguardando_humano") since = at;
    }
    if (since !== null) humanWaitMs += Math.max(0, asOf - since);

    const u = usageByCase.get(String(r.id)) ?? [];
    const models = [...new Set(u.map((x) => x.servedModel ?? x.requestedModel).filter((m): m is string => !!m))];
    const rec: CaseRecord = {
      id: String(r.id), status: String(r.status), channel, openedAt, topic: String(r.topic ?? "outros"),
      customerId: str(r.customer_id), orderId: str(r.order_id), unitId: str(r.business_unit_id), brandId: str(r.brand_id),
      handoffReason: str(r.handoff_reason),
      firstResponseAt: frCandidates.length ? Math.min(...frCandidates) : null,
      closures: closuresByCase.get(String(r.id)) ?? [],
      interventionReasons: [...new Set(evs.filter((e) => e.event_type === "intervencao_humana").map((e) => String((e.data as { motivo?: string } | null)?.motivo ?? "intervencao")))],
      origin: originByCase.get(String(r.id)) ?? null, models,
      ai: { calls: u.length, costKnown: u.length > 0 && u.every((x) => x.costUsd !== null), costUsd: u.reduce((a, x) => a + (x.costUsd ?? 0), 0) },
      humanWaitMs,
    };
    if (!inPeriod(openedAt, bounds)) continue;
    if (f.channel && channel !== f.channel) continue;
    if (f.model && !models.includes(f.model)) continue;
    cases.push(rec);
  }

  // Auditoria: instante do pedido de decisão por proposta (1º registro) para o tempo até a decisão.
  const requestedAt = new Map<string, number>();
  for (const a of auditRows) {
    const t = ms(a.scenario_at);
    if (a.event_type === "proposta_registrada" && a.proposal_id && t !== null && !requestedAt.has(String(a.proposal_id))) requestedAt.set(String(a.proposal_id), t);
  }
  const caseSet = new Set(cases.map((c) => c.id));
  // Contagens de auditoria seguem a coorte: só eventos de propostas dos casos filtrados.
  const proposals: ProposalRecord[] = proposalRows.filter((p) => caseSet.has(String(p.case_id))).map((p) => {
    const approvals = (p.proposal_approvals as { decision: string; scenario_at: string | null }[] | null) ?? [];
    const execs = (p.action_executions as { status: string; attempt: number }[] | null) ?? [];
    return {
      id: String(p.id), caseId: String(p.case_id), action: String(p.action), status: String(p.status), version: Number(p.version ?? 1),
      amountCents: num(p.amount_cents), requestedAt: requestedAt.get(String(p.id)) ?? null,
      needsApproval: approvals.length > 0 || p.status === "aguardando_aprovacao",
      decisions: approvals.filter((a) => a.scenario_at).map((a) => ({ decision: a.decision as "aprovada" | "rejeitada" | "suspensa", decidedAt: Date.parse(a.scenario_at as string) })),
      attempts: execs.reduce((m, e) => Math.max(m, e.attempt), 0), executionStatus: execs[0]?.status ?? null,
    };
  });
  const proposalIds = new Set(proposals.map((p) => p.id));
  const cohortAudit = { falhas: 0, retentativas: 0, bloqueios: 0, falhasTransitorias: 0 };
  for (const a of auditRows) {
    if (!a.proposal_id || !proposalIds.has(String(a.proposal_id))) continue;
    if (a.event_type === "execucao_falhou") cohortAudit.falhas++;
    else if (a.event_type === "execucao_nova_tentativa") cohortAudit.retentativas++;
    else if (a.event_type === "execucao_falha_transitoria") cohortAudit.falhasTransitorias++;
    else if (a.event_type === "revalidacao_bloqueou") cohortAudit.bloqueios++;
  }

  const surveys: SurveyRecord[] = surveyRows.filter((s) => caseSet.has(String(s.case_id))).map((s) => ({
    id: String(s.id), caseId: String(s.case_id), closureId: String(s.closure_id),
    status: s.status === "respondida" ? "respondida" : "solicitada", score: num(s.score),
    resolved: s.resolved === "sim" || s.resolved === "parcialmente" || s.resolved === "nao" ? s.resolved : null,
  }));

  const modelUsage = usage.filter((u) => (u.caseId === null ? !f.model : caseSet.has(u.caseId)) && (!f.model || (u.servedModel ?? u.requestedModel) === f.model));
  const withRecord = cases.filter((c) => c.ai.calls > 0).length;
  return {
    runName: run.data.name as string, clockNow: run.data.clock_now as string, usageCasesWithoutRecord: cases.length - withRecord,
    input: { asOf, cases, surveys, proposals, usage: modelUsage, audit: cohortAudit, reopenWindowDays: f.reopenDays ?? DEFAULT_REOPEN_WINDOW_DAYS, assumedMinutesPerCase: f.assumedMinutes ?? null },
  };
}

export async function loadHistory(db: SupabaseClient, f: StatsFilters): Promise<{ conversations: HistoryConversation[]; surveys: HistorySurvey[] }> {
  const b = periodBounds(f);
  const convRows = await fetchAll((x, y) => {
    let q = db.from("conversations").select("conversation_id, channel, opened_at, status, first_response_at, closed_at, business_unit_id, brand_id")
      .eq("origin", "historico").order("conversation_id").range(x, y);
    if (f.channel) q = q.eq("channel", f.channel);
    if (f.unit) q = q.eq("business_unit_id", f.unit);
    if (f.brand) q = q.eq("brand_id", f.brand);
    return q;
  }, "histórico");
  const surveyRows = await fetchAll((x, y) => {
    let q = db.from("survey_history").select("survey_id, channel, sent_at, answered_at, score, business_unit_id, brand_id").order("survey_id").range(x, y);
    if (f.channel) q = q.eq("channel", f.channel);
    if (f.unit) q = q.eq("business_unit_id", f.unit);
    if (f.brand) q = q.eq("brand_id", f.brand);
    return q;
  }, "pesquisas do histórico");
  return {
    conversations: convRows.map((r) => ({
      id: String(r.conversation_id), channel: r.channel as Channel, openedAt: ms(r.opened_at) as number, status: str(r.status),
      firstResponseAt: ms(r.first_response_at), closedAt: ms(r.closed_at), unitId: str(r.business_unit_id), brandId: str(r.brand_id),
    })).filter((c) => inPeriod(c.openedAt, b)),
    surveys: surveyRows.map((r) => ({
      channel: r.channel as Channel, sentAt: ms(r.sent_at) as number, answered: r.answered_at !== null, score: num(r.score),
      unitId: str(r.business_unit_id), brandId: str(r.brand_id),
    })).filter((s) => inPeriod(s.sentAt, b)),
  };
}
