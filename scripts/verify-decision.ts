// GOB-06 · Verificação das regras puras de calendário e decisão, lendo a política direto de BD/politicas.csv.
// Uso: node scripts/verify-decision.ts   (sem banco, sem rede)
import { readCsv } from "./lib/csv.ts";
import {
  addBusinessDays, businessDaysBetween, isBusinessDay, promisedDate,
} from "../src/server/policy/calendar.ts";
import {
  decide, paramsFromPolicy, type ApprovalRecord, type DecisionInput, type VerifiedFacts,
} from "../src/server/policy/decision.ts";

let failed = 0;
const ok = (cond: boolean, name: string, extra = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "OK  " : "FALHA"} ${name}${extra ? ` — ${extra}` : ""}`);
};

const rows = readCsv("BD/politicas.csv").map((r) => ({ secao: r.secao, regra: r.regra, valor: r.valor }));
const params = paramsFromPolicy(rows);
const H = params.holidays;

// --- Parâmetros vindos da política ---------------------------------------------------------------------------
ok(params.refundMaxCents === 10000 && params.resendMaxCents === 20000 && params.exchangeMaxCents === 20000, "limites lidos da política", `100/200/200`);
ok(params.delayResendAfterBusinessDays === 7, "limite de atraso = 7 dias úteis");

// --- Calendário -----------------------------------------------------------------------------------------------
ok(!isBusinessDay("2026-11-02", H), "02/11/2026 (segunda, feriado) não é dia útil");
ok(!isBusinessDay("2026-11-07", H) && !isBusinessDay("2026-11-08", H), "sábado e domingo não são dias úteis");
ok(isBusinessDay("2026-11-03", H), "03/11/2026 é dia útil");
ok(addBusinessDays("2026-10-30", 1, H) === "2026-11-03", "sexta 30/10 + 1 dia útil = terça 03/11 (pula fim de semana e feriado 02/11)");
ok(businessDaysBetween("2026-10-30", "2026-11-03", H) === 1, "contagem (30/10, 03/11] = 1 dia útil");
ok(businessDaysBetween("2026-11-13", "2026-11-17", H) === 2, "feriado 15/11 cai no domingo: 13→17 = 2 dias úteis");
ok(businessDaysBetween("2026-11-18", "2026-11-23", H) === 2, "feriado 20/11 (sexta): 18→23 = 2 dias úteis (19 e 23)");
ok(businessDaysBetween("2026-11-05", "2026-11-05", H) === 0 && businessDaysBetween("2026-11-06", "2026-11-05", H) === 0, "intervalo vazio ou invertido = 0");

// Prazo prometido da política contra a base de pedidos.
const orders = readCsv("BD/pedidos.csv");
const prep = (o: Record<string, string>) => (o.marca === "Gocase" && o.personalizacao ? 3 : 1);
const sla: Record<string, number> = {};
for (const r of rows) {
  const m = /^sla_transportadora_dias_uteis\.(.+)\.(SE|S|CO|NE|N)$/.exec(r.regra);
  if (m) sla[`${m[1]}|${m[2]}`] = Number(r.valor);
}
const region: Record<string, string> = {};
for (const r of rows) { const m = /^regiao_por_uf\.(\w+)$/.exec(r.regra); if (m) region[m[1]] = r.valor; }
let match = 0, total = 0;
const bad: string[] = [];
for (const o of orders) {
  const s = sla[`${o.transportadora}|${region[o.uf]}`];
  if (!s || !o.data_prometida) continue;
  total++;
  if (promisedDate(o.data_pedido, prep(o), s, H) === o.data_prometida) match++;
  else if (bad.length < 3) bad.push(`${o.order_id}`);
}
ok(total > 0 && match / total >= 0.99, "prazo prometido recalculado confere com a base", `${match}/${total}${bad.length ? ` · divergentes: ${bad.join(", ")}` : ""}`);

// --- Decisão: limiares ---------------------------------------------------------------------------------------
const baseFacts: VerifiedFacts = {
  orderId: "GBH000001", orderValueCents: 50000, separatedOn: "2026-10-20", deliveredOn: null,
  promisedOn: "2026-10-23", lastEventOn: "2026-10-22", lastEventStatus: "em_transito", lostConfirmed: false,
  identityConflicts: [], duplicate: null, suspicionPending: false, customerPreference: "reembolso", hasPhoto: false,
};
const att = { id: "STF-A", role: "atendente" as const };
const sup2 = "STF-S2";
const approval = (over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  status: "aprovada", approverId: sup2, approverRole: "supervisor", orderId: "GBH000001", action: "reembolsar", amountCents: 0, ...over,
});
// Hoje 2026-11-05: 24,26,27,28,29,30,03,04,05 menos o feriado 02/11 → 8 dias úteis desde 23/10 (acima do limite de 7).
const lateAsOf = "2026-11-05";
const mk = (over: Partial<Omit<DecisionInput, "facts">> & { facts?: Partial<VerifiedFacts> }): DecisionInput => ({
  asOf: lateAsOf, category: "atraso_entrega", action: "reembolsar", requestedCents: null,
  actor: att, approval: null, params, ...over, facts: { ...baseFacts, ...over.facts },
});

const refund = (c: number, a: ApprovalRecord | null = null) =>
  decide(mk({ requestedCents: c, facts: { orderValueCents: 30000 }, approval: a }));

let d = refund(10000);
ok(d.eligible && !d.approvalRequired && d.executable, "reembolso R$ 100,00 exato: dentro da alçada, executável");
d = refund(10001);
ok(d.approvalRequired && !d.executable && d.blockers.some((b) => b.includes("aprovação")), "reembolso R$ 100,01: exige supervisor e fica bloqueado sem aprovação");
d = refund(10001, approval({ amountCents: 10001 }));
ok(d.approvalValid && d.executable, "R$ 100,01 com aprovação válida: executável");

const resend = (c: number, a: ApprovalRecord | null = null) =>
  decide(mk({ action: "reenviar_produto", requestedCents: c, facts: { orderValueCents: 30000, customerPreference: "reenvio" }, approval: a }));
d = resend(20000);
ok(d.eligible && !d.approvalRequired && d.executable, "reenvio R$ 200,00 exato: dentro da alçada");
d = resend(20001);
ok(d.approvalRequired && !d.executable, "reenvio R$ 200,01: exige supervisor");
d = resend(20001, approval({ action: "reenviar_produto", amountCents: 20001 }));
ok(d.executable, "reenvio R$ 200,01 com aprovação válida");

for (const [action, cat] of [["reimprimir_personalizacao", "erro_personalizacao"], ["trocar_produto", "troca_fragrancia"]] as const) {
  const f = { orderValueCents: 30000, deliveredOn: "2026-11-02", hasPhoto: true };
  const at = decide(mk({ category: cat, action, requestedCents: 20000, facts: f }));
  const above = decide(mk({ category: cat, action, requestedCents: 20001, facts: f }));
  ok(!at.approvalRequired && above.approvalRequired, `${action}: R$ 200,00 sem aprovação; R$ 200,01 exige`);
  ok(at.mode === "orientacao" && !at.executable && !!at.handoff, `${action}: fora da execução P0 devolve orientação e encaminhamento`);
}

// --- Aprovação: vínculo, papel e prazo -------------------------------------------------------------------------
const over = (a: ApprovalRecord | null, actor: DecisionInput["actor"] = att) =>
  decide(mk({ requestedCents: 15000, facts: { orderValueCents: 30000 }, approval: a, actor }));
ok(!over(approval({ amountCents: 15001 })).executable, "aprovação de outro valor não vale (mudança material)");
ok(!over(approval({ amountCents: 15000, orderId: "GBH999999" })).executable, "aprovação de outro pedido não vale");
ok(!over(approval({ amountCents: 15000, action: "reenviar_produto" })).executable, "aprovação de outra ação não vale");
ok(!over(approval({ amountCents: 15000, status: "expirada" })).executable, "aprovação expirada nunca aprova");
ok(!over(approval({ amountCents: 15000, status: "pendente" })).executable, "aprovação pendente não libera");
ok(!over(approval({ amountCents: 15000, approverRole: "atendente" })).executable, "aprovador que não é supervisor não vale");
ok(!over(approval({ amountCents: 15000, approverId: "STF-S1" }), { id: "STF-S1", role: "supervisor" }).executable, "supervisor não aprova a própria ação");
ok(over(approval({ amountCents: 15000 }), { id: "STF-S1", role: "supervisor" }).executable, "supervisor pode executar com aprovação de outro supervisor");

// --- Valor e permissão sugeridos pelo Claude não substituem dados verificados -------------------------------------
d = decide(mk({ requestedCents: 10000, facts: { orderValueCents: 30000 }, untrusted: { amountCents: 5000, actorRole: "supervisor", approved: true } }));
ok(d.amountCents === 10000 && d.warnings.length === 3, "valor, papel e aprovação sugeridos são ignorados e sinalizados");
d = decide(mk({ requestedCents: 15000, facts: { orderValueCents: 30000 }, untrusted: { approved: true, actorRole: "supervisor" } }));
ok(d.approvalRequired && !d.executable, "'já aprovado' dito pelo modelo não libera valor acima da alçada");
d = decide(mk({ requestedCents: 40000, facts: { orderValueCents: 30000 } }));
ok(!d.executable && d.blockers.some((b) => b.includes("excede")), "valor acima do pedido verificado é bloqueado");
d = decide(mk({ facts: { orderValueCents: null } }));
ok(!d.executable && d.blockers.some((b) => b.includes("não verificado")), "sem valor verificado não executa");

// --- Cancelamento antes da separação ---------------------------------------------------------------------------
const cancel = (over: Partial<VerifiedFacts>) =>
  decide(mk({ category: "arrependimento_cancelamento", action: "cancelar_pedido", facts: { orderValueCents: 99900, separatedOn: null, ...over } }));
d = cancel({});
ok(d.eligible && !d.approvalRequired && d.executable && d.amountCents === null, "cancelar antes da separação: R$ 999,00 sem aprovação nem limite");
d = cancel({ separatedOn: "2026-11-03" });
ok(!d.eligible && !d.executable, "cancelar depois da separação: não elegível");
d = cancel({ separatedOn: "2026-11-06" });
ok(d.eligible, "separação datada depois do relógio ainda não ocorreu: cancelamento elegível");
d = decide(mk({ category: "arrependimento_cancelamento", action: "reembolsar", facts: { orderValueCents: 15000, deliveredOn: "2026-10-30" } }));
ok(d.eligible && d.approvalRequired, "reembolso por arrependimento em 7 dias: elegível, mas o limite de R$ 100 continua valendo");
d = decide(mk({ category: "arrependimento_cancelamento", action: "reembolsar", facts: { orderValueCents: 5000, deliveredOn: "2026-10-27" } }));
ok(!d.eligible, "arrependimento: 8 dias corridos após recebimento fica fora do prazo");

// --- Rastreio, atraso e extravio -------------------------------------------------------------------------------
const stage = (asOf: string, f: Partial<VerifiedFacts>, action: DecisionInput["action"] = "abrir_chamado_transportadora", category: DecisionInput["category"] = "atraso_entrega") =>
  decide(mk({ asOf, action, category, facts: f }));
// promessa 23/10 (sexta). 02/11 é feriado.
ok(stage("2026-10-23", {}).stage === "dentro_do_prazo", "no dia do prazo: dentro do prazo");
ok(stage("2026-10-26", {}).stage === "atraso_ate_limite", "1 dia útil de atraso: chamado");
d = stage("2026-11-03", {}); // 26,27,28,29,30,03 = 6
ok(d.stage === "atraso_ate_limite" && d.businessDaysLate === 6 && d.executable, "6 dias úteis (feriado 02/11 ignorado): abrir chamado");
d = stage("2026-11-04", {}); // 7
ok(d.stage === "atraso_ate_limite" && d.businessDaysLate === 7, "exatamente 7 dias úteis ainda é atraso até o limite");
d = stage("2026-11-05", {}); // 8
ok(d.stage === "atraso_acima_limite" && d.businessDaysLate === 8, "8 dias úteis: acima do limite");
d = stage("2026-11-05", { orderValueCents: 8000 }, "reembolsar");
ok(d.executable, "acima de 7 dias úteis com preferência por reembolso: reembolso executável (dentro da alçada)", `R$ ${(d.amountCents ?? 0) / 100}`);
d = decide(mk({ asOf: "2026-11-05", action: "reenviar_produto", facts: { orderValueCents: 8000, customerPreference: "reembolso" } }));
ok(!d.eligible, "cliente prefere reembolso: reenvio não é elegível");
d = decide(mk({ asOf: "2026-11-05", action: "reembolsar", facts: { orderValueCents: 8000, customerPreference: null } }));
ok(!d.executable && d.blockers.some((b) => b.includes("preferência")), "sem preferência verificada: bloqueia");
d = decide(mk({ asOf: "2026-10-26", action: "reembolsar", facts: { orderValueCents: 8000 } }));
ok(!d.eligible, "atraso curto: reembolso não é elegível");
d = decide(mk({ asOf: "2026-10-26", action: "reembolsar", facts: { orderValueCents: 8000, lostConfirmed: true } }));
ok(d.stage === "extraviado" && d.eligible && d.executable, "extravio confirmado antecipa reenvio/reembolso");

// Rastreio parado (dentro do prazo prometido).
const stalled = (lastEventOn: string, asOf: string) =>
  stage(asOf, { promisedOn: "2026-12-01", lastEventOn }, "abrir_chamado_transportadora", "onde_esta_pedido");
ok(stalled("2026-10-28", "2026-10-30").stage === "dentro_do_prazo", "parado há 2 dias úteis: apenas informar");
d = stalled("2026-10-28", "2026-11-03"); // 29,30,03 = 3
ok(d.stage === "rastreio_parado" && d.businessDaysStalled === 3 && d.executable, "parado há 3 dias úteis (feriado 02/11 não conta): avaliar chamado");
ok(stalled("2026-10-30", "2026-11-04").stage === "dentro_do_prazo", "30/10→04/11 = 2 dias úteis (feriado e fim de semana não contam)");
d = stage("2026-10-30", { promisedOn: "2026-12-01" }, "informar_status", "onde_esta_pedido");
ok(d.eligible && !d.executable, "informar status é permitido e não é efeito operacional");
d = stage("2026-11-03", { promisedOn: "2026-12-01", lastEventOn: "2026-10-28", duplicate: { action: "abrir_chamado_transportadora", status: "aberto" } }, "abrir_chamado_transportadora", "onde_esta_pedido");
ok(!d.executable && d.blockers.some((b) => b.includes("já existe")), "chamado duplicado para o mesmo problema é bloqueado");

// --- Bloqueios -------------------------------------------------------------------------------------------------
d = decide(mk({ asOf: "2026-11-05", facts: { orderValueCents: 8000, suspicionPending: true } }));
ok(!d.executable && !d.reviewWindowAllowed && d.blockers.some((b) => b.includes("suspeita")), "suspeita pendente bloqueia execução e janela de revisão");
d = decide(mk({ asOf: "2026-11-05", facts: { orderValueCents: 8000, identityConflicts: ["codigo_rastreio"] } }));
ok(!d.executable && d.blockers.some((b) => b.includes("divergentes")), "divergência de identidade bloqueia ação com dinheiro");
d = decide(mk({ asOf: "2026-11-05", facts: { orderValueCents: 8000, promisedOn: null } }));
ok(!d.executable && d.stage === "indeterminado", "sem data prometida: indeterminado e bloqueado");
d = decide(mk({ asOf: "2026-11-05", action: "cancelar_pedido" }));
ok(!d.eligible, "ação fora da lista da categoria não é permitida");

// --- Janela opcional de revisão (7.4) ------------------------------------------------------------------------------
d = decide(mk({ asOf: "2026-11-05", facts: { orderValueCents: 8000 } }));
ok(d.executable && d.reviewWindowAllowed, "ação autônoma dentro da alçada admite janela de revisão");
d = refund(15000, approval({ amountCents: 15000 }));
ok(d.executable && !d.reviewWindowAllowed, "ação que dependeu de aprovação não usa o timer de revisão");
d = refund(15000);
ok(!d.executable && !d.reviewWindowAllowed, "ausência de aprovação nunca libera pelo timer");

// --- Orientação para categorias fora do P0 ----------------------------------------------------------------------
d = decide(mk({ category: "reacao_adversa", action: "trocar_produto", facts: { orderValueCents: 8000, deliveredOn: "2026-11-01" } }));
ok(d.mode === "orientacao" && !d.eligible && d.handoff?.team === "supervisor", "reação adversa: sem troca como solução, encaminha ao supervisor");

console.log(failed ? `\n${failed} verificação(ões) falharam.` : "\nTudo certo.");
process.exit(failed ? 1 : 0);
