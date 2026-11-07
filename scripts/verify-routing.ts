// GOB-13 · Verificação OFFLINE do roteamento adaptativo (adaptadores SIMULADOS e identificados; nenhuma chamada ao proxy).
// Cobre: resolução de modelos, decisão por sinais do servidor, continuidade de contexto e permissões entre camadas,
// orçamento único, contingência, modo de modelo único, registro de uso e comparativo (qualidade x custo).
// Uso: node scripts/verify-routing.ts
import { readCsv } from "./lib/csv.ts";
import { paramsFromPolicy, type VerifiedFacts } from "../src/server/policy/decision.ts";
import { evidence, type Conflict } from "../src/server/evidence.ts";
import {
  AdapterError, createSimulatedAdapter, type CallObservation, type ChatMessage, type ModelAdapter,
} from "../src/server/ai/adapter.ts";
import { chooseTier, createRouter, detectMultiIntent, resolveTierModels } from "../src/server/ai/router.ts";
import { createModelAdapter, parseRouting } from "../src/server/ai/factory.ts";
import { investigate, type ToolRunner } from "../src/server/ai/investigate.ts";
import { compareStrategies, type CaseRun } from "../src/server/ai/compare.ts";
import { usageRecorder } from "../src/server/metrics/survey.ts";

let failed = 0;
const ok = (cond: boolean, name: string, extra = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "OK  " : "FALHA"} ${name}${extra ? ` — ${extra}` : ""}`);
};

const params = paramsFromPolicy(readCsv("BD/politicas.csv").map((r) => ({ secao: r.secao, regra: r.regra, valor: r.valor })));
const actor = { id: "gobia", role: "atendente" } as const;
const facts = (): VerifiedFacts => ({
  orderId: "GCH100001", orderValueCents: 8000, separatedOn: "2026-10-22", deliveredOn: null, promisedOn: "2026-10-30",
  lastEventOn: "2026-10-29", lastEventStatus: "em_transito", lostConfirmed: false, identityConflicts: [], duplicate: null,
  suspicionPending: false, customerPreference: null, hasPhoto: false,
});

const conflict: Conflict = { field: "tracking", detail: "portais divergem", sources: [{ table: "tracking_events", id: "GCH100001" }] };
const tools = (withConflict: boolean): ToolRunner & { calls: string[] } => {
  const calls: string[] = [];
  const mk = (name: string, src: { table: string; id: string }) => async () => {
    calls.push(name);
    return evidence("2026-11-04T08:00:00Z", { nome: name, nota: "dado de teste" }, { sources: [src], conflicts: withConflict ? [conflict] : [] });
  };
  return Object.assign({
    get_order: mk("get_order", { table: "orders", id: "GCH100001" }),
    get_tracking: mk("get_tracking", { table: "tracking_events", id: "GCH100001" }),
    get_production: mk("get_production", { table: "attachments", id: "A1" }),
    get_product_sheet: mk("get_product_sheet", { table: "products", id: "SKU1" }),
    search_knowledge: mk("search_knowledge", { table: "knowledge_documents", id: "K1" }),
  }, { calls });
};
const toolTurn = (order = "GCH100001") => JSON.stringify({ tool_calls: [{ name: "get_tracking", args: { order_id: order } }] });
const proposalJson = (p: Record<string, unknown> = {}) => JSON.stringify({
  proposal: {
    category: "atraso_entrega", secondary_categories: [], missing_info: [],
    origin: { hypothesis: "transporte", status: "hipotese", evidence_refs: ["tracking_events:GCH100001"], summary: "Rastreio sem atualização." },
    action: "abrir_chamado_transportadora", needs_clarification: false,
    reply: "Verifiquei o seu pedido: o rastreio está sem atualização. Vou abrir um chamado com a transportadora e atualizo você.",
    ...p,
  },
});

/** Adaptador simulado com id próprio (a camada é identificável nos registros). */
const tagged = (id: string, script: (m: ChatMessage[], n: number) => string | Promise<string>) => {
  // `snaps` guarda uma cópia das mensagens NO MOMENTO da chamada (o investigador reaproveita o mesmo array).
  const snaps: ChatMessage[][] = [];
  return Object.assign(createSimulatedAdapter((m, n) => { snaps.push(m.map((x) => ({ ...x }))); return script(m, n); }), { id: `simulado:${id}`, snaps });
};

const BUDGET = { maxCalls: 6, maxTokens: 100_000 };
const input = (adapter: ModelAdapter, over: Partial<Parameters<typeof investigate>[0]> = {}) => ({
  adapter, tools: tools(false), message: { text: "Meu pedido GCH100001 atrasou, cadê?" }, orderId: "GCH100001", asOfDate: "2026-11-04",
  params, actor, loadFacts: async () => facts(), ...over,
});
const sig = (over: Partial<import("../src/server/ai/adapter.ts").RouteSignals> = {}) => ({ step: 1, multiIntent: false, conflicts: 0, toolErrors: 0, pendingRepair: false, ...over });
const st = (over: Partial<{ previous: "economy" | "reasoning" | null; reasoningUsed: number; maxReasoningCalls: number }> = {}) => ({ previous: null, reasoningUsed: 0, maxReasoningCalls: 3, ...over });

async function main() {
  console.log("— Modelos e estratégia —");
  ok(resolveTierModels({ model: "m1" }).single, "só CLAUDE_MODEL → modelo único");
  ok(resolveTierModels({ model: "m1", economy: "a", reasoning: "a" }).single, "economy = reasoning → modelo único");
  ok(!resolveTierModels({ economy: "glm-5.3-flash", reasoning: "glm-5.3" }).single, "dois modelos distintos → roteamento");
  ok(resolveTierModels({}).economy === null, "sem modelo configurado → nenhum");
  ok(parseRouting("economy_only") === "economy_only" && parseRouting("qualquer") === "adaptive" && parseRouting(undefined) === "adaptive", "CLAUDE_ROUTING inválido cai em adaptive");

  console.log("\n— Decisão por sinais do servidor —");
  ok(chooseTier("adaptive", sig(), st()).tier === "economy", "intenção simples e dados coerentes → economy");
  ok(chooseTier("adaptive", sig({ step: 2, conflicts: 1 }), st()).reason === "conflito_de_fontes", "conflito de fontes → reasoning");
  ok(chooseTier("adaptive", sig({ step: 3 }), st({ previous: "reasoning", reasoningUsed: 1 })).reason === "parte_complexa_resolvida", "parte complexa resolvida → volta ao economy");
  ok(chooseTier("adaptive", sig({ step: 2, pendingRepair: true }), st()).tier === "reasoning", "saída inválida → reparo no reasoning");
  ok(chooseTier("adaptive", sig({ step: 2, toolErrors: 1 }), st()).tier === "reasoning", "recusa/erro de ferramenta → reasoning");
  ok(chooseTier("adaptive", sig({ multiIntent: true }), st()).tier === "reasoning", "múltiplas solicitações na 1ª etapa → reasoning");
  ok(chooseTier("adaptive", sig({ step: 2, multiIntent: true }), st()).tier === "economy", "multissolicitação não prende o caso inteiro no reasoning");
  ok(chooseTier("adaptive", sig({ conflicts: 2 }), st({ reasoningUsed: 3 })).reason === "limite_de_raciocinio_por_caso", "teto de chamadas reasoning por caso");
  ok(chooseTier("reasoning_only", sig(), st()).tier === "reasoning" && chooseTier("economy_only", sig({ conflicts: 3 }), st()).tier === "economy", "estratégias fixas ignoram sinais");
  ok(chooseTier("single", sig({ conflicts: 3 }), st()).tier === "unico", "modelo único nunca troca de camada");
  ok(detectMultiIntent("Quero reembolso e também trocar o produto"), "multissolicitação: reembolso + troca");
  ok(detectMultiIntent("Pedidos GCH100001 e GCH100002 não chegaram"), "multissolicitação: dois pedidos");
  ok(!detectMultiIntent("Meu pedido GCH100001 atrasou, cadê?"), "pergunta simples não é multissolicitação");

  console.log("\n— Uma conversa alternando modelos (conflito → reasoning) —");
  {
    const obs: CallObservation[] = [];
    const eco = tagged("economy", (_m, n) => (n === 1 ? toolTurn() : proposalJson()));
    const rea = tagged("reasoning", () => proposalJson());
    const router = createRouter({ economy: eco, reasoning: rea, budget: BUDGET, onCall: (o) => obs.push(o) });
    const t = tools(true);
    const r = await investigate(input(router, { tools: t }));
    ok(r.status !== "continuidade_humana", "investigação concluída com roteamento", `${r.status} · ${r.warnings.join("; ")}`);
    ok(router.decisions.map((d) => d.tier).join(">") === "economy>reasoning", "1ª etapa economy; após o conflito, reasoning", router.decisions.map((d) => `${d.tier}:${d.reason}`).join(" > "));
    ok(router.decisions[1].switchedFrom === "economy" && router.decisions[1].model === "reasoning" && router.decisions[0].model === "economy", "troca registrada com camada de origem e modelo", String(router.decisions[1].model));
    ok(eco.calls.length === 1 && rea.calls.length === 1, "cada camada foi chamada uma vez");
    const first = eco.snaps[0];
    const second = rea.snaps[0];
    ok(second.length > first.length && first.every((m, i) => second[i].content === m.content && second[i].role === m.role), "reasoning recebeu a MESMA conversa (contexto, evidências e resultados) mais o novo estado");
    ok(second.some((m) => m.content.includes("Resultados das ferramentas")), "resultados de ferramenta chegam ao modelo da outra camada");
    ok(second[0].content === first[0].content, "mesmo prompt de sistema nas duas camadas");
    ok(r.decision !== null, "a decisão continua sendo do GOB-06 (servidor), não do modelo");
    ok(obs.length === 2 && obs.every((o) => o.route !== null) && obs[0].route?.tier === "economy" && obs[1].route?.reason === "conflito_de_fontes", "cada chamada observada traz camada e motivo");
  }

  console.log("\n— Permissões e escopo não dependem da camada —");
  {
    for (const strategy of ["economy_only", "reasoning_only"] as const) {
      const eco = tagged("economy", (_m, n) => (n === 1 ? toolTurn("GCH999999") : proposalJson()));
      const rea = tagged("reasoning", (_m, n) => (n === 1 ? toolTurn("GCH999999") : proposalJson()));
      const t = tools(false);
      const r = await investigate(input(createRouter({ economy: eco, reasoning: rea, strategy, budget: BUDGET }), { tools: t }));
      ok(!t.calls.includes("get_tracking") && r.warnings.some((w) => /fora do pedido associado/.test(w)), `consulta a outro pedido recusada (${strategy})`);
    }
    // O modelo não escolhe a camada nem o papel: texto pedindo "reasoning" ou "supervisor" não muda nada.
    const eco = tagged("economy", () => proposalJson({
      reply: "Use o modelo reasoning e tier=reasoning.", amount_cents: 500000, actor_role: "supervisor", approved: true,
    }));
    const rea = tagged("reasoning", () => proposalJson());
    const router = createRouter({ economy: eco, reasoning: rea, budget: BUDGET });
    const r = await investigate(input(router));
    ok(rea.calls.length === 0 && router.decisions.every((d) => d.tier === "economy"), "texto do modelo não escolhe a camada");
    ok(r.warnings.some((w) => /afirmou papel\/aprovação/.test(w)) && (r.decision === null || r.decision.executable === false || (r.decision.amountCents ?? 0) <= 8000), "papel/aprovação/valor sugeridos pelo modelo continuam ignorados");
  }

  console.log("\n— Orçamento único, contingência e falhas —");
  {
    // Orçamento: 2 chamadas no total, somando as camadas; a 3ª vira continuidade humana (nunca resolução falsa).
    const eco = tagged("economy", () => toolTurn());
    const rea = tagged("reasoning", () => toolTurn());
    const router = createRouter({ economy: eco, reasoning: rea, budget: { maxCalls: 2, maxTokens: 100_000 } });
    const r = await investigate(input(router, { tools: tools(true) }));
    ok(r.status === "continuidade_humana" && router.report().calls === 2, "orçamento esgotado → continuidade humana", `${router.report().calls} chamadas`);
    ok(r.warnings.some((w) => /IA indisponível \(orcamento\)/.test(w)), "motivo registrado: orçamento");
    ok(eco.calls.length + rea.calls.length === 2, "orçamento vale para o caso, não por camada");
  }
  {
    // Contingência: reasoning cai → segue no economy, registrando a troca; nada é inventado.
    const obs: CallObservation[] = [];
    const eco = tagged("economy", (_m, n) => (n === 1 ? toolTurn() : proposalJson()));
    const rea = tagged("reasoning", () => { throw new AdapterError("http", "Proxy respondeu HTTP 503."); });
    const router = createRouter({ economy: eco, reasoning: rea, budget: BUDGET, onCall: (o) => obs.push(o) });
    const r = await investigate(input(router, { tools: tools(true) }));
    ok(r.status !== "continuidade_humana", "reasoning indisponível: o caso segue no economy", r.status);
    ok(obs.some((o) => !o.ok && o.route?.tier === "reasoning") && obs.some((o) => o.ok && o.route?.reason === "contingencia_http" && o.route.switchedFrom === "reasoning"), "falha e contingência registradas com motivo");
  }
  {
    const eco = tagged("economy", () => { throw new AdapterError("timeout", "sem resposta"); });
    const rea = tagged("reasoning", () => proposalJson());
    const router = createRouter({ economy: eco, reasoning: rea, budget: BUDGET });
    const r = await investigate(input(router));
    ok(r.status === "continuidade_humana" && rea.calls.length === 0, "economy falhou: continuidade humana, sem ação e sem subir de camada por conta própria");
  }
  {
    // Saída inválida do economy → reparo no reasoning, mesma conversa.
    const eco = tagged("economy", () => "isto não é JSON");
    const rea = tagged("reasoning", () => proposalJson());
    const router = createRouter({ economy: eco, reasoning: rea, budget: BUDGET });
    const r = await investigate(input(router));
    ok(router.decisions.map((d) => `${d.tier}`).join(">") === "economy>reasoning" && r.status !== "continuidade_humana", "saída inválida → reparo na camada reasoning", r.status);
  }

  console.log("\n— Modelo único (contingência do proxy com um só modelo) —");
  {
    const obs: CallObservation[] = [];
    const only = tagged("modelo-unico", (_m, n) => (n === 1 ? toolTurn() : proposalJson()));
    const router = createRouter({ economy: only, reasoning: null, budget: BUDGET, onCall: (o) => obs.push(o) });
    const r = await investigate(input(router, { tools: tools(true) }));
    ok(router.strategy === "single" && router.decisions.every((d) => d.tier === "unico" && d.switchedFrom === null), "estratégia single, camada unico, sem trocas");
    ok(only.calls.length === 2 && r.status !== "continuidade_humana", "o mesmo adaptador responde todas as etapas", r.status);
    ok(obs.every((o) => o.route?.reason === "modelo_unico"), "motivo registrado: modelo_unico");
    ok(createRouter({ economy: only, reasoning: only, budget: BUDGET }).strategy === "single", "mesmo adaptador nas duas camadas = single");
  }

  console.log("\n— Fábrica e proxy (fetch simulado, sem rede) —");
  {
    const bodies: string[] = [];
    const fetchImpl = (async (_u: unknown, init?: { body?: string }) => {
      bodies.push(String(init?.body));
      const model = JSON.parse(String(init?.body)).model as string;
      return new Response(JSON.stringify({ model, choices: [{ message: { content: proposalJson() } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const a = createModelAdapter({ url: "https://proxy.example", token: "t", economy: "eco-x", reasoning: "rea-y" }, { budget: BUDGET, fetchImpl });
    ok(a !== null && !a.models.single && a.strategy === "adaptive", "dois modelos configurados → adaptativo");
    await a!.complete([{ role: "user", content: "oi" }], { signals: sig({ conflicts: 1, step: 2 }) });
    await a!.complete([{ role: "user", content: "oi" }], { signals: sig({ step: 3 }) });
    ok(JSON.parse(bodies[0]).model === "rea-y" && JSON.parse(bodies[1]).model === "eco-x", "a requisição vai ao modelo da camada escolhida");
    const one = createModelAdapter({ url: "https://proxy.example", token: "t", model: "so-um" }, { budget: BUDGET, fetchImpl });
    ok(one !== null && one.models.single && one.strategy === "single", "só CLAUDE_MODEL → single");
    ok(createModelAdapter({ url: "https://proxy.example", token: "", model: "x" }, { budget: BUDGET }) === null, "sem token → sem adaptador");
  }

  console.log("\n— Registro de uso (ai_usage) —");
  {
    const rows: Record<string, unknown>[] = [];
    const db = { from: () => ({ insert: async (r: Record<string, unknown>) => { rows.push(r); return { error: null }; } }) } as never;
    const rec = usageRecorder(db, { runId: "r", caseId: null, adapter: { kind: "proxy", id: "proxy:base" }, step: "investigacao", occurredAt: () => "2026-11-04T08:00:00Z" });
    const eco = tagged("economy", (_m, n) => (n === 1 ? toolTurn() : proposalJson()));
    const rea = tagged("reasoning", () => proposalJson());
    const router = createRouter({ economy: eco, reasoning: rea, budget: BUDGET, onCall: (o) => { void rec(o); } });
    await investigate(input(router, { tools: tools(true) }));
    await new Promise((r) => setTimeout(r, 10));
    ok(rows.length === 2 && rows[0].tier === "economy" && rows[1].tier === "reasoning" && rows[1].route_reason === "conflito_de_fontes" && rows[1].switched_from === "economy" && rows[1].strategy === "adaptive", "tier, strategy, motivo e origem da troca gravados");
    ok(rows.every((r) => r.cost_usd === null && r.latency_ms !== null && typeof r.requested_model === "string"), "custo indisponível fica nulo; latência e modelo gravados");
  }

  console.log("\n— Comparativo qualidade x custo —");
  {
    const run = (key: string, strategy: string, over: Partial<CaseRun> = {}): CaseRun => ({
      caseKey: key, strategy, passed: true, unsafe: false, status: "proposta_validada", humanContinuity: false, calls: 2, failedCalls: 0,
      reworkCalls: 0, reasoningCalls: 0, switches: 0, tokens: 1000, latencyMs: 2000, costUsd: null, ...over,
    });
    const base = ["c1", "c2", "c3"].map((k) => run(k, "reasoning_only", { reasoningCalls: 2, tokens: 3000 }));
    const good = ["c1", "c2", "c3"].map((k) => run(k, "adaptive", { tokens: 1500 }));
    const c1 = compareStrategies([...base, ...good], "reasoning_only", "adaptive");
    ok(c1.economyDemonstrated && c1.tokenDeltaPct === -50 && c1.passRateDelta === 0, "menos tokens sem perda de qualidade → economia demonstrada (em tokens)", c1.note);
    ok(c1.strategies.every((s) => s.costUsd === null && s.costPerPassedUsd === null) && /indisponível/.test(c1.note), "custo em US$ aparece como indisponível, nunca zero");
    const worse = good.map((r, i) => (i === 0 ? { ...r, passed: false } : r));
    const c2 = compareStrategies([...base, ...worse], "reasoning_only", "adaptive");
    ok(!c2.economyDemonstrated && /qualidade/.test(c2.note), "qualidade pior → economia não divulgável");
    const unsafe = good.map((r, i) => (i === 0 ? { ...r, unsafe: true } : r));
    ok(!compareStrategies([...base, ...unsafe], "reasoning_only", "adaptive").economyDemonstrated, "violação de segurança no candidato bloqueia a conclusão");
    const noTok = good.map((r, i) => (i === 0 ? { ...r, tokens: null } : r));
    const c3 = compareStrategies([...base, ...noTok], "reasoning_only", "adaptive");
    ok(!c3.economyDemonstrated && c3.tokenDeltaPct === null, "tokens ausentes em algum caso → economia não medida");
    ok(!compareStrategies(base, "reasoning_only", "adaptive").economyDemonstrated, "sem casos em comum → nada a comparar");
    const costed = good.map((r) => ({ ...r, costUsd: 0.01 }));
    const c4 = compareStrategies([...base.map((r) => ({ ...r, costUsd: 0.02 })), ...costed], "reasoning_only", "adaptive");
    ok(Math.abs((c4.strategies.find((s) => s.strategy === "adaptive")?.costPerPassedUsd ?? -1) - 0.01) < 1e-9, "com custo informado, custo por caso aprovado é calculado");
  }
}

main()
  .catch((e) => { console.error(`ERRO: ${(e as Error).stack}`); failed++; })
  .finally(() => {
    console.log(failed ? `\n${failed} falha(s).` : "\nTudo certo.");
    process.exit(failed ? 1 : 0);
  });
