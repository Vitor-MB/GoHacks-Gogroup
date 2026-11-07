// GOB-13 · Comparativo entre estratégias de modelo nos MESMOS casos revisados. Cálculo puro, sem banco e sem modelo.
// Regras: custo só é somado quando o proxy o informou; sem preço, o comparável é "tokens" e o custo aparece como
// indisponível (nunca zero). Economia só é considerada demonstrada se a qualidade não caiu e se há tokens medidos.

export interface CaseRun {
  caseKey: string;
  strategy: string;
  /** Resultado conferido contra o esperado do caso revisado (status/ação/segurança). */
  passed: boolean;
  /** Violação de segurança (ação indevida, afirmação de execução, dado pessoal vazado, alçada ultrapassada). */
  unsafe: boolean;
  status: string;
  humanContinuity: boolean;
  calls: number;
  failedCalls: number;
  /** Retrabalho: chamadas extras por saída inválida, falha de provedor ou contingência. */
  reworkCalls: number;
  reasoningCalls: number;
  switches: number;
  tokens: number | null;
  latencyMs: number;
  costUsd: number | null;
}

export interface StrategySummary {
  strategy: string;
  cases: number;
  passed: number;
  passRate: number | null;
  unsafe: number;
  humanContinuity: number;
  calls: number;
  failedCalls: number;
  reworkCalls: number;
  reasoningCalls: number;
  switches: number;
  tokens: number | null;          // soma; nulo se algum caso não teve contagem
  tokensPerPassed: number | null; // tokens por caso que passou na revisão
  meanLatencyMs: number | null;
  costUsd: number | null;         // nulo = indisponível
  costPerPassedUsd: number | null;
}

export interface Comparison {
  strategies: StrategySummary[];
  baseline: string | null;
  candidate: string | null;
  tokenDeltaPct: number | null;     // candidato vs. base; negativo = menos tokens
  passRateDelta: number | null;     // candidato − base, em pontos percentuais
  economyDemonstrated: boolean;
  note: string;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function summarizeStrategy(strategy: string, rows: CaseRun[]): StrategySummary {
  const own = rows.filter((r) => r.strategy === strategy);
  const passed = own.filter((r) => r.passed && !r.unsafe).length;
  const tokensKnown = own.length > 0 && own.every((r) => r.tokens !== null);
  const costKnown = own.length > 0 && own.every((r) => r.costUsd !== null);
  const tokens = tokensKnown ? sum(own.map((r) => r.tokens as number)) : null;
  const cost = costKnown ? sum(own.map((r) => r.costUsd as number)) : null;
  return {
    strategy, cases: own.length, passed,
    passRate: own.length ? passed / own.length : null,
    unsafe: own.filter((r) => r.unsafe).length,
    humanContinuity: own.filter((r) => r.humanContinuity).length,
    calls: sum(own.map((r) => r.calls)), failedCalls: sum(own.map((r) => r.failedCalls)),
    reworkCalls: sum(own.map((r) => r.reworkCalls)), reasoningCalls: sum(own.map((r) => r.reasoningCalls)),
    switches: sum(own.map((r) => r.switches)),
    tokens, tokensPerPassed: tokens !== null && passed > 0 ? tokens / passed : null,
    meanLatencyMs: own.length ? sum(own.map((r) => r.latencyMs)) / own.length : null,
    costUsd: cost, costPerPassedUsd: cost !== null && passed > 0 ? cost / passed : null,
  };
}

/** Compara o candidato (ex.: adaptive) com a base (ex.: reasoning_only) usando apenas os casos presentes nas duas. */
export function compareStrategies(rows: CaseRun[], baseline: string, candidate: string): Comparison {
  const keysOf = (s: string) => new Set(rows.filter((r) => r.strategy === s).map((r) => r.caseKey));
  const common = [...keysOf(baseline)].filter((k) => keysOf(candidate).has(k));
  const paired = rows.filter((r) => common.includes(r.caseKey));
  const names = [...new Set(rows.map((r) => r.strategy))];
  const strategies = names.map((n) => summarizeStrategy(n, paired));
  const b = strategies.find((s) => s.strategy === baseline) ?? null;
  const c = strategies.find((s) => s.strategy === candidate) ?? null;
  const tokenDeltaPct = b && c && b.tokens !== null && c.tokens !== null && b.tokens > 0 ? ((c.tokens - b.tokens) / b.tokens) * 100 : null;
  const passRateDelta = b && c && b.passRate !== null && c.passRate !== null ? (c.passRate - b.passRate) * 100 : null;

  let note: string;
  let economy = false;
  if (!b || !c || common.length === 0) note = "Sem casos em comum entre as estratégias: nada a comparar.";
  else if (tokenDeltaPct === null) note = "Tokens indisponíveis em algum caso: economia não pode ser medida.";
  else if (passRateDelta === null || passRateDelta < 0 || c.unsafe > b.unsafe) note = "A qualidade ou a segurança piorou com o roteamento: economia não é divulgável.";
  else if (tokenDeltaPct >= 0) note = "Sem redução de tokens nos casos comparados: economia não demonstrada.";
  else {
    economy = true;
    note = `Redução observada de ${Math.abs(tokenDeltaPct).toFixed(1)}% em tokens, sem perda de qualidade, em ${common.length} caso(s). `
      + `Custo em US$ ${c.costUsd === null ? "indisponível (o proxy não informa preço por chamada)" : "medido"}; amostra pequena, sem inferência estatística.`;
  }
  return { strategies, baseline, candidate, tokenDeltaPct, passRateDelta, economyDemonstrated: economy, note };
}
