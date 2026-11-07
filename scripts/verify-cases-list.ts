// Todos os casos: verificação de filtros, abas por prioridade e ordenação. Sem banco. Uso: node scripts/verify-cases-list.ts
import type { QueueItem } from "../src/server/cases.ts";
import { activeFilterCount, countPrio, filterCases, parseOrder, parsePrio, sortCases } from "../src/server/case-list-model.ts";
import type { SupervisionRow } from "../src/server/supervision-model.ts";

let failed = 0;
const ok = (cond: boolean, name: string, extra = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "OK  " : "FALHA"} ${name}${extra ? ` — ${extra}` : ""}`);
};

const row = (id: string, level: "alta" | "media" | "baixa", score: number, over: Partial<SupervisionRow> = {}): SupervisionRow => ({
  id, status: "aguardando_humano", topic: "rastreio_atraso", summary: "Pedido atrasado", clarification: null, orderId: `G${id}`, customerId: `C${id}`,
  brandId: "gocase", openedAt: "2026-11-02T11:00:00Z", channels: ["whatsapp"], conversations: 1, updatedAt: "2026-11-02T11:00:00Z",
  assignedTo: null, assigneeName: null, handoffReason: null, handoffTeam: null, decisionRequested: null, proposal: null,
  priority: { level, score, reasons: ["x"] } as QueueItem["priority"],
  customerName: `Cliente ${id}`, itemLabel: "Caneca", amountCents: 1000, waitMs: 60_000, brandName: "Gocase", unitName: "Gocase", ...over,
});

const rows = [
  row("a", "media", 30, { waitMs: 10 * 60_000 }),
  row("b", "alta", 90, { waitMs: 5 * 60_000, channels: ["reclame_aqui"], brandId: "eudora", brandName: "Eudora", customerName: "José Álvares" }),
  row("c", "baixa", 5, { waitMs: 3 * 3600_000, assignedTo: "s1", status: "aguardando_cliente" }),
  row("d", "alta", 90, { waitMs: 20 * 60_000, handoffReason: "execucao_falhou" }),
];

ok(sortCases(rows, "prioridade").map((r) => r.id).join() === "d,b,a,c", "prioridade: maior pontuação primeiro, empate pela maior espera");
ok(sortCases(rows, "espera").map((r) => r.id).join() === "c,d,a,b", "espera: maior espera primeiro");
ok(rows.map((r) => r.id).join() === "a,b,c,d", "ordenar não altera a lista original");
ok(JSON.stringify(countPrio(rows)) === '{"todas":4,"alta":2,"media":1,"baixa":1}', "contagem por prioridade");
ok(filterCases(rows, { prio: "alta" }, "s9").map((r) => r.id).join() === "b,d", "aba Alta");
ok(filterCases(rows, { canal: "reclame_aqui" }, "s9").length === 1, "filtro por canal de origem");
ok(filterCases(rows, { empresa: "eudora" }, "s9")[0]!.id === "b", "filtro por empresa (marca)");
ok(filterCases(rows, { responsavel: "eu" }, "s1")[0]!.id === "c" && filterCases(rows, { responsavel: "sem" }, "s1").length === 3, "responsável: eu e sem responsável");
ok(filterCases(rows, { situacao: "aguardando_cliente" }, "s9").length === 1, "filtro por situação");
ok(filterCases(rows, { motivo: "execucao_falhou" }, "s9")[0]!.id === "d", "filtro por motivo");
ok(filterCases(rows, { q: "alvares" }, "s9")[0]!.id === "b", "busca ignora acento e caixa");
ok(filterCases(rows, { q: "eudora" }, "s9")[0]!.id === "b", "busca encontra a marca");
ok(filterCases(rows, { q: "inexistente" }, "s9").length === 0, "busca sem resultado");
ok(activeFilterCount({ canal: "email", q: "x", prio: "alta" }) === 1, "contador do botão Filtros ignora aba e busca");
ok(parsePrio("lixo") === "todas" && parsePrio("alta") === "alta" && parseOrder("espera") === "espera" && parseOrder("x") === "prioridade", "parâmetros inválidos caem no padrão");

console.log(failed ? `\n${failed} falha(s).` : "\nTudo certo.");
process.exit(failed ? 1 : 0);
