// GOB-07 · Adaptador server-side do proxy de IA do evento (formato OpenAI /v1/chat/completions) e adaptador simulado.
// Sem segredos aqui: endpoint, token e modelo chegam por configuração. Todo uso reportado é registrado; custo é
// "indisponível" (null) porque o proxy de chat devolve só tokens, nunca zero implícito.

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

export interface Usage { promptTokens: number | null; completionTokens: number | null; costUsd: number | null }

export interface Completion { text: string; usage: Usage; model: string }

export type AdapterErrorKind = "timeout" | "rede" | "http" | "resposta_invalida" | "orcamento";

export class AdapterError extends Error {
  kind: AdapterErrorKind;
  constructor(kind: AdapterErrorKind, message: string) {
    super(message);
    this.name = "AdapterError";
    this.kind = kind;
  }
}

/** GOB-13 · Camada do modelo: `economy` e `reasoning` são aliases de configuração; `unico` = só há um modelo. */
export type Tier = "economy" | "reasoning" | "unico";
export type Strategy = "adaptive" | "reasoning_only" | "economy_only" | "single";

/**
 * Sinais de roteamento calculados pelo SERVIDOR a partir de evidências e do estado da conversa. Nunca vêm da confiança
 * autodeclarada do modelo, e o texto do modelo não consegue escolher a camada.
 */
export interface RouteSignals {
  step: number;              // 1 = primeira chamada do caso
  multiIntent: boolean;      // a mensagem traz mais de uma solicitação distinta
  conflicts: number;         // conflitos de fonte nos resultados de ferramenta mais recentes
  toolErrors: number;        // ferramentas recusadas ou com erro nos resultados mais recentes
  pendingRepair: boolean;    // a chamada anterior devolveu saída inválida
}

/** Decisão de roteamento de uma chamada, registrada junto do uso (ai_usage). */
export interface RouteInfo {
  tier: Tier;
  strategy: Strategy;
  reason: string;
  switchedFrom: Tier | null;
  model: string | null;
}

export interface CompleteOptions { maxTokens?: number; signals?: RouteSignals; route?: RouteInfo }

export interface ModelAdapter {
  /** "proxy" para o serviço real; "simulado" nunca é apresentado como resposta de provedor. */
  readonly kind: "proxy" | "simulado";
  readonly id: string;
  complete(messages: ChatMessage[], opts?: CompleteOptions): Promise<Completion>;
}

export interface ProxyConfig {
  url: string; // base, ex.: https://ai-proxy.gogroupbr.com/v1
  token: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

/** Aceita a base com ou sem `/v1` (o .env do evento traz só o host) e devolve o endpoint de chat. */
export function chatEndpoint(base: string): string {
  const root = base.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, "").replace(/\/v1$/, "");
  return `${root}/v1/chat/completions`;
}

export function createProxyAdapter(cfg: ProxyConfig): ModelAdapter {
  if (!cfg.url || !cfg.token || !cfg.model) throw new AdapterError("http", "Proxy de IA sem endpoint, token ou modelo configurado.");
  const doFetch = cfg.fetchImpl ?? fetch;
  const endpoint = chatEndpoint(cfg.url);
  return {
    kind: "proxy",
    id: `proxy:${cfg.model}`,
    async complete(messages, opts) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 30_000);
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
          // Modelos de raciocínio do proxy consomem tokens antes da resposta: margem ≥ 2000.
          body: JSON.stringify({ model: cfg.model, messages, max_tokens: opts?.maxTokens ?? cfg.maxTokens ?? 2500 }),
          signal: ctrl.signal,
        });
      } catch (e) {
        throw ctrl.signal.aborted
          ? new AdapterError("timeout", `Sem resposta do proxy em ${cfg.timeoutMs ?? 30_000} ms.`)
          : new AdapterError("rede", `Falha de rede no proxy: ${(e as Error).name}`);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new AdapterError("http", `Proxy respondeu HTTP ${res.status}.`);
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new AdapterError("resposta_invalida", "Proxy devolveu corpo que não é JSON.");
      }
      const b = body as { choices?: { message?: { content?: unknown } }[]; usage?: Record<string, unknown>; model?: unknown };
      const text = b.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) throw new AdapterError("resposta_invalida", "Proxy devolveu resposta vazia.");
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      return {
        text,
        model: typeof b.model === "string" ? b.model : cfg.model,
        usage: {
          promptTokens: num(b.usage?.prompt_tokens),
          completionTokens: num(b.usage?.completion_tokens),
          costUsd: num(b.usage?.estimated_cost_usd),
        },
      };
    },
  };
}

/** Adaptador de teste local. `script` devolve o texto (ou lança AdapterError) a cada chamada. */
export function createSimulatedAdapter(
  script: (messages: ChatMessage[], call: number) => string | Promise<string>,
): ModelAdapter & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    kind: "simulado",
    id: "simulado:teste-local",
    calls,
    async complete(messages) {
      calls.push(messages);
      const text = await script(messages, calls.length);
      return { text, model: "simulado", usage: { promptTokens: null, completionTokens: null, costUsd: null } };
    },
  };
}

/** Limita chamadas e tokens por caso. Esgotado → AdapterError("orcamento"); o chamador gera continuidade humana. */
export interface Budget { maxCalls: number; maxTokens: number }

/** Uma chamada ao modelo, para registrar uso (GOB-11). Custo/tokens nulos = indisponível; latência medida aqui. */
export interface CallObservation {
  call: number;
  ok: boolean;
  errorKind: AdapterErrorKind | "desconhecido" | null;
  servedModel: string | null;
  usage: Usage;
  latencyMs: number;
  /** Camada/motivo desta tentativa quando o adaptador é roteado (GOB-13); nulo = modelo único sem roteamento. */
  route: RouteInfo | null;
}

export function withBudget(inner: ModelAdapter, budget: Budget, onCall?: (o: CallObservation) => void): ModelAdapter & { report(): { calls: number; tokens: number; costUsd: number | null; costAvailable: boolean } } {
  let calls = 0;
  let tokens = 0;
  let cost = 0;
  let costSeen = true;
  return {
    kind: inner.kind,
    id: inner.id,
    async complete(messages, opts) {
      if (calls >= budget.maxCalls) throw new AdapterError("orcamento", `Limite de ${budget.maxCalls} chamadas por caso atingido.`);
      if (tokens >= budget.maxTokens) throw new AdapterError("orcamento", `Limite de ${budget.maxTokens} tokens por caso atingido.`);
      calls++;
      const started = Date.now();
      let c: Completion;
      try {
        c = await inner.complete(messages, opts);
      } catch (e) {
        // Chamada que falhou também conta como tentativa; nenhum custo é inventado para ela.
        costSeen = false;
        onCall?.({ call: calls, ok: false, errorKind: e instanceof AdapterError ? e.kind : "desconhecido", servedModel: null,
          usage: { promptTokens: null, completionTokens: null, costUsd: null }, latencyMs: Date.now() - started, route: opts?.route ?? null });
        throw e;
      }
      onCall?.({ call: calls, ok: true, errorKind: null, servedModel: c.model, usage: c.usage, latencyMs: Date.now() - started, route: opts?.route ?? null });
      tokens += (c.usage.promptTokens ?? 0) + (c.usage.completionTokens ?? 0);
      if (c.usage.costUsd === null) costSeen = false;
      else cost += c.usage.costUsd;
      return c;
    },
    report: () => ({ calls, tokens, costUsd: costSeen && calls > 0 ? cost : null, costAvailable: costSeen && calls > 0 }),
  };
}
