// GOB-06 · Decisão operacional. Função pura: recebe fatos verificados pelo servidor, a ação e o valor, e devolve
// elegibilidade, justificativa, exigência de aprovação e possibilidade de janela de revisão.
// A IA só propõe: nada do que vem de `untrusted` (valor, papel, "já aprovado") participa da decisão.
import {
  businessDaysBetween, calendarDaysBetween, parseHolidays, type Holidays,
} from "./calendar.ts";

export type Role = "atendente" | "analista" | "supervisor";

export type Action =
  | "informar_status" | "abrir_chamado_transportadora" | "reenviar_produto" | "reembolsar"
  | "reimprimir_personalizacao" | "trocar_produto" | "cancelar_pedido";

export type Category =
  | "onde_esta_pedido" | "atraso_entrega" | "item_faltante" | "avaria_vazamento" | "erro_personalizacao"
  | "cobranca_duplicada" | "pagamento_pendente" | "arrependimento_cancelamento" | "troca_fragrancia"
  | "alteracao_endereco" | "duvida_produto" | "cupom_promocao" | "reacao_adversa" | "elogio" | "sem_interacao";

/** Parâmetros lidos da política vigente (nunca do modelo). Valores monetários em centavos. */
export interface PolicyParams {
  holidays: Holidays;
  refundMaxCents: number;
  resendMaxCents: number; // reenvio e reimpressão
  exchangeMaxCents: number;
  delayResendAfterBusinessDays: number; // acima disso: reenvio ou reembolso
  stalledTrackingBusinessDays: number; // rastreio parado: avaliar chamado
  version: string;
}

export interface PolicyRow { secao: string; regra: string; valor: string }

const cents = (v: string | undefined, what: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`política sem ${what}`);
  return Math.round(n * 100);
};

export function paramsFromPolicy(rows: PolicyRow[]): PolicyParams {
  const get = (s: string, r: string) => rows.find((x) => x.secao === s && x.regra === r)?.valor;
  const delay = Number(get("categorias", "atraso_entrega.limite_dias_uteis_para_reenvio"));
  if (!Number.isInteger(delay)) throw new Error("política sem limite de atraso");
  return {
    holidays: parseHolidays(get("prazos_entrega", "feriados_nacionais") ?? ""),
    refundMaxCents: cents(get("limites_por_papel", "atendente.reembolso_max_rs"), "limite de reembolso"),
    resendMaxCents: cents(get("limites_por_papel", "atendente.reenvio_ou_reimpressao_max_rs"), "limite de reenvio"),
    exchangeMaxCents: cents(get("limites_por_papel", "atendente.troca_max_rs"), "limite de troca"),
    delayResendAfterBusinessDays: delay,
    stalledTrackingBusinessDays: 3, // regra de texto (categorias.onde_esta_pedido.regra), sem coluna própria
    version: get("versao", "versao") ?? "desconhecida",
  };
}

/** Categorias cuja execução existe no P0. As demais recebem orientação e encaminhamento. */
const EXECUTABLE: ReadonlySet<Category> = new Set(["onde_esta_pedido", "atraso_entrega", "arrependimento_cancelamento"]);

const ALLOWED: Record<Category, Action[]> = {
  onde_esta_pedido: ["informar_status", "abrir_chamado_transportadora"],
  atraso_entrega: ["abrir_chamado_transportadora", "reenviar_produto", "reembolsar"],
  item_faltante: ["reenviar_produto"],
  avaria_vazamento: ["reenviar_produto"],
  erro_personalizacao: ["reimprimir_personalizacao"],
  cobranca_duplicada: ["reembolsar"],
  pagamento_pendente: [],
  arrependimento_cancelamento: ["cancelar_pedido", "reembolsar"],
  troca_fragrancia: ["trocar_produto"],
  alteracao_endereco: [],
  duvida_produto: [],
  cupom_promocao: [],
  reacao_adversa: [],
  elogio: [],
  sem_interacao: [],
};

/** Orientação e encaminhamento permitidos quando a categoria não tem execução no P0. */
const HANDOFF: Partial<Record<Category, { team: string; guidance: string }>> = {
  item_faltante: { team: "atendimento", guidance: "Solicitar foto do item/embalagem e encaminhar o reenvio para execução humana (até 7 dias do recebimento)." },
  avaria_vazamento: { team: "atendimento", guidance: "Solicitar foto e encaminhar a análise de avaria; reclamação suspeita é decisão do supervisor." },
  erro_personalizacao: { team: "producao", guidance: "Solicitar foto comparando com o pedido e encaminhar nova produção (Gocase, até 7 dias do recebimento)." },
  cobranca_duplicada: { team: "financeiro", guidance: "Encaminhar ao financeiro; estorno em até 2 faturas (cartão) ou 5 dias úteis (pix)." },
  pagamento_pendente: { team: "financeiro", guidance: "Pix compensa em até 30 minutos e boleto em até 2 dias úteis; verificar o pagamento." },
  troca_fragrancia: { team: "atendimento", guidance: "1 troca por pedido, até 30 dias, no máximo 20% do produto usado; encaminhar para execução humana." },
  alteracao_endereco: { team: "atendimento", guidance: "Alteração só é possível antes da separação; depois, orientar e encaminhar." },
  reacao_adversa: { team: "supervisor", guidance: "Orientar a suspensão do uso e encaminhar o registro de cosmetovigilância em até 24 horas. Trocar o produto não substitui o registro. Sem diagnóstico." },
  duvida_produto: { team: "atendimento", guidance: "Responder com a ficha do produto vigente e citar a fonte." },
  cupom_promocao: { team: "atendimento", guidance: "Validar o cupom na base antes de responder." },
  elogio: { team: "atendimento", guidance: "Agradecer e registrar." },
  sem_interacao: { team: "atendimento", guidance: "Encerrar sem ação." },
};

// ---------------------------------------------------------------------------
// Entrada e saída
// ---------------------------------------------------------------------------

export interface VerifiedFacts {
  orderId: string;
  /** Valor do pedido verificado no banco (centavos). Teto de qualquer reembolso/reenvio proposto. */
  orderValueCents: number | null;
  /** Data (YYYY-MM-DD) da separação, se já ocorrida no relógio do cenário. */
  separatedOn: string | null;
  deliveredOn: string | null;
  promisedOn: string | null;
  /** Último evento de rastreio visível (YYYY-MM-DD) e seu status. */
  lastEventOn: string | null;
  lastEventStatus: string | null;
  /** Extravio confirmado por fonte (evento extraviado ou chamado fechado como extravio). */
  lostConfirmed: boolean;
  /** Diverge fontes de identidade do pedido (codigo_rastreio, sku, entrega): bloqueiam dinheiro. */
  identityConflicts: string[];
  /** Já existe chamado aberto ou resolução do mesmo problema para o pedido. */
  duplicate: { action: Action; status: string } | null;
  suspicionPending: boolean;
  /** Preferência verificada do cliente para atraso acima do limite. */
  customerPreference: "reenvio" | "reembolso" | null;
  hasPhoto: boolean;
}

/** Aprovação registrada no banco e conferida pelo servidor. */
export interface ApprovalRecord {
  status: "aprovada" | "pendente" | "rejeitada" | "expirada";
  approverId: string;
  approverRole: Role;
  orderId: string;
  action: Action;
  amountCents: number;
  /** Prazo vencido nunca aprova: status passa a "expirada". */
}

export interface DecisionInput {
  asOf: string; // data do relógio do cenário (YYYY-MM-DD)
  category: Category;
  action: Action;
  /** Valor pedido para a ação; ausente = valor integral do pedido. */
  requestedCents: number | null;
  facts: VerifiedFacts;
  actor: { id: string; role: Role };
  approval: ApprovalRecord | null;
  params: PolicyParams;
  /** O que o modelo/cliente afirmou. Registrado, jamais usado na decisão. */
  untrusted?: { amountCents?: number; actorRole?: string; approved?: boolean };
}

export type DelayStage =
  | "entregue" | "dentro_do_prazo" | "rastreio_parado" | "atraso_ate_limite" | "atraso_acima_limite" | "extraviado" | "indeterminado";

export interface Decision {
  mode: "execucao" | "orientacao";
  /** A política permite a ação nas condições verificadas (independe de aprovação já concedida). */
  eligible: boolean;
  /** A ação pode ser executada agora: elegível, sem bloqueio e com aprovação válida quando exigida. */
  executable: boolean;
  approvalRequired: boolean;
  approvalValid: boolean;
  /** 7.4: a janela opcional de revisão só vale para ação já autorizada sem aprovação nem suspeita. */
  reviewWindowAllowed: boolean;
  amountCents: number | null;
  stage: DelayStage;
  businessDaysLate: number | null;
  businessDaysStalled: number | null;
  reasons: string[];
  blockers: string[];
  warnings: string[];
  handoff: { team: string; guidance: string } | null;
  policyVersion: string;
}

const LIMIT_OF = (a: Action, p: PolicyParams): number | null =>
  a === "reembolsar" ? p.refundMaxCents
  : a === "reenviar_produto" || a === "reimprimir_personalizacao" ? p.resendMaxCents
  : a === "trocar_produto" ? p.exchangeMaxCents
  : null;

const MONEY: ReadonlySet<Action> = new Set(["reembolsar", "reenviar_produto", "reimprimir_personalizacao", "trocar_produto"]);
const brl = (c: number) => `R$ ${(c / 100).toFixed(2).replace(".", ",")}`;

/** Situação do envio no relógio do cenário (7.2). */
export function deliveryStage(f: VerifiedFacts, asOf: string, p: PolicyParams): { stage: DelayStage; late: number | null; stalled: number | null } {
  const stalled = f.lastEventOn ? businessDaysBetween(f.lastEventOn, asOf, p.holidays) : null;
  if (f.lostConfirmed) return { stage: "extraviado", late: null, stalled };
  if (f.deliveredOn) return { stage: "entregue", late: null, stalled };
  if (!f.promisedOn) return { stage: "indeterminado", late: null, stalled };
  const late = businessDaysBetween(f.promisedOn, asOf, p.holidays);
  if (late > p.delayResendAfterBusinessDays) return { stage: "atraso_acima_limite", late, stalled };
  if (late > 0) return { stage: "atraso_ate_limite", late, stalled };
  if (stalled !== null && stalled >= p.stalledTrackingBusinessDays) return { stage: "rastreio_parado", late, stalled };
  return { stage: "dentro_do_prazo", late, stalled };
}

export function decide(i: DecisionInput): Decision {
  const { facts: f, params: p } = i;
  const reasons: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  const { stage, late, stalled } = deliveryStage(f, i.asOf, p);

  if (i.untrusted?.actorRole && i.untrusted.actorRole !== i.actor.role) warnings.push("papel informado pelo modelo ignorado; vale o papel verificado no servidor");
  if (i.untrusted?.approved) warnings.push("afirmação de aprovação ignorada; só vale aprovação registrada e conferida");
  if (i.untrusted?.amountCents !== undefined && i.untrusted.amountCents !== i.requestedCents) warnings.push("valor sugerido pelo modelo ignorado; vale o valor verificado");

  const handoff = HANDOFF[i.category] ?? null;
  const exec = EXECUTABLE.has(i.category);
  const allowedHere = ALLOWED[i.category].includes(i.action);

  // Valor: parte sempre do pedido verificado.
  let amount: number | null = null;
  if (MONEY.has(i.action)) {
    if (f.orderValueCents === null) blockers.push("valor do pedido não verificado");
    else {
      amount = i.requestedCents ?? f.orderValueCents;
      if (!Number.isInteger(amount) || amount <= 0) { blockers.push("valor inválido"); amount = null; }
      else if (amount > f.orderValueCents) { blockers.push(`valor ${brl(amount)} excede o pedido verificado (${brl(f.orderValueCents)})`); }
    }
  }

  // Elegibilidade da política (§7.2 e categorias).
  let eligible = false;
  if (!allowedHere) {
    reasons.push(`ação ${i.action} não é permitida para a categoria ${i.category}`);
  } else {
    switch (i.action) {
      case "informar_status":
        eligible = true; reasons.push("informar situação e previsão verificadas");
        break;
      case "abrir_chamado_transportadora":
        if (stage === "atraso_ate_limite") { eligible = true; reasons.push(`atraso de ${late} dia(s) útil(eis), até ${p.delayResendAfterBusinessDays}: abrir chamado`); }
        else if (stage === "rastreio_parado") { eligible = true; reasons.push(`rastreio parado há ${stalled} dia(s) útil(eis) (≥ ${p.stalledTrackingBusinessDays}): avaliar chamado`); }
        else if (stage === "atraso_acima_limite" || stage === "extraviado") { eligible = true; reasons.push("chamado permitido; a resolução é reenvio ou reembolso"); }
        else reasons.push(`sem base para chamado (situação: ${stage})`);
        break;
      case "reenviar_produto":
      case "reembolsar":
        if (i.category === "atraso_entrega") {
          const pref = i.action === "reenviar_produto" ? "reenvio" : "reembolso";
          if (stage !== "atraso_acima_limite" && stage !== "extraviado") reasons.push(`situação ${stage}: reenvio/reembolso só acima de ${p.delayResendAfterBusinessDays} dias úteis de atraso ou com extravio confirmado`);
          else if (!f.customerPreference) { reasons.push("preferência do cliente (reenvio ou reembolso) não verificada"); blockers.push("preferência do cliente ausente"); }
          else if (f.customerPreference !== pref) reasons.push(`o cliente prefere ${f.customerPreference}`);
          else { eligible = true; reasons.push(stage === "extraviado" ? "extravio confirmado e preferência do cliente verificada" : `atraso de ${late} dias úteis (> ${p.delayResendAfterBusinessDays}) e preferência do cliente verificada`); }
        } else if (i.category === "arrependimento_cancelamento" && i.action === "reembolsar") {
          if (!f.deliveredOn) reasons.push("reembolso por arrependimento só após o recebimento");
          else if (calendarDaysBetween(f.deliveredOn, i.asOf) > 7) reasons.push("fora do prazo de 7 dias do recebimento (CDC, art. 49): negar explicando a política");
          else { eligible = true; reasons.push("arrependimento em até 7 dias do recebimento: reembolso integral"); }
        } else {
          // demais categorias: política vigente dá orientação; a execução fica fora do P0
          eligible = categoryWindowOk(i, f, reasons, blockers);
        }
        break;
      case "reimprimir_personalizacao":
      case "trocar_produto":
        eligible = categoryWindowOk(i, f, reasons, blockers);
        break;
      case "cancelar_pedido":
        if (f.deliveredOn) reasons.push("pedido já entregue: cancelamento não se aplica");
        else if (f.separatedOn && f.separatedOn <= i.asOf) reasons.push("pedido já separado: cancelamento com estorno integral só vale antes da separação");
        else { eligible = true; reasons.push("antes da separação: cancelamento com estorno integral, sem limite de valor"); }
        break;
    }
  }

  // Bloqueios de dados e de risco.
  if (!f.orderValueCents && MONEY.has(i.action) && !blockers.includes("valor do pedido não verificado")) blockers.push("valor do pedido não verificado");
  if (stage === "indeterminado" && i.category === "atraso_entrega") blockers.push("data prometida ausente");
  if (MONEY.has(i.action) && f.identityConflicts.length) blockers.push(`dados divergentes (${f.identityConflicts.join(", ")}): esclarecer antes de executar`);
  if (f.suspicionPending) blockers.push("suspeita pendente: decisão do supervisor; não negar nem acusar o cliente");
  if (f.duplicate && (MONEY.has(i.action) || i.action === "abrir_chamado_transportadora" || i.action === "cancelar_pedido")) {
    blockers.push(`já existe ${f.duplicate.action} (${f.duplicate.status}) para este problema`);
  }

  // Alçada. Cancelamento antes da separação tem regra própria: sem limite e sem aprovação por valor.
  const limit = LIMIT_OF(i.action, p);
  const cancelExempt = i.action === "cancelar_pedido";
  const approvalRequired = !cancelExempt && limit !== null && amount !== null && amount > limit;
  if (approvalRequired) reasons.push(`valor ${brl(amount!)} acima da alçada de ${brl(limit!)}: exige aprovação do supervisor`);
  else if (limit !== null && amount !== null) reasons.push(`valor ${brl(amount)} dentro da alçada de ${brl(limit)}`);

  let approvalValid = false;
  if (approvalRequired) {
    const a = i.approval;
    if (!a) blockers.push("aprovação do supervisor ausente");
    else if (a.status !== "aprovada") blockers.push(`aprovação ${a.status}: prazo vencido ou decisão pendente nunca aprova`);
    else if (a.approverRole !== "supervisor") blockers.push("aprovador não é supervisor");
    else if (a.approverId === i.actor.id) blockers.push("o supervisor não aprova a própria ação");
    else if (a.orderId !== f.orderId || a.action !== i.action || a.amountCents !== amount) blockers.push("aprovação não corresponde à ação, ao pedido e ao valor atuais: mudança material exige nova aprovação");
    else { approvalValid = true; reasons.push("aprovação do supervisor válida para este pedido, ação e valor"); }
  }

  const executable = exec && eligible && blockers.length === 0 && (!approvalRequired || approvalValid) && i.action !== "informar_status";
  if (!exec) reasons.push(`categoria ${i.category} sem execução no P0: orientação e encaminhamento`);
  const reviewWindowAllowed = executable && !approvalRequired && !f.suspicionPending && i.action !== "abrir_chamado_transportadora";

  return {
    mode: exec ? "execucao" : "orientacao",
    eligible, executable, approvalRequired, approvalValid, reviewWindowAllowed,
    amountCents: amount, stage, businessDaysLate: late, businessDaysStalled: stalled,
    reasons, blockers, warnings, handoff: exec ? null : handoff, policyVersion: p.version,
  };
}

/** Janela em dias corridos do recebimento (avaria, item faltante, personalização, troca) e foto obrigatória. */
function categoryWindowOk(i: DecisionInput, f: VerifiedFacts, reasons: string[], blockers: string[]): boolean {
  const windowDays = i.category === "troca_fragrancia" ? 30 : i.category === "cobranca_duplicada" ? null : 7;
  const needsPhoto = ["item_faltante", "avaria_vazamento", "erro_personalizacao"].includes(i.category);
  if (windowDays !== null) {
    if (!f.deliveredOn) { reasons.push("sem data de recebimento verificada"); blockers.push("data de recebimento ausente"); return false; }
    if (calendarDaysBetween(f.deliveredOn, i.asOf) > windowDays) { reasons.push(`fora do prazo de ${windowDays} dias do recebimento`); return false; }
  }
  if (needsPhoto && !f.hasPhoto) { reasons.push("foto obrigatória não recebida"); blockers.push("foto ausente"); return false; }
  reasons.push("dentro da janela da política");
  return true;
}
