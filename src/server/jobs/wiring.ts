// Liga o processador de investigações à configuração do servidor (proxy de IA, roteamento e registro de uso).
import type { SupabaseClient } from "@supabase/supabase-js";
import { createModelAdapter } from "../ai/factory.ts";
import { readServerConfig } from "../config";
import { loadPolicyParams } from "../policy/load.ts";
import { usageRecorder } from "../metrics/survey.ts";
import type { InvestigationJobDeps } from "./investigation.ts";

export async function buildInvestigationDeps(db: SupabaseClient): Promise<InvestigationJobDeps> {
  const cfg = readServerConfig();
  return {
    params: await loadPolicyParams(db),
    makeAdapter: ({ runId, caseId }, onCall) => {
      const record = usageRecorder(db, {
        runId, caseId, adapter: { kind: "proxy", id: `proxy:${cfg.claudeModelEconomy ?? cfg.claudeModel ?? "desconhecido"}` },
        step: "investigacao", occurredAt: () => new Date().toISOString(),
      });
      return createModelAdapter(
        { url: cfg.claudeProxyUrl, token: cfg.claudeProxyToken, model: cfg.claudeModel, economy: cfg.claudeModelEconomy, reasoning: cfg.claudeModelReasoning, routing: cfg.claudeRouting },
        { budget: { maxCalls: 6, maxTokens: 40_000 }, timeoutMs: 20_000, onCall: (o) => { onCall(o); void record(o); } },
      );
    },
  };
}
