// GOB-13 · Monta o adaptador de IA a partir da configuração: dois modelos distintos → roteamento economy/reasoning;
// um só → modelo único (mesmo adaptador, sem economia alegada). Sem segredos aqui: tudo chega por parâmetro.
import { createProxyAdapter, type Budget, type CallObservation, type ModelAdapter, type Strategy } from "./adapter.ts";
import { createRouter, resolveTierModels, type RoutedAdapter } from "./router.ts";

export interface ModelConfig {
  url?: string | null; token?: string | null;
  model?: string | null; economy?: string | null; reasoning?: string | null;
  /** adaptive (padrão) | reasoning_only | economy_only. Valor desconhecido cai no padrão. */
  routing?: string | null;
}

export const parseRouting = (v: string | null | undefined): Exclude<Strategy, "single"> =>
  v === "reasoning_only" || v === "economy_only" ? v : "adaptive";

export function createModelAdapter(
  cfg: ModelConfig,
  opts: { budget: Budget; onCall?: (o: CallObservation) => void; timeoutMs?: number; maxTokens?: number; maxReasoningCalls?: number; fetchImpl?: typeof fetch },
): (RoutedAdapter & { models: { economy: string; reasoning: string; single: boolean } }) | null {
  if (!cfg.url || !cfg.token) return null;
  const m = resolveTierModels(cfg);
  if (!m.economy || !m.reasoning) return null;
  const make = (model: string): ModelAdapter =>
    createProxyAdapter({ url: cfg.url!, token: cfg.token!, model, timeoutMs: opts.timeoutMs, maxTokens: opts.maxTokens, fetchImpl: opts.fetchImpl });
  const economy = make(m.economy);
  const reasoning = m.single ? economy : make(m.reasoning);
  const router = createRouter({
    economy, reasoning, strategy: parseRouting(cfg.routing), budget: opts.budget, onCall: opts.onCall, maxReasoningCalls: opts.maxReasoningCalls,
  });
  return Object.assign(router, { models: { economy: m.economy, reasoning: m.reasoning, single: m.single } });
}
