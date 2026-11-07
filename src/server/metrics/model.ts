// GOB-11 · Cálculo das métricas a partir de registros normalizados. Funções puras: sem banco, sem relógio do sistema.
// Regras de honestidade (AGENTS.md §8): caso aberto não é resolvido; pesquisa ausente não é satisfação;
// custo/token indisponível é "null" e nunca vira zero; todo percentual carrega seu denominador.

export type Channel = "whatsapp" | "email" | "reclame_aqui";

export const CHANNELS: Channel[] = ["whatsapp", "email", "reclame_aqui"];

/** Parâmetros de operação (BD/parametros.md). Alterar aqui não altera política de ação do agente. */
export const SLA = {
  whatsappBusinessMinutes: 30, // 30 min dentro do horário comercial (8h–20h, todos os dias)
  emailMinutes: 24 * 60,
  reclameAquiMinutes: 48 * 60, // com resposta pública
  businessStartHour: 8,
  businessEndHour: 20,
  tzOffsetHours: -3, // America/Sao_Paulo sem horário de verão
} as const;

/** Tópicos que a GoBIA pode resolver sozinha no P0 (coorte elegível para resolução autônoma). */
export const AUTONOMY_ELIGIBLE_TOPICS: readonly string[] = ["rastreio_atraso"];

export const DEFAULT_REOPEN_WINDOW_DAYS = 7; // proposta inicial; tratada como hipótese

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Estatística básica
// ---------------------------------------------------------------------------
export interface Summary { n: number; mean: number; median: number; p90: number; min: number; max: number }

/** P90 por posto mais próximo (nearest-rank): o menor valor com ao menos 90% da amostra até ele. */
export function percentileNearestRank(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) throw new Error("amostra vazia");
  const rank = Math.max(1, Math.ceil(p * sortedAsc.length));
  return sortedAsc[rank - 1];
}

export function summarize(values: number[]): Summary | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const n = v.length;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  return { n, mean, median, p90: percentileNearestRank(v, 0.9), min: v[0], max: v[n - 1] };
}

export const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

// ---------------------------------------------------------------------------
// Tempo comercial
// ---------------------------------------------------------------------------
/** Minutos dentro de 8h–20h (horário de Brasília) entre dois instantes. Zero se `to` não for posterior a `from`. */
export function businessMinutesBetween(fromMs: number, toMs: number): number {
  if (toMs <= fromMs) return 0;
  const off = SLA.tzOffsetHours * HOUR;
  const a = fromMs + off;
  const b = toMs + off;
  let total = 0;
  for (let day = Math.floor(a / DAY) * DAY; day <= b; day += DAY) {
    const open = day + SLA.businessStartHour * HOUR;
    const close = day + SLA.businessEndHour * HOUR;
    total += Math.max(0, Math.min(b, close) - Math.max(a, open));
  }
  return total / MIN;
}

/** Minutos de espera considerados para o SLA do canal (WhatsApp só conta o horário comercial). */
export function slaMinutes(channel: Channel, fromMs: number, toMs: number): number {
  return channel === "whatsapp" ? businessMinutesBetween(fromMs, toMs) : Math.max(0, toMs - fromMs) / MIN;
}

export function slaLimitMinutes(channel: Channel): number {
  return channel === "whatsapp" ? SLA.whatsappBusinessMinutes : channel === "email" ? SLA.emailMinutes : SLA.reclameAquiMinutes;
}

// ---------------------------------------------------------------------------
// Registros normalizados do MVP (execução do cenário)
// ---------------------------------------------------------------------------
export interface CaseRecord {
  id: string;
  status: string;
  channel: Channel;
  openedAt: number;
  topic: string;
  customerId: string | null;
  orderId: string | null;
  unitId: string | null;
  brandId: string | null;
  handoffReason: string | null;
  firstResponseAt: number | null;
  closures: ClosureRecord[];
  interventionReasons: string[]; // motivos registrados em eventos (todos, não só no encerramento)
  origin: { hypothesis: string; status: string } | null;
  models: string[]; // modelos usados no caso (filtro por modelo)
  /** Custo de IA: known=false quando não há registro ou alguma chamada veio sem custo. Nunca é zero por omissão. */
  ai: { calls: number; costKnown: boolean; costUsd: number };
  /** Tempo (ms) em aguardando_humano, a partir dos eventos de mudança de estado. */
  humanWaitMs: number;
}

export interface ClosureRecord {
  id: string;
  seq: number;
  closedAt: number;
  mode: "autonoma" | "assistida";
  reopenedAt: number | null; // reabertura explícita (ex.: pesquisa negativa)
}

export interface SurveyRecord {
  id: string;
  caseId: string;
  closureId: string;
  status: "solicitada" | "respondida";
  score: number | null;
  resolved: "sim" | "parcialmente" | "nao" | null;
}

export interface ProposalRecord {
  id: string;
  caseId: string;
  action: string;
  status: string;
  version: number;
  amountCents: number | null;
  requestedAt: number | null; // 1º 'proposta_registrada' (relógio do cenário)
  needsApproval: boolean;
  decisions: { decision: "aprovada" | "rejeitada" | "suspensa"; decidedAt: number }[];
  attempts: number;
  executionStatus: string | null;
}

export interface UsageRecord {
  caseId: string | null;
  step: string;
  requestedModel: string | null;
  servedModel: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  ok: boolean;
}

export interface AuditCounts {
  falhas: number;          // execucao_falhou
  retentativas: number;    // execucao_nova_tentativa
  bloqueios: number;       // revalidacao_bloqueou
  falhasTransitorias: number;
}

export interface MvpInput {
  asOf: number; // relógio do cenário
  cases: CaseRecord[];
  surveys: SurveyRecord[];
  proposals: ProposalRecord[];
  usage: UsageRecord[];
  audit: AuditCounts;
  reopenWindowDays: number;
  /** Premissa informada por quem consulta (minutos humanos por caso). Nula = sem projeção. */
  assumedMinutesPerCase: number | null;
}

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------
export interface MvpStats {
  received: number;
  resolution: {
    eligible: number; eligibleResolvedAutonomous: number; eligibleResolvedAssisted: number; eligibleOpen: number;
    autonomousRate: number | null;
    notEligible: number;
    resolvedTotal: number; resolvedAutonomous: number; resolvedAssisted: number; open: number;
    assistedShareOfResolved: number | null;
  };
  resolutionTimeHours: Summary | null;
  openAgesHours: Summary | null;
  firstResponse: {
    responded: number; withinSla: number; late: number; unansweredOverdue: number; unansweredWaiting: number;
    slaRate: number | null; slaDenominator: number;
    minutes: Summary | null;
    byChannel: Record<Channel, { responded: number; withinSla: number; late: number; unansweredOverdue: number; minutes: Summary | null }>;
  };
  cost: {
    resolvedCases: number; resolvedKnown: number; resolvedUnknown: number; resolvedTotalUsd: number; perResolvedUsd: number | null;
    openCases: number; openKnown: number; openUnknown: number; openTotalUsd: number;
  };
  csat: {
    surveysRequested: number; answered: number; responseRate: number | null;
    satisfied: number; csat: number | null; resolvedYes: number; resolvedPartially: number; resolvedNo: number; awaitingAnswer: number;
  };
  reopening: {
    windowDays: number; closures: number; reopenedExplicit: number; reopenedHypothesis: number; reopened: number; rate: number | null;
  };
  interventions: {
    casesWithIntervention: number; casesTotal: number;
    reasons: { reason: string; count: number }[];
    decisionHours: Summary | null; decisions: number;
    proposals: number; adjusted: number; rejected: number; adjustedRate: number | null; rejectedRate: number | null;
    humanWaitHours: Summary | null;
  };
  models: {
    model: string; step: string; calls: number; failures: number;
    promptTokens: number; completionTokens: number; tokensUnknownCalls: number;
    latencyMs: Summary | null; swaps: number; costUsd: number; costUnknownCalls: number;
  }[];
  quality: AuditCounts & { blockedProposals: number; failedExecutions: number; duplicatesAvoided: null };
  origins: { hypothesis: string; status: string; count: number }[];
  projection: {
    assumedMinutesPerCase: number | null;
    humanMinutesSaved: number | null; // = autônomos × premissa; é projeção
    refundValueCents: number;         // valor de reembolso simulado concluído: NÃO é custo da IA nem economia
  };
}

const hours = (ms: number) => ms / HOUR;

function slaOutcome(c: CaseRecord, asOf: number) {
  if (c.firstResponseAt !== null) {
    const m = slaMinutes(c.channel, c.openedAt, c.firstResponseAt);
    return { kind: m <= slaLimitMinutes(c.channel) ? ("within" as const) : ("late" as const), minutes: m };
  }
  const waited = slaMinutes(c.channel, c.openedAt, asOf);
  return { kind: waited > slaLimitMinutes(c.channel) ? ("overdue" as const) : ("waiting" as const), minutes: null };
}

const latestClosure = (c: CaseRecord): ClosureRecord | null => c.closures.length ? c.closures.reduce((a, b) => (b.seq > a.seq ? b : a)) : null;
/** Resolvido = estado ATUAL resolvido com encerramento válido registrado. Caso reaberto/aberto não conta. */
const isResolved = (c: CaseRecord): boolean => c.status === "resolvido" && latestClosure(c) !== null;

export function computeMvp(input: MvpInput): MvpStats {
  const { cases, asOf } = input;
  const resolved = cases.filter(isResolved);
  const open = cases.filter((c) => !isResolved(c));
  const mode = (c: CaseRecord) => latestClosure(c)!.mode;

  const eligible = cases.filter((c) => AUTONOMY_ELIGIBLE_TOPICS.includes(c.topic));
  const eligResolvedAuto = eligible.filter((c) => isResolved(c) && mode(c) === "autonoma").length;
  const eligResolvedAssist = eligible.filter((c) => isResolved(c) && mode(c) === "assistida").length;
  const eligOpen = eligible.filter((c) => !isResolved(c)).length;

  // Tempo de resolução e idade dos abertos
  const resolutionTimeHours = summarize(resolved.map((c) => hours(latestClosure(c)!.closedAt - c.openedAt)));
  const openAgesHours = summarize(open.map((c) => hours(Math.max(0, asOf - c.openedAt))));

  // Primeira resposta e SLA
  const byChannel = Object.fromEntries(CHANNELS.map((ch) => [ch, { responded: 0, withinSla: 0, late: 0, unansweredOverdue: 0, minutes: null as Summary | null }])) as MvpStats["firstResponse"]["byChannel"];
  const allMinutes: number[] = [];
  const perChannelMinutes: Record<Channel, number[]> = { whatsapp: [], email: [], reclame_aqui: [] };
  let withinSla = 0, late = 0, overdue = 0, waiting = 0;
  for (const c of cases) {
    const o = slaOutcome(c, asOf);
    const bc = byChannel[c.channel];
    if (o.kind === "within") { withinSla++; bc.withinSla++; bc.responded++; }
    else if (o.kind === "late") { late++; bc.late++; bc.responded++; }
    else if (o.kind === "overdue") { overdue++; bc.unansweredOverdue++; }
    else waiting++;
    if (o.minutes !== null) { allMinutes.push(o.minutes); perChannelMinutes[c.channel].push(o.minutes); }
  }
  for (const ch of CHANNELS) byChannel[ch].minutes = summarize(perChannelMinutes[ch]);
  const slaDen = withinSla + late + overdue;

  // Custos: atribuídos ao caso (todas as chamadas, inclusive tentativas)
  const costOf = (set: CaseRecord[]) => {
    let known = 0, unknown = 0, total = 0;
    for (const c of set) {
      if (c.ai.costKnown) { known++; total += c.ai.costUsd; } else unknown++;
    }
    return { known, unknown, total };
  };
  const rc = costOf(resolved);
  const oc = costOf(open);

  // CSAT: só pesquisas dos casos da coorte
  const caseIds = new Set(cases.map((c) => c.id));
  const surveys = input.surveys.filter((s) => caseIds.has(s.caseId));
  const answered = surveys.filter((s) => s.status === "respondida" && s.score !== null);
  const satisfied = answered.filter((s) => (s.score as number) >= 4).length;

  // Reabertura (janela configurável; hipótese)
  const windowMs = input.reopenWindowDays * DAY;
  let closuresN = 0, explicit = 0, hypothesis = 0, reopenedN = 0;
  for (const c of cases) {
    for (const cl of c.closures) {
      closuresN++;
      const byRecord = cl.reopenedAt !== null && cl.reopenedAt - cl.closedAt <= windowMs;
      const byNewCase = !!c.customerId && !!c.orderId && cases.some((o) =>
        o.id !== c.id && o.customerId === c.customerId && o.orderId === c.orderId && o.topic === c.topic &&
        o.openedAt > cl.closedAt && o.openedAt - cl.closedAt <= windowMs);
      if (byRecord) explicit++;
      else if (byNewCase) hypothesis++;
      if (byRecord || byNewCase) reopenedN++;
    }
  }

  // Intervenções
  const reasonCount = new Map<string, number>();
  let withIntervention = 0;
  for (const c of cases) {
    const reasons = new Set<string>(c.interventionReasons);
    if (c.handoffReason) reasons.add(`encaminhamento:${c.handoffReason}`);
    if (reasons.size) withIntervention++;
    for (const r of reasons) reasonCount.set(r, (reasonCount.get(r) ?? 0) + 1);
  }
  const proposals = input.proposals.filter((p) => caseIds.has(p.caseId));
  const decisionHours: number[] = [];
  for (const p of proposals) {
    if (p.requestedAt === null) continue;
    for (const d of p.decisions) if (d.decision !== "suspensa") decisionHours.push(hours(Math.max(0, d.decidedAt - p.requestedAt)));
  }
  const adjusted = proposals.filter((p) => p.version > 1).length;
  const rejected = proposals.filter((p) => p.status === "rejeitada" || p.decisions.some((d) => d.decision === "rejeitada")).length;

  // Modelos
  const usage = input.usage.filter((u) => u.caseId === null || caseIds.has(u.caseId));
  const groups = new Map<string, UsageRecord[]>();
  for (const u of usage) {
    const key = `${u.servedModel ?? u.requestedModel ?? "desconhecido"}\u0000${u.step}`;
    groups.set(key, [...(groups.get(key) ?? []), u]);
  }
  const models = [...groups].map(([key, rows]) => {
    const [model, step] = key.split("\u0000");
    return {
      model, step, calls: rows.length, failures: rows.filter((r) => !r.ok).length,
      promptTokens: rows.reduce((a, r) => a + (r.promptTokens ?? 0), 0),
      completionTokens: rows.reduce((a, r) => a + (r.completionTokens ?? 0), 0),
      tokensUnknownCalls: rows.filter((r) => r.promptTokens === null || r.completionTokens === null).length,
      latencyMs: summarize(rows.filter((r) => r.latencyMs !== null).map((r) => r.latencyMs as number)),
      swaps: rows.filter((r) => r.servedModel && r.requestedModel && r.servedModel !== r.requestedModel).length,
      costUsd: rows.reduce((a, r) => a + (r.costUsd ?? 0), 0),
      costUnknownCalls: rows.filter((r) => r.costUsd === null).length,
    };
  }).sort((a, b) => b.calls - a.calls);

  // Origem investigada: hipótese e confirmação separadas; sem classificação = "indeterminada" (nunca atribuída)
  const originCount = new Map<string, number>();
  for (const c of cases) {
    const h = c.origin?.hypothesis ?? "indeterminada";
    const st = c.origin ? (c.origin.status === "confirmada" ? "confirmada" : "hipotese") : "nao_investigada";
    const k = `${h}\u0000${st}`;
    originCount.set(k, (originCount.get(k) ?? 0) + 1);
  }

  const refund = proposals.filter((p) => p.action === "reembolsar" && p.status === "concluida").reduce((a, p) => a + (p.amountCents ?? 0), 0);

  return {
    received: cases.length,
    resolution: {
      eligible: eligible.length, eligibleResolvedAutonomous: eligResolvedAuto, eligibleResolvedAssisted: eligResolvedAssist,
      eligibleOpen: eligOpen, autonomousRate: ratio(eligResolvedAuto, eligible.length),
      notEligible: cases.length - eligible.length,
      resolvedTotal: resolved.length,
      resolvedAutonomous: resolved.filter((c) => mode(c) === "autonoma").length,
      resolvedAssisted: resolved.filter((c) => mode(c) === "assistida").length,
      open: open.length,
      assistedShareOfResolved: ratio(resolved.filter((c) => mode(c) === "assistida").length, resolved.length),
    },
    resolutionTimeHours,
    openAgesHours,
    firstResponse: {
      responded: withinSla + late, withinSla, late, unansweredOverdue: overdue, unansweredWaiting: waiting,
      slaRate: ratio(withinSla, slaDen), slaDenominator: slaDen, minutes: summarize(allMinutes), byChannel,
    },
    cost: {
      resolvedCases: resolved.length, resolvedKnown: rc.known, resolvedUnknown: rc.unknown, resolvedTotalUsd: rc.total,
      perResolvedUsd: rc.known > 0 ? rc.total / rc.known : null,
      openCases: open.length, openKnown: oc.known, openUnknown: oc.unknown, openTotalUsd: oc.total,
    },
    csat: {
      surveysRequested: surveys.length, answered: answered.length, responseRate: ratio(answered.length, surveys.length),
      satisfied, csat: ratio(satisfied, answered.length),
      resolvedYes: answered.filter((s) => s.resolved === "sim").length,
      resolvedPartially: answered.filter((s) => s.resolved === "parcialmente").length,
      resolvedNo: answered.filter((s) => s.resolved === "nao").length,
      awaitingAnswer: surveys.length - answered.length,
    },
    reopening: { windowDays: input.reopenWindowDays, closures: closuresN, reopenedExplicit: explicit, reopenedHypothesis: hypothesis, reopened: reopenedN, rate: ratio(reopenedN, closuresN) },
    interventions: {
      casesWithIntervention: withIntervention, casesTotal: cases.length,
      reasons: [...reasonCount].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
      decisionHours: summarize(decisionHours), decisions: decisionHours.length,
      proposals: proposals.length, adjusted, rejected, adjustedRate: ratio(adjusted, proposals.length), rejectedRate: ratio(rejected, proposals.length),
      humanWaitHours: summarize(cases.filter((c) => c.humanWaitMs > 0).map((c) => hours(c.humanWaitMs))),
    },
    models,
    quality: {
      ...input.audit,
      blockedProposals: proposals.filter((p) => p.status === "bloqueada").length,
      failedExecutions: proposals.filter((p) => p.executionStatus === "falhou").length,
      duplicatesAvoided: null, // ainda não registrado como evento: exibido como "não medido", nunca como zero
    },
    origins: [...originCount].map(([k, count]) => { const [hypothesis, status] = k.split("\u0000"); return { hypothesis, status, count }; })
      .sort((a, b) => b.count - a.count),
    projection: {
      assumedMinutesPerCase: input.assumedMinutesPerCase,
      humanMinutesSaved: input.assumedMinutesPerCase === null ? null : resolved.filter((c) => mode(c) === "autonoma").length * input.assumedMinutesPerCase,
      refundValueCents: refund,
    },
  };
}

// ---------------------------------------------------------------------------
// Histórico importado (conversas encerradas até 02/11 08:00; amostra de 1 em cada 4 clientes)
// ---------------------------------------------------------------------------
export interface HistoryConversation {
  id: string; channel: Channel; openedAt: number; status: string | null;
  firstResponseAt: number | null; closedAt: number | null; unitId: string | null; brandId: string | null;
}
export interface HistorySurvey { channel: Channel; sentAt: number; answered: boolean; score: number | null; unitId: string | null; brandId: string | null }

export interface HistoryStats {
  conversations: number;
  byStatus: { status: string; count: number }[];
  resolved: number;
  resolutionTimeHours: Summary | null;
  firstResponse: {
    responded: number; withinSla: number; late: number; withoutHumanResponse: number; slaRate: number | null; slaDenominator: number;
    minutes: Summary | null;
  };
  csat: { sent: number; answered: number; responseRate: number | null; satisfied: number; csat: number | null };
  reopenedConversations: number; reopenedRate: number | null;
}

export function computeHistory(conversations: HistoryConversation[], surveys: HistorySurvey[]): HistoryStats {
  const byStatus = new Map<string, number>();
  for (const c of conversations) byStatus.set(c.status ?? "sem_status", (byStatus.get(c.status ?? "sem_status") ?? 0) + 1);
  const resolved = conversations.filter((c) => c.status === "resolvido");
  const times = resolved.filter((c) => c.closedAt !== null).map((c) => hours((c.closedAt as number) - c.openedAt));

  let within = 0, late = 0, none = 0;
  const mins: number[] = [];
  for (const c of conversations) {
    if (c.firstResponseAt === null) { none++; continue; }
    const m = slaMinutes(c.channel, c.openedAt, c.firstResponseAt);
    mins.push(m);
    if (m <= slaLimitMinutes(c.channel)) within++; else late++;
  }
  const answered = surveys.filter((s) => s.answered && s.score !== null);
  const satisfied = answered.filter((s) => (s.score as number) >= 4).length;
  const reopened = conversations.filter((c) => c.status === "reaberto").length;
  return {
    conversations: conversations.length,
    byStatus: [...byStatus].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
    resolved: resolved.length,
    resolutionTimeHours: summarize(times),
    firstResponse: {
      responded: within + late, withinSla: within, late, withoutHumanResponse: none,
      slaRate: ratio(within, within + late), slaDenominator: within + late, minutes: summarize(mins),
    },
    csat: { sent: surveys.length, answered: answered.length, responseRate: ratio(answered.length, surveys.length), satisfied, csat: ratio(satisfied, answered.length) },
    reopenedConversations: reopened, reopenedRate: ratio(reopened, conversations.length),
  };
}
