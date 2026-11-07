"use server";

import { getCurrentStaff } from "../../server/auth/session";
import { readServerConfig } from "../../server/config";
import { createAdminClient } from "../../server/db/admin";
import { createSessionClient } from "../../server/db/client";
import { createModelAdapter } from "../../server/ai/factory";
import { usageRecorder } from "../../server/metrics/survey";
import { SimulationError, simulateCustomerMessage, validateInput } from "../../server/simulator";
import type { Channel } from "../../server/intake";

export interface SimActionInput { channel: Channel; customerId: string; orderId: string; conversationKey: string; text: string }
export type SimActionResult =
  | { ok: true; caseId: string; newCase: boolean; needsClarification: boolean; investigationQueued: boolean; reply: { text: string; source: "ia" | "padrao"; flags: string[] } }
  | { ok: false; error: string };

/**
 * Uma mensagem do "cliente" simulado. Só funcionário ativo, só no cenário demo. O pedido precisa estar no escopo da sessão (RLS)
 * e ser do cliente escolhido; a validação final fica em `simulateCustomerMessage`.
 */
export async function sendSimulatedMessageAction(input: SimActionInput): Promise<SimActionResult> {
  const staff = await getCurrentStaff();
  if (!staff) return { ok: false, error: "Sessão sem funcionário ativo." };
  const bad = validateInput(input);
  if (bad) return { ok: false, error: bad };

  const session = await createSessionClient();
  const { data: run } = await session.from("scenario_runs").select("id").eq("name", "demo").maybeSingle();
  if (!run) return { ok: false, error: "Cenário demo não encontrado." };

  const admin = createAdminClient();
  const cfg = readServerConfig();
  const record = usageRecorder(admin, { runId: run.id as string, caseId: null, adapter: { kind: "proxy", id: `proxy:${cfg.claudeModelEconomy ?? cfg.claudeModel ?? "desconhecido"}` }, step: "chat_cliente_simulado", occurredAt: () => new Date().toISOString() });
  const adapter = createModelAdapter(
    { url: cfg.claudeProxyUrl, token: cfg.claudeProxyToken, model: cfg.claudeModel, economy: cfg.claudeModelEconomy, reasoning: cfg.claudeModelReasoning, routing: cfg.claudeRouting },
    { budget: { maxCalls: 2, maxTokens: 20_000 }, timeoutMs: 30_000, onCall: (o) => { void record(o); } },
  );

  try {
    const r = await simulateCustomerMessage({ session, admin, adapter }, { ...input, runId: run.id as string });
    return { ok: true, caseId: r.caseId, newCase: r.newCase, needsClarification: r.needsClarification, investigationQueued: r.investigationQueued, reply: r.reply };
  } catch (e) {
    if (e instanceof SimulationError) return { ok: false, error: e.message };
    console.error("simulador", e instanceof Error ? e.message : "erro");
    return { ok: false, error: "Não foi possível enviar agora." };
  }
}
