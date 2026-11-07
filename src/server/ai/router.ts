// GOB-13 · Roteamento adaptativo entre os modelos `economy` e `reasoning` do proxy.
// Regras de segurança:
//  - a camada é escolhida só por sinais do servidor (evidência, estado da conversa); o texto do modelo nunca a escolhe;
//  - trocar de modelo não troca permissões: ferramentas, escopo, política e orçamento são do servidor e iguais nas duas camadas;
//  - o estado compartilhado é a própria conversa (mesmas mensagens, evidências e resultados de ferramenta) enviada ao modelo escolhido;
//  - um único orçamento (chamadas e tokens) vale para o caso inteiro, somando as duas camadas e as tentativas de contingência;
//  - com um só modelo, o mesmo adaptador responde tudo (camada "unico") e nada de economia é alegado.
import {
  AdapterError, withBudget,
  type Budget, type CallObservation, type ChatMessage, type Completion, type CompleteOptions, type ModelAdapter,
  type RouteInfo, type RouteSignals, type Strategy, type Tier,
} from "./adapter.ts";

export interface TierModels { economy: string | null; reasoning: string | null }

/** Modelos efetivos a partir da configuração. `CLAUDE_MODEL` sozinho = modelo único; nomes iguais = modelo único. */
export function resolveTierModels(cfg: { model?: string | null; economy?: string | null; reasoning?: string | null }): TierModels & { single: boolean } {
  const economy = cfg.economy?.trim() || cfg.model?.trim() || null;
  const reasoning = cfg.reasoning?.trim() || null;
  if (!economy && !reasoning) return { economy: null, reasoning: null, single: true };
  if (!reasoning || !economy || reasoning === economy) {
    const only = economy ?? reasoning;
    return { economy: only, reasoning: only, single: true };
  }
  return { economy, reasoning, single: false };
}

/** Mais de uma solicitação distinta na mesma mensagem (ou mais de um pedido citado). Regra determinística, sem modelo. */
const REQUEST_GROUPS: RegExp[] = [
  /reembols|estorn|dinheiro de volta|devolu[cç][aã]o do valor/i,
  /reenvi|enviar de novo|mandar de novo|novo envio/i,
  /\btroc(a|ar)\b|trocar por/i,
  /cancel/i,
  /endere[cç]o/i,
  /nota fiscal|\bnf\b/i,
  /reimpress|refazer a (arte|impress)|imprimir de novo/i,
  /cobran[cç]a (duplicada|em dobro)|cobrad[oa] (duas|2) vezes/i,
];
export function detectMultiIntent(text: string): boolean {
  const groups = REQUEST_GROUPS.filter((r) => r.test(text)).length;
  const orders = new Set((text.match(/\b[A-Z]{2}[A-Z]?\d{5,7}\b/g) ?? []));
  return groups >= 2 || orders.size >= 2;
}

export interface RouteDecision { tier: Tier; reason: string }

/**
 * Decisão pura. `reasoningUsed` = chamadas já feitas na camada reasoning neste caso; `previous` = camada da chamada anterior.
 * A reavaliação a cada etapa permite voltar ao econômico quando a parte complexa foi resolvida.
 */
export function chooseTier(
  strategy: Strategy, s: RouteSignals, state: { previous: Tier | null; reasoningUsed: number; maxReasoningCalls: number },
): RouteDecision {
  if (strategy === "single") return { tier: "unico", reason: "modelo_unico" };
  if (strategy === "reasoning_only") return { tier: "reasoning", reason: "estrategia_somente_reasoning" };
  if (strategy === "economy_only") return { tier: "economy", reason: "estrategia_somente_economy" };

  let want: RouteDecision | null = null;
  if (s.pendingRepair) want = { tier: "reasoning", reason: "reparo_de_saida_invalida" };
  else if (s.conflicts > 0) want = { tier: "reasoning", reason: "conflito_de_fontes" };
  else if (s.toolErrors > 0) want = { tier: "reasoning", reason: "falha_ou_recusa_de_ferramenta" };
  else if (s.step === 1 && s.multiIntent) want = { tier: "reasoning", reason: "multiplas_solicitacoes" };

  if (want && state.reasoningUsed >= state.maxReasoningCalls) return { tier: "economy", reason: "limite_de_raciocinio_por_caso" };
  if (want) return want;
  return { tier: "economy", reason: state.previous === "reasoning" ? "parte_complexa_resolvida" : "intencao_simples_dados_coerentes" };
}

export interface RouterConfig {
  economy: ModelAdapter | null;
  reasoning: ModelAdapter | null;
  /** Padrão: adaptativo com dois modelos distintos; único com um. */
  strategy?: Exclude<Strategy, "single">;
  budget: Budget;
  /** Teto de chamadas reasoning por caso (custo e latência). */
  maxReasoningCalls?: number;
  onCall?: (o: CallObservation) => void;
}

export interface RoutedAdapter extends ModelAdapter {
  readonly strategy: Strategy;
  /** Decisões já tomadas, em ordem (inclui tentativas de contingência). */
  readonly decisions: RouteInfo[];
  report(): { calls: number; tokens: number; costUsd: number | null; costAvailable: boolean };
}

const stripPrefix = (id: string) => (id.includes(":") ? id.slice(id.indexOf(":") + 1) : id);

/** Falhas do provedor que justificam uma tentativa na outra camada. Orçamento esgotado nunca é contornado. */
const FALLBACK_KINDS = new Set(["timeout", "rede", "http", "resposta_invalida"]);

export function createRouter(cfg: RouterConfig): RoutedAdapter {
  const { economy, reasoning } = cfg;
  const sole = economy ?? reasoning;
  if (!sole) throw new AdapterError("http", "Nenhum modelo configurado para o roteador.");
  const single = !economy || !reasoning || economy === reasoning || economy.id === reasoning.id;
  const strategy: Strategy = single ? "single" : (cfg.strategy ?? "adaptive");
  const maxReasoning = cfg.maxReasoningCalls ?? 3;
  const pick = (tier: Tier): ModelAdapter => (single ? sole : tier === "reasoning" ? reasoning! : economy!);

  // Despachante: executa na camada que a decisão indicou. O orçamento envolve o despachante, então conta cada tentativa.
  const dispatcher: ModelAdapter = {
    kind: sole.kind,
    id: single ? sole.id : `roteado:${economy!.id}|${reasoning!.id}`,
    complete: (messages: ChatMessage[], opts?: CompleteOptions): Promise<Completion> =>
      pick(opts?.route?.tier ?? "economy").complete(messages, { maxTokens: opts?.maxTokens }),
  };
  const budgeted = withBudget(dispatcher, cfg.budget, cfg.onCall);

  const decisions: RouteInfo[] = [];
  let previous: Tier | null = null;
  let reasoningUsed = 0;

  const info = (tier: Tier, reason: string, from: Tier | null): RouteInfo => ({
    tier, strategy, reason, switchedFrom: from, model: stripPrefix(pick(tier).id),
  });

  return {
    kind: dispatcher.kind,
    id: dispatcher.id,
    strategy,
    decisions,
    report: () => budgeted.report(),
    async complete(messages, opts) {
      const signals: RouteSignals = opts?.signals ?? { step: decisions.length + 1, multiIntent: false, conflicts: 0, toolErrors: 0, pendingRepair: false };
      const d = chooseTier(strategy, signals, { previous, reasoningUsed, maxReasoningCalls: maxReasoning });
      const route = info(d.tier, d.reason, previous && previous !== d.tier ? previous : null);
      const attempt = async (r: RouteInfo) => {
        decisions.push(r);
        previous = r.tier;
        if (r.tier === "reasoning") reasoningUsed++;
        return budgeted.complete(messages, { maxTokens: opts?.maxTokens, route: r });
      };
      try {
        return await attempt(route);
      } catch (e) {
        // Contingência: o raciocínio indisponível não derruba o atendimento; a conversa segue na camada econômica.
        if (!single && route.tier === "reasoning" && e instanceof AdapterError && FALLBACK_KINDS.has(e.kind)) {
          return attempt(info("economy", `contingencia_${e.kind}`, "reasoning"));
        }
        throw e;
      }
    },
  };
}
