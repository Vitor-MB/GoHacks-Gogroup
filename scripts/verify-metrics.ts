// GOB-11 · Verifica métricas, encerramento válido e pesquisa contra o banco de DESENVOLVIMENTO.
// Pré-requisitos: migration 20261107000009 aplicada (e as anteriores) e importação executada (inclui avaliacoes_csat).
// Uso: node --env-file=.env scripts/verify-metrics.ts
// Parte 1 (sem banco): funções puras com amostra conhecida. Parte 2: cenário temporário "verify-metrics" com casos semeados
// por SQL/RPC; os números calculados pelo mesmo código da página precisam bater com os eventos gravados.
// Cria o cenário "verify-metrics" e o funcionário gob11-sup@verify.test; remove tudo ao final.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readCsv } from "./lib/csv.ts";
import { businessMinutesBetween, computeHistory, computeMvp, percentileNearestRank, slaMinutes, summarize, type HistoryConversation, type HistorySurvey } from "../src/server/metrics/model.ts";
import { loadHistory, loadMvp } from "../src/server/metrics/load.ts";
import { answerSurvey, closeCase, completeSurveyReview } from "../src/server/metrics/survey.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "OK  " : "FALHA"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const near = (a: number | null | undefined, b: number, eps = 1e-9) => typeof a === "number" && Math.abs(a - b) <= eps;
const T = (s: string) => Date.parse(`${s}-03:00`);

// ---------------------------------------------------------------------------
// Parte 1 · funções puras
// ---------------------------------------------------------------------------
console.log("\n# Parte 1 — cálculo com amostra conhecida (sem banco)");
{
  const s = summarize([4, 1, 3, 2, 10, 5, 6, 7, 8, 9])!;
  check("média/mediana/P90 de 1..10", near(s.mean, 5.5) && near(s.median, 5.5) && s.p90 === 9 && s.n === 10, JSON.stringify(s));
  check("amostra vazia → sem estatística (não zero)", summarize([]) === null);
  check("P90 por posto mais próximo (n=3 → maior)", percentileNearestRank([1, 2, 12], 0.9) === 12);
  check("WhatsApp 23:00→08:20 = 20 min comerciais", near(businessMinutesBetween(T("2026-11-02T23:00:00"), T("2026-11-03T08:20:00")), 20));
  check("WhatsApp 19:50→20:10 = 10 min comerciais", near(businessMinutesBetween(T("2026-11-02T19:50:00"), T("2026-11-02T20:10:00")), 10));
  check("WhatsApp 12:00→12:00 dia seguinte = 720 min", near(businessMinutesBetween(T("2026-11-02T12:00:00"), T("2026-11-03T12:00:00")), 720));
  check("e-mail usa tempo corrido", near(slaMinutes("email", T("2026-11-02T23:00:00"), T("2026-11-03T08:20:00")), 560));

  const h: HistoryConversation[] = [
    { id: "a", channel: "whatsapp", openedAt: T("2026-08-04T09:00:00"), status: "resolvido", firstResponseAt: T("2026-08-04T09:20:00"), closedAt: T("2026-08-04T11:00:00"), unitId: null, brandId: null },
    { id: "b", channel: "whatsapp", openedAt: T("2026-08-04T09:00:00"), status: "reaberto", firstResponseAt: T("2026-08-04T10:00:00"), closedAt: null, unitId: null, brandId: null },
    { id: "c", channel: "email", openedAt: T("2026-08-04T09:00:00"), status: "pendente", firstResponseAt: null, closedAt: null, unitId: null, brandId: null },
  ];
  const hs: HistorySurvey[] = [
    { channel: "whatsapp", sentAt: 1, answered: true, score: 5, unitId: null, brandId: null },
    { channel: "whatsapp", sentAt: 2, answered: true, score: 2, unitId: null, brandId: null },
    { channel: "email", sentAt: 3, answered: false, score: null, unitId: null, brandId: null },
    { channel: "email", sentAt: 4, answered: false, score: null, unitId: null, brandId: null },
  ];
  const r = computeHistory(h, hs);
  check("histórico: CSAT 1 de 2 respostas, taxa 2 de 4", r.csat.satisfied === 1 && r.csat.answered === 2 && near(r.csat.csat, 0.5) && near(r.csat.responseRate, 0.5));
  check("histórico: SLA 1 de 2 respondidos (sem resposta fora da conta, mostrada à parte)", r.firstResponse.withinSla === 1 && r.firstResponse.late === 1 && r.firstResponse.withoutHumanResponse === 1 && r.firstResponse.slaDenominator === 2);
  check("histórico: tempo de resolução só de resolvidas com data", r.resolutionTimeHours?.n === 1 && near(r.resolutionTimeHours?.mean, 2));

  const empty = computeMvp({ asOf: 0, cases: [], surveys: [], proposals: [], usage: [], audit: { falhas: 0, retentativas: 0, bloqueios: 0, falhasTransitorias: 0 }, reopenWindowDays: 7, assumedMinutesPerCase: null });
  check("sem casos: taxas são nulas, não 0%", empty.csat.csat === null && empty.csat.responseRate === null && empty.cost.perResolvedUsd === null && empty.resolution.autonomousRate === null && empty.projection.humanMinutesSaved === null);
}

// ---------------------------------------------------------------------------
// Parte 2 · banco
// ---------------------------------------------------------------------------
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !secret) {
  console.error("Defina NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SECRET_KEY.");
  process.exit(failures ? 1 : 2);
}
const db: SupabaseClient = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const ok = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};
let runId = "";
let supId = "";
const at = async (local: string) => { ok(await db.from("scenario_runs").update({ clock_now: new Date(T(local)).toISOString() }).eq("id", runId), "relógio"); };

async function mkCase(key: string, topic: string, convs: { channel: "whatsapp" | "email" | "reclame_aqui"; openedAt: string }[]): Promise<string> {
  const c = ok(await db.from("cases").insert({ scenario_run_id: runId, topic, summary: `verify ${key}` }).select("id"), `caso ${key}`)![0].id as string;
  for (const [i, v] of convs.entries()) {
    const id = `VM-${key}-${i}`;
    ok(await db.from("conversations").insert({ conversation_id: id, channel: v.channel, origin: "simulado", opened_at: new Date(T(v.openedAt)).toISOString(), scenario_run_id: runId }), `conversa ${id}`);
    ok(await db.from("case_conversations").insert({ case_id: c, conversation_id: id }), `vínculo ${id}`);
  }
  return c;
}
const notify = async (caseId: string, kind: "notificacao_cliente" | "intervencao_humana") =>
  ok(await db.from("outbox_events").insert({ scenario_run_id: runId, case_id: caseId, kind, payload: { text: "verify" } }), `outbox ${kind}`);
const usage = async (caseId: string, rows: Record<string, unknown>[]) =>
  ok(await db.from("ai_usage").insert(rows.map((r) => ({ scenario_run_id: runId, case_id: caseId, step: "investigacao", adapter_kind: "simulado", occurred_at: new Date(T("2026-11-02T09:00:00")).toISOString(), ...r }))), "uso de IA");
const rpcErr = async (p: PromiseLike<unknown>) => { try { await p; return null; } catch (e) { return e instanceof Error ? e.message : String(e); } };

async function main() {
  console.log("\n# Parte 2 — encerramento, pesquisa e métricas no banco");
  await db.from("scenario_runs").delete().eq("name", "verify-metrics");
  await db.from("staff").delete().like("email", "gob11-%@verify.test");
  runId = ok(await db.from("scenario_runs").insert({ name: "verify-metrics", mode: "preview" }).select("id"), "cenário")![0].id as string;
  supId = ok(await db.from("staff").insert({ full_name: "Teste sup", email: "gob11-sup@verify.test", role: "supervisor" }).select("id"), "staff")![0].id as string;
  ok(await db.from("staff_scopes").insert({ staff_id: supId, scope: "group" }), "escopo");

  // Casos (relógio do cenário avança entre os passos)
  await at("2026-11-02T08:00:00");
  const B = await mkCase("B", "rastreio_atraso", [{ channel: "email", openedAt: "2026-11-02T08:00:00" }]);
  await at("2026-11-02T09:00:00");
  const A = await mkCase("A", "rastreio_atraso", [{ channel: "whatsapp", openedAt: "2026-11-02T09:00:00" }]);
  const H = await mkCase("H", "avaria", [{ channel: "email", openedAt: "2026-11-02T09:00:00" }]);
  await at("2026-11-02T09:10:00");
  await notify(A, "notificacao_cliente"); // 1ª resposta substantiva de A: 10 min
  await at("2026-11-02T10:00:00");
  const E = await mkCase("E", "rastreio_atraso", [{ channel: "whatsapp", openedAt: "2026-11-02T10:00:00" }, { channel: "email", openedAt: "2026-11-02T10:30:00" }]);
  const closeA = await closeCase(db, { caseId: A, actorId: null });
  check("encerramento autônomo de A: resolução autônoma e 1 pesquisa", closeA.resolution_mode === "autonoma" && closeA.survey_requested && !!closeA.survey_id);
  const againA = await closeCase(db, { caseId: A, actorId: null });
  check("encerrar A de novo não cria outro encerramento nem pesquisa", againA.already_closed && !againA.survey_requested && againA.closure_id === closeA.closure_id);
  check("A tem exatamente 1 pesquisa", ok(await db.from("case_surveys").select("id").eq("case_id", A), "pesquisas A")!.length === 1);
  await at("2026-11-02T10:20:00");
  await notify(E, "notificacao_cliente");
  await notify(E, "notificacao_cliente"); // segunda notificação não vira outra "primeira resposta"
  check("só uma primeira_resposta por caso", ok(await db.from("case_events").select("id").eq("case_id", E).eq("event_type", "primeira_resposta"), "eventos E")!.length === 1);
  await at("2026-11-02T11:30:00");
  // Caso multicanal: dois fechamentos simultâneos geram um encerramento e uma pesquisa
  const [e1, e2] = await Promise.all([closeCase(db, { caseId: E, actorId: null }), closeCase(db, { caseId: E, actorId: null }).catch((e) => e as Error)]);
  const e2ok = !(e2 instanceof Error);
  check("multicanal (2 chamadas simultâneas): um só encerramento", ok(await db.from("case_closures").select("id").eq("case_id", E), "enc E")!.length === 1, e2ok ? "" : `a concorrente falhou: ${(e2 as Error).message}`);
  const surveysE = ok(await db.from("case_surveys").select("id, channel").eq("case_id", E), "pesq E")!;
  check("multicanal: UMA pesquisa no encerramento", surveysE.length === 1 && !!e1.survey_id);
  check("pesquisa vai por um canal privado: o da conversa mais recente (e-mail)", surveysE[0]?.channel === "email");
  check("pesquisa aparece no outbox uma vez, só privada", ok(await db.from("outbox_events").select("payload").eq("case_id", E).eq("kind", "pesquisa_satisfacao"), "outbox E")!.length === 1);

  // Caso assistido: ação de funcionário + encerramento por pessoa
  await at("2026-11-02T19:00:00");
  ok(await db.rpc("append_audit", { p_run: runId, p_case: B, p_proposal: null, p_type: "caso_atribuido", p_actor_type: "staff", p_actor_id: supId, p_data: {}, p_correlation: null }), "audit B");
  await at("2026-11-02T20:00:00");
  const closeB = await closeCase(db, { caseId: B, actorId: supId });
  check("B encerrado por pessoa: resolução assistida", closeB.resolution_mode === "assistida" && closeB.survey_requested);

  // Encerramento inválido: proposta pendente
  await at("2026-11-02T12:00:00");
  const G = await mkCase("G", "rastreio_atraso", [{ channel: "whatsapp", openedAt: "2026-11-02T12:00:00" }]);
  ok(await db.from("action_proposals").insert({ scenario_run_id: runId, case_id: G, action: "reembolsar", category: "atraso_entrega", amount_cents: 15000, status: "aguardando_aprovacao",
    idempotency_key: "vm-g", proposed_by: "gobia:teste", origin: { hypothesis: "transporte", status: "hipotese", summary: "x" } }), "proposta G");
  await notify(G, "intervencao_humana"); // aviso interno não é primeira resposta
  const refused = await rpcErr(closeCase(db, { caseId: G, actorId: null }));
  check("encerramento com proposta pendente é recusado", !!refused && /estado_invalido/.test(refused), refused ?? "aceito");
  check("caso recusado continua aberto e sem pesquisa", ok(await db.from("cases").select("status").eq("id", G), "G")![0].status !== "resolvido"
    && ok(await db.from("case_surveys").select("id").eq("case_id", G), "pesq G")!.length === 0);
  check("aviso interno e pesquisa não contam como primeira resposta", ok(await db.from("case_events").select("id").eq("case_id", G).eq("event_type", "primeira_resposta"), "ev G")!.length === 0);

  // Abertos e reabertos
  await at("2026-11-02T22:00:00");
  const D = await mkCase("D", "troca_devolucao", [{ channel: "whatsapp", openedAt: "2026-11-02T22:00:00" }]);
  await at("2026-11-03T08:00:00");
  await mkCase("C", "rastreio_atraso", [{ channel: "reclame_aqui", openedAt: "2026-11-03T08:00:00" }]);
  await at("2026-11-03T08:20:00");
  await notify(D, "notificacao_cliente"); // WhatsApp fora do horário: 20 min comerciais
  await at("2026-11-03T09:00:00");
  const closeD = await closeCase(db, { caseId: D, actorId: null });
  const closeH = await closeCase(db, { caseId: H, actorId: null });
  check("H não tem primeira resposta (a pesquisa solicitada não conta)", ok(await db.from("case_events").select("id").eq("case_id", H).eq("event_type", "primeira_resposta"), "ev H")!.length === 0);

  // Respostas
  const ansA = await answerSurvey(db, { surveyId: closeA.survey_id as string, score: 5, resolved: "sim", comment: "ótimo" });
  check("A respondida (5, sim) sem revisão", !ansA.reused && !ansA.review_id && !ansA.reopened);
  const ansA2 = await answerSurvey(db, { surveyId: closeA.survey_id as string, score: 1, resolved: "nao" });
  check("segunda resposta não sobrescreve a primeira", ansA2.reused && ansA2.score === 5);
  check("A continua resolvido após resposta positiva", ok(await db.from("cases").select("status").eq("id", A), "A")![0].status === "resolvido");
  const bad = await rpcErr(answerSurvey(db, { surveyId: closeD.survey_id as string, score: 6, resolved: "sim" }));
  check("nota fora de 1–5 é recusada", !!bad, bad ?? "aceita");
  await at("2026-11-03T10:00:00");
  const ansD = await answerSurvey(db, { surveyId: closeD.survey_id as string, score: 2, resolved: "nao", comment: "não chegou" });
  check("resposta 'não': revisão criada e caso reaberto para pessoa", !!ansD.review_id && ansD.reopened === true);
  const dRow = ok(await db.from("cases").select("status, handoff_reason").eq("id", D), "D")![0];
  check("D voltou à fila humana (aguardando_humano, motivo pesquisa_negativa)", dRow.status === "aguardando_humano" && dRow.handoff_reason === "pesquisa_negativa");
  const ansH = await answerSurvey(db, { surveyId: closeH.survey_id as string, score: 4, resolved: "parcialmente" });
  check("resposta 'parcialmente' também gera revisão e continuidade", !!ansH.review_id && ansH.reopened === true);
  check("aviso interno ao supervisor registrado", ok(await db.from("internal_notifications").select("id").eq("case_id", D).eq("kind", "pesquisa_negativa"), "notif D")!.length === 1);
  const rev = await completeSurveyReview(db, { reviewId: ansD.review_id as string, actorId: supId, note: "reabrir", area: "conhecimento", evalSet: true });
  check("revisão concluída marca candidato ao conjunto fixo, sem mudar política", rev.status === "concluida" && rev.eval_set === true);
  check("nenhuma tabela de política/alçada foi alterada pela pesquisa", ok(await db.from("audit_events").select("event_type").eq("case_id", D).in("event_type", ["politica_alterada", "alcada_alterada"]), "audit D")!.length === 0);
  // Reencerrar D gera nova pesquisa (novo encerramento válido) — e ela é uma só
  await at("2026-11-03T10:30:00");
  const closeD2 = await closeCase(db, { caseId: D, actorId: supId });
  check("reencerramento após reabertura: seq 2 e nova pesquisa única", closeD2.seq === 2 && closeD2.survey_requested && closeD2.survey_id !== closeD.survey_id);
  // ...e volta a ficar reaberto para manter a amostra conhecida: nova resposta negativa
  const ansD2 = await answerSurvey(db, { surveyId: closeD2.survey_id as string, score: 1, resolved: "nao" });
  check("nova resposta negativa reabre de novo", ansD2.reopened === true);

  // Uso de IA: A com custo indisponível; E com custo conhecido e troca de modelo
  await usage(A, [
    { requested_model: "glm-5.3", served_model: "glm-5.3", prompt_tokens: 100, completion_tokens: 50, cost_usd: null, latency_ms: 800 },
    { requested_model: "glm-5.3", served_model: "glm-5.3", prompt_tokens: 120, completion_tokens: 60, cost_usd: null, latency_ms: 1200 },
  ]);
  await usage(E, [
    { requested_model: "glm-5.3", served_model: "glm-5.3-flash", prompt_tokens: 10, completion_tokens: 5, cost_usd: 0.002, latency_ms: 300 },
    { requested_model: "glm-5.3", served_model: "glm-5.3-flash", prompt_tokens: 20, completion_tokens: 8, cost_usd: 0.003, latency_ms: 500 },
  ]);
  await at("2026-11-03T12:00:00"); // asOf da conta

  // Eventos acrescentados: sem UPDATE
  const upd = await db.from("case_events").update({ occurred_at: new Date().toISOString() }).eq("case_id", A);
  check("case_events é somente de acréscimo", !!upd.error);

  // ---- Conferência dos números contra os eventos semeados ----
  const load = await loadMvp(db, { runId, assumedMinutes: 10 });
  const m = computeMvp(load.input);
  const r = m.resolution;
  check("recebidos = 7", m.received === 7, String(m.received));
  check("elegíveis = 5; autônomos 2 (A,E); assistidos 1 (B); abertos 2 (C,G); taxa 2/5", r.eligible === 5 && r.eligibleResolvedAutonomous === 2 && r.eligibleResolvedAssisted === 1 && r.eligibleOpen === 2 && near(r.autonomousRate, 0.4), JSON.stringify(r));
  check("resolvidos = 3 (A,B,E); abertos = 4 (C,D,G,H) — caso aberto/reaberto não conta", r.resolvedTotal === 3 && r.open === 4 && r.resolvedAutonomous === 2 && r.resolvedAssisted === 1);
  check("tempo de resolução [1; 1,5; 12] h", m.resolutionTimeHours?.n === 3 && near(m.resolutionTimeHours.mean, 14.5 / 3) && near(m.resolutionTimeHours.median, 1.5) && near(m.resolutionTimeHours.p90, 12), JSON.stringify(m.resolutionTimeHours));
  check("idade dos abertos [4; 14; 24; 27] h", m.openAgesHours?.n === 4 && near(m.openAgesHours.mean, 17.25) && near(m.openAgesHours.median, 19) && near(m.openAgesHours.p90, 27), JSON.stringify(m.openAgesHours));
  const f = m.firstResponse;
  check("SLA: 3 no prazo de 6 (vencidos sem resposta B,G,H; C ainda no prazo fora da conta)", f.withinSla === 3 && f.late === 0 && f.unansweredOverdue === 3 && f.unansweredWaiting === 1 && f.slaDenominator === 6 && near(f.slaRate, 0.5), JSON.stringify(f));
  check("tempos de 1ª resposta [10; 20; 20] min (WhatsApp em horário comercial)", f.minutes?.n === 3 && near(f.minutes.mean, 50 / 3) && near(f.minutes.median, 20), JSON.stringify(f.minutes));
  check("CSAT: 2 de 4 respostas (A=5, H=4; D=2 e D=1 não); taxa 4 de 6 pesquisas", m.csat.satisfied === 2 && m.csat.answered === 4 && near(m.csat.csat, 0.5) && m.csat.surveysRequested === 6 && near(m.csat.responseRate, 4 / 6) && m.csat.awaitingAnswer === 2, JSON.stringify(m.csat));
  check("pesquisa sem resposta não conta como satisfação (B e E aguardando)", m.csat.resolvedYes === 1 && m.csat.resolvedPartially === 1 && m.csat.resolvedNo === 2);
  check("reabertura: 3 de 6 encerramentos (D 1º, H e D 2º reabertos pela pesquisa)",
    m.reopening.closures === 6 && m.reopening.reopenedExplicit === 3 && near(m.reopening.rate, 0.5), JSON.stringify(m.reopening));
  check("custo por caso resolvido: só E conhecido (0,005); A e B indisponíveis — nunca zero", m.cost.resolvedKnown === 1 && m.cost.resolvedUnknown === 2 && near(m.cost.perResolvedUsd, 0.005) && m.cost.openKnown === 0 && m.cost.openUnknown === 4, JSON.stringify(m.cost));
  const mA = m.models.find((x) => x.model === "glm-5.3");
  const mE = m.models.find((x) => x.model === "glm-5.3-flash");
  check("modelos: glm-5.3 com custo indisponível; flash com 2 trocas e custo 0,005", !!mA && mA.calls === 2 && mA.costUnknownCalls === 2 && mA.swaps === 0 && !!mE && mE.calls === 2 && mE.swaps === 2 && near(mE.costUsd, 0.005) && mE.costUnknownCalls === 0, JSON.stringify(m.models.map((x) => [x.model, x.calls, x.swaps, x.costUnknownCalls])));
  check("intervenções: B, D e H tiveram pessoa; motivos registrados", m.interventions.casesWithIntervention >= 3 && m.interventions.reasons.length > 0, JSON.stringify(m.interventions.reasons));
  check("origem: transporte como hipótese (G) e 6 casos não investigados como indeterminada", m.origins.some((o) => o.hypothesis === "transporte" && o.status === "hipotese" && o.count === 1) && m.origins.some((o) => o.hypothesis === "indeterminada" && o.status === "nao_investigada" && o.count === 6), JSON.stringify(m.origins));
  check("projeção: 2 autônomos × 10 min = 20 min (premissa)", m.projection.humanMinutesSaved === 20 && m.projection.refundValueCents === 0);
  check("duplicidades evitadas aparecem como não medidas (null)", m.quality.duplicatesAvoided === null);

  // Filtros
  const byChannel = computeMvp((await loadMvp(db, { runId, channel: "email" })).input);
  check("filtro canal=e-mail: B e H", byChannel.received === 2);
  const byModel = computeMvp((await loadMvp(db, { runId, model: "glm-5.3-flash" })).input);
  check("filtro modelo=glm-5.3-flash: só E", byModel.received === 1 && byModel.models.length === 1 && byModel.resolution.resolvedTotal === 1);
  const byPeriod = computeMvp((await loadMvp(db, { runId, from: "2026-11-03" })).input);
  check("filtro período a partir de 03/11: só C", byPeriod.received === 1 && byPeriod.resolution.open === 1);
  const none = computeMvp((await loadMvp(db, { runId, from: "2027-01-01" })).input);
  check("coorte vazia: nada de 0% inventado", none.received === 0 && none.csat.csat === null && none.cost.perResolvedUsd === null);
  const other = await db.from("scenario_runs").insert({ name: "verify-metrics-b", mode: "preview" }).select("id");
  const otherId = ok(other, "cenário b")![0].id as string;
  const isolated = computeMvp((await loadMvp(db, { runId: otherId })).input);
  check("cenário separado não enxerga os casos do outro", isolated.received === 0);
  await db.from("scenario_runs").delete().eq("id", otherId);

  // Acesso: o navegador anônimo não lê nem executa as funções
  if (publishable) {
    const anon = createClient(url as string, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
    const rd = await anon.from("case_events").select("id").limit(1);
    check("anônimo não lê case_events (RLS)", !rd.error ? (rd.data ?? []).length === 0 : true);
    const rp = await anon.rpc("close_case", { p_case: A, p_actor: null, p_note: null });
    check("anônimo não executa close_case", !!rp.error);
    const rs = await anon.rpc("record_survey_response", { p_survey: closeA.survey_id, p_score: 5, p_resolved: "sim", p_comment: null });
    check("anônimo não executa record_survey_response", !!rs.error);
  } else console.log("AVISO chave publicável ausente: checagem de acesso anônimo pulada.");

  // Histórico importado: números do banco = CSV
  const csv = readCsv("BD/avaliacoes_csat.csv");
  const { count } = await db.from("survey_history").select("*", { count: "exact", head: true });
  if (!count) console.log("AVISO survey_history vazia: rode a importação (node --env-file=.env scripts/import-data.ts) para conferir o histórico.");
  else {
    const hist = await loadHistory(db, {});
    const hs = computeHistory(hist.conversations, hist.surveys);
    const sent = csv.length;
    const answered = csv.filter((x) => x.nota !== "").length;
    const sat = csv.filter((x) => Number(x.nota) >= 4).length;
    check(`histórico: pesquisas enviadas/respondidas = CSV (${sent}/${answered})`, hs.csat.sent === sent && hs.csat.answered === answered && hs.csat.satisfied === sat, `${hs.csat.sent}/${hs.csat.answered}/${hs.csat.satisfied}`);
    const conv = readCsv("BD/historico_conversas.csv");
    check(`histórico: ${conv.length} conversas e status batem com o CSV`, hs.conversations === conv.length && hs.resolved === conv.filter((x) => x.status === "resolvido").length, `${hs.conversations}`);
  }
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); failures++; })
  .finally(async () => {
    await db.from("scenario_runs").delete().in("name", ["verify-metrics", "verify-metrics-b"]);
    await db.from("staff").delete().like("email", "gob11-%@verify.test");
    console.log(failures ? `\n${failures} verificação(ões) FALHARAM.` : "\nTodas as verificações passaram.");
    process.exit(failures ? 1 : 0);
  });
