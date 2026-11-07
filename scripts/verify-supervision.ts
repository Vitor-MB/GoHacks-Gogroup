// Fila de supervisão: verificação das regras puras (classificação, motivo, espera, filtros e busca). Sem banco.
// Uso: node scripts/verify-supervision.ts
import type { QueueItem } from "../src/server/cases.ts";
import {
  countTabs, filterRows, needsHuman, parseTab, reasonLines, requiresSupervisor, waitLabel, waitTone, type SupervisionRow,
} from "../src/server/supervision-model.ts";

let failed = 0;
const ok = (cond: boolean, name: string, extra = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "OK  " : "FALHA"} ${name}${extra ? ` — ${extra}` : ""}`);
};

const item = (over: Partial<QueueItem> = {}): QueueItem => ({
  id: "c1", status: "aguardando_humano", topic: "rastreio_atraso", summary: "Pedido atrasado", clarification: null, orderId: "GCH1", customerId: "CH1",
  brandId: "gocase", openedAt: "2026-11-02T11:00:00Z", channels: ["whatsapp"], conversations: 1, updatedAt: "2026-11-02T11:00:00Z",
  assignedTo: null, assigneeName: null, handoffReason: null, handoffTeam: null, decisionRequested: null, proposal: null,
  priority: { level: "media", score: 1, reasons: [] } as unknown as QueueItem["priority"], ...over,
});
const prop = (status: string, overdue = false) => ({ id: "p", action: "reembolsar", amountCents: 15000, status, version: 1, approvalDueAt: null, escalationLevel: 0, overdue });
const row = (over: Partial<SupervisionRow> = {}): SupervisionRow => ({ ...item(), customerName: "Carla Mendes", itemLabel: "Geladeira Frost Free", amountCents: 348900, waitMs: 4 * 60_000, brandName: null, unitName: null, ...over });

ok(needsHuman(item()), "caso aguardando pessoa entra na fila");
ok(needsHuman(item({ status: "novo", proposal: prop("aguardando_aprovacao") })), "proposta aguardando aprovação entra na fila");
ok(!needsHuman(item({ status: "novo", proposal: prop("em_janela_revisao") })), "ação já autorizada em janela de revisão não entra");
ok(!needsHuman(item({ status: "em_investigacao" })), "caso que a GoBIA ainda investiga não entra");

ok(requiresSupervisor(item({ proposal: prop("aguardando_aprovacao") })), "aprovação acima da alçada exige supervisor");
ok(requiresSupervisor(item({ handoffTeam: "supervisor" })), "encaminhamento ao supervisor exige supervisor");
ok(!requiresSupervisor(item({ handoffReason: "ia_indisponivel", handoffTeam: "atendimento" })), "IA indisponível pode ser resolvido pelo atendimento");

ok(reasonLines(item({ proposal: prop("aguardando_aprovacao") }))[0] === "Valor acima da alçada", "motivo: acima da alçada");
ok(reasonLines(item({ proposal: prop("aguardando_aprovacao", true) }))[0] === "Aprovação com prazo vencido", "motivo: prazo vencido");
ok(reasonLines(item({ handoffReason: "ia_indisponivel" }))[0] === "IA indisponível", "motivo: IA indisponível");
ok(reasonLines(item({ handoffReason: "orientacao_e_encaminhamento", topic: "reacao_adversa" }))[0] === "Reação adversa", "motivo: reação adversa");
ok(reasonLines(item({ handoffReason: "continuidade_humana", channels: ["reclame_aqui"] })).join("|") === "Continuidade humana|Reclamação pública", "reclamação pública vira segundo motivo");
ok(reasonLines(item())[0] === "Aguardando uma pessoa", "sem motivo registrado: texto neutro, nada inventado");

ok(waitLabel(20_000) === "menos de 1 min" && waitLabel(4 * 60_000) === "4 min" && waitLabel(66 * 60_000) === "1 h 06" && waitLabel(125 * 60_000) === "2 h 05", "formato da espera");
ok(waitTone(10 * 60_000) === "calm" && waitTone(41 * 60_000) === "warn" && waitTone(2 * 3600_000) === "hot", "cor da espera");

const rows = [
  row({ id: "a", proposal: prop("aguardando_aprovacao") }),
  row({ id: "b", customerName: "Diego Alves", customerId: "CH2", orderId: "GCH2", channels: ["email"], handoffTeam: "atendimento", itemLabel: "Fone Pulse BT" }),
  row({ id: "c", customerName: "José Andrade", customerId: "CH3", orderId: "GCH3", channels: ["reclame_aqui"], handoffTeam: "atendimento", summary: "Cobrança duplicada" }),
];
const counts = countTabs(rows);
ok(counts.todos === 3 && counts.supervisor === 1 && counts.agente === 2, "contagem das abas", JSON.stringify(counts));
ok(filterRows(rows, { tab: "supervisor" }).map((r) => r.id).join() === "a", "aba: exigem supervisor");
ok(filterRows(rows, { tab: "agente" }).map((r) => r.id).join() === "b,c", "aba: atendimento pode resolver");
ok(filterRows(rows, { canal: "email" }).map((r) => r.id).join() === "b", "filtro de canal");
ok(filterRows(rows, { q: "diego" }).map((r) => r.id).join() === "b", "busca por cliente");
ok(filterRows(rows, { q: "jose" }).map((r) => r.id).join() === "c", "busca ignora acentos");
ok(filterRows(rows, { q: "GCH3" }).map((r) => r.id).join() === "c", "busca por pedido");
ok(filterRows(rows, { q: "duplicada" }).map((r) => r.id).join() === "c", "busca por resumo");
ok(filterRows(rows, { q: "zzz" }).length === 0, "busca sem resultado");
ok(parseTab("supervisor") === "supervisor" && parseTab("x") === "todos" && parseTab(undefined) === "todos", "aba inválida cai em 'todos'");

console.log(failed ? `\n${failed} falha(s).` : "\nTudo certo.");
process.exit(failed ? 1 : 0);
