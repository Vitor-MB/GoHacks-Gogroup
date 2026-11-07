// Atendimentos resolvidos: verificação de filtros, abas, período e médias. Sem banco. Uso: node scripts/verify-resolved.ts
import { countTabs, filterResolved, isLow, parsePeriod, parseRTab, scoreSummary, type ResolvedRow } from "../src/server/resolved-model.ts";

let failed = 0;
const ok = (c: boolean, n: string) => { if (!c) failed++; console.log(`${c ? "OK  " : "FALHA"} ${n}`); };
const NOW = Date.parse("2026-11-07T12:00:00Z");
const d = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();
const row = (id: string, over: Partial<ResolvedRow> = {}): ResolvedRow => ({
  id, customerName: `Cliente ${id}`, customerId: `C${id}`, orderId: `G${id}`, channels: ["whatsapp"], topic: "rastreio_atraso", summary: "Atraso resolvido",
  itemLabel: "Caneca", amountCents: 1000, mode: "autonoma", resolverName: null, closedAt: d(1), durationMs: 60_000, score: 5, surveyStatus: "respondida", reopened: false, ...over,
});
const rows = [
  row("a"),
  row("b", { mode: "assistida", resolverName: "Marina", score: 3, channels: ["email"], customerName: "José Álvares" }),
  row("c", { closedAt: d(20), score: null, surveyStatus: "aguardando" }),
  row("d", { closedAt: d(100), score: 1 }),
];

ok(filterResolved(rows, { period: "7" }, NOW).map((r) => r.id).join() === "a,b", "período de 7 dias usa o relógio do cenário");
ok(filterResolved(rows, { period: "30" }, NOW).length === 3 && filterResolved(rows, { period: "90" }, NOW).length === 3 && filterResolved(rows, { period: "todos" }, NOW).length === 4, "períodos 30, 90 e todo o período");
ok(filterResolved(rows, { period: "todos", tab: "gobia" }, NOW).length === 3 && filterResolved(rows, { period: "todos", tab: "pessoa" }, NOW).length === 1, "abas: pela GoBIA e com pessoa");
ok(filterResolved(rows, { period: "todos", tab: "baixa" }, NOW).map((r) => r.id).join() === "b,d", "nota baixa = 3 ou menos; sem resposta não é nota baixa");
ok(filterResolved(rows, { period: "todos", canal: "email" }, NOW)[0]!.id === "b", "filtro por canal");
ok(filterResolved(rows, { period: "todos", q: "alvares" }, NOW)[0]!.id === "b", "busca ignora acento e caixa");
ok(JSON.stringify(countTabs(filterResolved(rows, { period: "todos" }, NOW))) === '{"todos":4,"gobia":3,"pessoa":1,"baixa":2}', "contagem das abas");
const s = scoreSummary(rows);
ok(s.answered === 3 && s.total === 4 && Math.abs(s.mean! - 3) < 1e-9, "média só das respondidas, com denominador");
ok(scoreSummary([row("x", { score: null })]).mean === null && !isLow(row("y", { score: null })), "sem resposta: sem média e sem nota baixa");
ok(parsePeriod("x") === "7" && parsePeriod("90") === "90" && parseRTab("baixa") === "baixa" && parseRTab("x") === "todos", "parâmetros inválidos caem no padrão");

console.log(failed ? `\n${failed} falha(s).` : "\nTudo certo.");
process.exit(failed ? 1 : 0);
