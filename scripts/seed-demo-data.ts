// Dados de exemplo para a demonstração: enche a Fila de supervisão, as Ações em espera (janela de revisão e aprovações)
// e os Atendimentos resolvidos do cenário "demo", usando os casos que já existem e as mesmas funções do sistema
// (proposta, encaminhamento, encerramento, pesquisa). Tudo é SIMULADO e identificado: propostas saem de "gobia:simulado:seed-demo",
// a origem diz que é exemplo, e cada caso mexido recebe o evento de auditoria "seed_demo". Nenhuma chamada ao proxy de IA.
// Uso:  node --env-file=.env scripts/seed-demo-data.ts            (idempotente: se já carregou, não repete)
// Para voltar ao estado inicial, use o reset do cenário (reset_scenario_run) e rode scripts/seed-queue.ts de novo.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readCsv } from "./lib/csv.ts";
import type { InvestigationOutcome } from "../src/server/ai/investigate.ts";
import { recordInvestigation } from "../src/server/execution/execute.ts";
import { answerSurvey, closeCase } from "../src/server/metrics/survey.ts";
import { decide, paramsFromPolicy, type VerifiedFacts } from "../src/server/policy/decision.ts";
import { assignCase } from "../src/server/queue/approvals.ts";
import { scenarioClock } from "../src/server/queries.ts";

const { NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SECRET_KEY: secret } = process.env;
if (!url || !secret) {
  console.error("Defina NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SECRET_KEY.");
  process.exit(2);
}
const db: SupabaseClient = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const params = paramsFromPolicy(readCsv("BD/politicas.csv").map((r) => ({ secao: r.secao, regra: r.regra, valor: r.valor })));
const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

interface Cand { id: string; topic: string; orderId: string; totalCents: number; openedAt: string; channels: string[] }

const SIM = "simulado:seed-demo";
const NOTE_ORIGIN = "Exemplo de demonstração (dados simulados): atraso acima do prazo prometido, a confirmar com a transportadora.";

const facts = (orderId: string, totalCents: number): VerifiedFacts => ({
  orderId, orderValueCents: totalCents, separatedOn: "2026-10-22", deliveredOn: null, promisedOn: "2026-10-15",
  lastEventOn: "2026-10-28", lastEventStatus: "em_transito", lostConfirmed: false, identityConflicts: [], duplicate: null,
  suspicionPending: false, customerPreference: "reembolso", hasPhoto: false,
});

function outcome(status: InvestigationOutcome["status"], c: Cand, asOf: string, extra: Partial<InvestigationOutcome> = {}): InvestigationOutcome {
  const decision = decide({
    asOf, category: "atraso_entrega", action: "reembolsar", requestedCents: null,
    facts: facts(c.orderId, c.totalCents), actor: { id: "gobia", role: "atendente" }, approval: null, params,
  });
  return {
    status, category: "atraso_entrega", decision, reply: "texto do modelo (não usado)", handoff: null, humanActions: [], warnings: [],
    adapter: SIM, steps: 2, evidenceRefs: [`orders:${c.orderId}`], origin: { hypothesis: "transporte", status: "hipotese", evidenceRefs: [`orders:${c.orderId}`], summary: NOTE_ORIGIN },
    proposal: { action: "reembolsar", category: "atraso_entrega" } as unknown as InvestigationOutcome["proposal"], ...extra,
  };
}

async function main() {
  const { data: run } = await db.from("scenario_runs").select("id").eq("name", "demo").maybeSingle();
  if (!run) throw new Error('Cenário "demo" não encontrado. Rode scripts/seed-queue.ts antes.');
  const runId = run.id as string;

  const { count: done } = await db.from("audit_events").select("id", { count: "exact", head: true }).eq("scenario_run_id", runId).eq("event_type", "seed_demo").eq("data->>kind", "fim");
  if ((done ?? 0) > 0) { console.log("Dados de exemplo já carregados. Nada a fazer."); return; }

  const asOf = (await scenarioClock(db, runId)).slice(0, 10);

  // Candidatos: casos novos, sem proposta, com cliente e pedido.
  const rows = must(await db.from("cases")
    .select("id, topic, order_id, customer_id, orders(total_cents), case_conversations(conversations(channel, opened_at)), action_proposals(id)")
    .eq("scenario_run_id", runId).eq("status", "novo").not("order_id", "is", null).not("customer_id", "is", null).order("id"), "casos") as unknown as {
      id: string; topic: string; order_id: string; orders: { total_cents: number | null } | null;
      case_conversations: { conversations: { channel: string; opened_at: string } | null }[]; action_proposals: { id: string }[];
    }[];
  const all: Cand[] = rows.filter((r) => r.action_proposals.length === 0 && r.orders?.total_cents).map((r) => {
    const convs = r.case_conversations.map((c) => c.conversations).filter((c): c is NonNullable<typeof c> => !!c);
    return { id: r.id, topic: r.topic, orderId: r.order_id, totalCents: r.orders!.total_cents!, openedAt: convs.map((c) => c.opened_at).sort()[0] ?? "", channels: [...new Set(convs.map((c) => c.channel))] };
  });
  const used = new Set<string>();
  const take = (n: number, pred: (c: Cand) => boolean, prefer?: (c: Cand) => number): Cand[] => {
    const pool = all.filter((c) => !used.has(c.id) && pred(c)).sort((a, b) => (prefer ? prefer(b) - prefer(a) : 0));
    const out = pool.slice(0, n);
    for (const c of out) used.add(c.id);
    return out;
  };
  const mark = async (c: Cand, kind: string) =>
    must(await db.rpc("append_audit", { p_run: runId, p_case: c.id, p_proposal: null, p_type: "seed_demo", p_actor_type: "system", p_actor_id: null,
      p_data: { kind, simulated: true, note: "dados de exemplo da demonstração" }, p_correlation: `seed:${c.id}` }), "marcar");

  const summary: Record<string, number> = {};
  const bump = (k: string) => { summary[k] = (summary[k] ?? 0) + 1; };

  // ---- Fila de supervisão: 4 aprovações acima da alçada (Reclame Aqui primeiro, para mostrar "Reclamação pública")
  const approvals = take(4, (c) => c.totalCents >= 15000, (c) => (c.channels.includes("reclame_aqui") ? 1000000 : 0) + c.totalCents);
  for (const c of approvals) {
    const o = outcome("aguardando_aprovacao", c, asOf);
    if (!o.decision?.approvalRequired) { used.delete(c.id); continue; }
    await recordInvestigation(db, runId, c.id, c.orderId, o, { approvalDueHours: 24 });
    await mark(c, "aprovacao_supervisor"); bump("aprovação do supervisor");
  }

  // ---- Reação adversa: orientação com encaminhamento ao supervisor (o caso de reação adversa que existe no cenário)
  for (const c of take(1, (c) => c.topic === "reacao_adversa")) {
    await recordInvestigation(db, runId, c.id, c.orderId, outcome("orientacao", c, asOf, {
      category: "reacao_adversa", decision: null, proposal: null, origin: null,
      handoff: { team: "supervisor", guidance: "Relato de reação adversa: orientar o cliente a suspender o uso e registrar a cosmetovigilância em até 24 h" } as unknown as InvestigationOutcome["handoff"],
      humanActions: ["registrar cosmetovigilância"],
    }));
    await mark(c, "reacao_adversa"); bump("reação adversa");
  }
  // ---- Orientação ao atendimento (troca ou devolução) e continuidade humana (IA não concluiu)
  for (const c of take(1, (c) => c.topic === "troca_devolucao" || c.topic === "avaria")) {
    await recordInvestigation(db, runId, c.id, c.orderId, outcome("orientacao", c, asOf, {
      category: "troca_avaria", decision: null, proposal: null, origin: null,
      handoff: { team: "atendimento", guidance: "Orientar o cliente sobre a troca e acompanhar o encaminhamento" } as unknown as InvestigationOutcome["handoff"],
    }));
    await mark(c, "orientacao"); bump("orientação ao atendimento");
  }
  for (const c of take(1, () => true, (c) => (c.channels.includes("whatsapp") ? 1 : 0))) {
    await recordInvestigation(db, runId, c.id, c.orderId, outcome("continuidade_humana", c, asOf, { decision: null, proposal: null, origin: null, warnings: ["IA indisponível: investigação não concluída (exemplo simulado)"] }));
    await mark(c, "continuidade_humana"); bump("continuidade humana");
  }

  // ---- Ações em espera: reembolsos de baixo valor já autorizados pela política, em janela de revisão de 2 h
  for (const c of take(4, (c) => c.totalCents <= 10000 && c.totalCents >= 2000, (c) => c.totalCents)) {
    const o = outcome("proposta_validada", c, asOf);
    if (o.decision?.approvalRequired || !o.decision?.reviewWindowAllowed) { used.delete(c.id); continue; }
    await recordInvestigation(db, runId, c.id, c.orderId, o, { reviewWindowHours: 2 });
    await mark(c, "janela_de_revisao"); bump("janela de revisão");
  }

  // ---- Atendimentos resolvidos: encerrados com pesquisa, uns pela GoBIA e outros com pessoa
  // Supervisor com escopo de grupo: pode assumir qualquer caso do cenário.
  const { data: groupScopes } = await db.from("staff_scopes").select("staff_id, staff!inner(role, active)").eq("scope", "group");
  const supId = (groupScopes as unknown as { staff_id: string; staff: { role: string; active: boolean } }[] | null)?.find((g) => g.staff.role === "supervisor" && g.staff.active)?.staff_id;
  if (!supId) console.log("Aviso: nenhum supervisor com escopo de grupo; os resolvidos ficam todos como resolvidos pela GoBIA.");
  const recent = (c: Cand) => c.openedAt >= "2026-10-31T00:00:00Z";
  const resolved = take(12, recent, (c) => -Date.parse(c.openedAt));
  const scores = [5, 5, 4, 5, 3, 4, 5, 2, 4, 5, 4];
  let i = 0;
  for (const [n, c] of resolved.entries()) {
    const assisted = n % 3 === 2 && !!supId; // 1 em cada 3 com pessoa
    if (assisted) await assignCase(db, { caseId: c.id, actorId: supId!, assigneeId: supId!, note: "exemplo de demonstração" });
    const closed = await closeCase(db, { caseId: c.id, actorId: assisted ? supId! : null });
    // Horário de encerramento plausível: de 4 a 95 minutos depois da abertura (relógio do cenário).
    const mins = 4 + ((n * 37) % 92);
    must(await db.from("case_closures").update({ closed_at: new Date(Date.parse(c.openedAt) + mins * 60_000).toISOString() }).eq("id", closed.closure_id), "horário do encerramento");
    await mark(c, assisted ? "resolvido_com_pessoa" : "resolvido_pela_gobia"); bump(assisted ? "resolvido com pessoa" : "resolvido pela GoBIA");
    if (closed.survey_id && i < scores.length && n !== 5) { // nem todo mundo responde a pesquisa
      await answerSurvey(db, { surveyId: closed.survey_id, score: scores[i]!, resolved: "sim", comment: scores[i]! <= 3 ? "Demorou mais do que eu esperava." : undefined });
      i++;
    }
  }

  const last = resolved.at(-1) ?? all[0];
  if (last) await mark(last, "fim");
  console.log("Dados de exemplo carregados no cenário demo:");
  for (const [k, v] of Object.entries(summary)) console.log(`  ${v} × ${k}`);
  const status = must(await db.from("cases").select("status").eq("scenario_run_id", runId), "contagem");
  const by: Record<string, number> = {};
  for (const r of status ?? []) by[r.status as string] = (by[r.status as string] ?? 0) + 1;
  console.log("Casos por situação:", by);
}

main().catch((e) => { console.error(`ERRO: ${(e as Error).message}`); process.exit(1); });
