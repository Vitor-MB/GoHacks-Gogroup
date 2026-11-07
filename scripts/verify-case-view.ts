// Detalhe do caso: verificação das regras puras de apresentação. Sem banco. Uso: node scripts/verify-case-view.ts
import { gobiaBubbles, internalNote, leadProposal, messageBubbles, outboxText, processNumber } from "../src/server/case-view.ts";

let failed = 0;
const ok = (c: boolean, n: string) => { if (!c) failed++; console.log(`${c ? "OK  " : "FALHA"} ${n}`); };

ok(processNumber("3f2a9c10-1111-4222-8333-444455556666") === "3F2A9C10", "número do processo: 8 primeiros caracteres, maiúsculas");
const m = messageBubbles([
  { id: "2", author: "bot", sentAt: "2026-11-02T11:05:00Z", body: "Olá!" },
  { id: "1", author: "cliente", sentAt: "2026-11-02T11:00:00Z", body: "Meu pedido atrasou" },
  { id: "3", author: "agente", sentAt: "2026-11-02T11:10:00Z", body: null },
], "Rafael");
ok(m.map((b) => b.key).join() === "1,2,3", "mensagens em ordem de horário");
ok(m[0]!.side === "cliente" && m[0]!.author === "Rafael" && m[1]!.side === "equipe" && m[1]!.author === "Resposta automática" && m[2]!.author === "Atendente", "lados e autores");
ok(m[2]!.text === "(sem texto)", "mensagem vazia não quebra");
ok(outboxText({ text: " Olá " }) === "Olá" && outboxText({ message: "Oi" }) === "Oi" && outboxText({}) === null && outboxText(null) === null, "texto do aviso (text ou message)");
const g = gobiaBubbles([{ id: "a", status: "enviada", payload: { text: "Pronto" } }, { id: "b", status: "pendente", payload: { message: "Recebido" } }, { id: "c", status: "falhou", payload: { error: "x" } }]);
ok(g.length === 2 && g[0]!.delivery === "enviada" && g[1]!.delivery === "pendente" && g.every((b) => b.at === null), "avisos da GoBIA sem horário inventado; sem texto são ignorados");
ok(internalNote(null) === null && internalNote({ origin: null, justification: [] }) === null, "nota interna vazia vira nulo");
ok(/hipótese, não confirmada/.test(internalNote({ origin: { hypothesis: "Atraso na transportadora" }, justification: ["Política v1"] })!), "origem sem confirmação é marcada como hipótese");
ok(/confirmada/.test(internalNote({ origin: { status: "confirmada", summary: "X" }, justification: [] })!) && !/hipótese/.test(internalNote({ origin: { status: "confirmada", summary: "X" }, justification: [] })!), "origem confirmada");
ok(leadProposal([{ status: "concluida" }, { status: "aguardando_aprovacao" }, { status: "rejeitada" }])!.status === "aguardando_aprovacao", "proposta líder: a pendente");
ok(leadProposal([{ status: "concluida" }, { status: "rejeitada" }])!.status === "rejeitada" && leadProposal([]) === null, "sem pendente: a mais recente; sem proposta: nulo");

console.log(failed ? `\n${failed} falha(s).` : "\nTudo certo.");
process.exit(failed ? 1 : 0);
