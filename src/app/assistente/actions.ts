"use server";

import { getCurrentStaff } from "../../server/auth/session";
import { readServerConfig } from "../../server/config";
import { createAdminClient } from "../../server/db/admin";
import { createSessionClient } from "../../server/db/client";
import type { ModelAdapter } from "../../server/ai/adapter";
import { createModelAdapter } from "../../server/ai/factory";
import { askAssistant, type AssistantAnswer } from "../../server/assistant/assistant";
import { usageRecorder } from "../../server/metrics/survey";

export type AssistantState = { question: string; result: AssistantAnswer | null; error: string | null };

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Consulta somente leitura. Identidade e escopo vêm da sessão; leitura sempre com o cliente da sessão (RLS).
 * A chave privilegiada só grava o registro de uso da IA (ai_usage), nunca lê dados para o assistente.
 */
export async function askAssistantAction(_prev: AssistantState, formData: FormData): Promise<AssistantState> {
  const question = String(formData.get("question") ?? "").trim().slice(0, 1000);
  const rawCase = String(formData.get("caseId") ?? "").trim();
  const staff = await getCurrentStaff();
  if (!staff) return { question, result: null, error: "Sessão sem funcionário ativo." };
  if (!question) return { question, result: null, error: "Escreva a sua pergunta." };
  if (rawCase && !UUID.test(rawCase)) return { question, result: null, error: "Caso inválido." };

  const db = await createSessionClient();
  const { data: row } = rawCase
    ? await db.from("cases").select("scenario_run_id").eq("id", rawCase).maybeSingle()
    : await db.from("scenario_runs").select("id").eq("name", "demo").maybeSingle();
  const runId = (row as { scenario_run_id?: string; id?: string } | null)?.scenario_run_id ?? (row as { id?: string } | null)?.id;
  if (!runId) {
    // Caso fora do escopo e cenário ausente têm o mesmo aspecto aqui: nada é revelado sobre a existência do caso.
    const result = await askAssistant({ db, adapter: null, runId: "00000000-0000-0000-0000-000000000000", question, caseId: rawCase || null });
    return { question, result, error: null };
  }

  const cfg = readServerConfig();
  let adapter: ModelAdapter | null = null;
  {
    // Consulta simples e somente leitura: sem sinais de complexidade o roteador usa a camada econômica (ou o modelo único).
    const record = usageRecorder(createAdminClient(), { runId, caseId: rawCase || null, adapter: { kind: "proxy", id: `proxy:${cfg.claudeModelEconomy ?? cfg.claudeModel ?? "desconhecido"}` }, step: "assistente", occurredAt: () => new Date().toISOString() });
    adapter = createModelAdapter(
      { url: cfg.claudeProxyUrl, token: cfg.claudeProxyToken, model: cfg.claudeModel, economy: cfg.claudeModelEconomy, reasoning: cfg.claudeModelReasoning, routing: cfg.claudeRouting },
      { budget: { maxCalls: 2, maxTokens: 20_000 }, timeoutMs: 45_000, onCall: (o) => { void record(o); } },
    );
  }

  try {
    return { question, result: await askAssistant({ db, adapter, runId, question, caseId: rawCase || null }), error: null };
  } catch {
    return { question, result: null, error: "Não foi possível consultar agora." };
  }
}
