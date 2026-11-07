import { randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { readServerConfig } from "../../../../../server/config";
import { createAdminClient } from "../../../../../server/db/admin";
import { createSimulatedAdapter } from "../../../../../server/execution/adapters";
import { processInvestigationTasks } from "../../../../../server/jobs/investigation";
import { processDueTasks } from "../../../../../server/jobs/process";
import { buildInvestigationDeps } from "../../../../../server/jobs/wiring";
import { loadPolicyParams } from "../../../../../server/policy/load";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Credencial dedicada do agendador. Sem segredo configurado, a rota recusa tudo. */
function authorized(request: Request): boolean {
  const secret = readServerConfig().cronSecret;
  if (!secret) return false;
  const given = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Processa um lote curto de tarefas vencidas (Supabase Cron, uma chamada por minuto).
 * Corpo opcional: { scenario?: string, limit?: number }. Sem `scenario`, cada execução vence pelo próprio relógio.
 */
export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });

  let body: { scenario?: unknown; limit?: unknown } = {};
  try {
    const text = await request.text();
    if (text.trim()) body = JSON.parse(text) as typeof body;
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }
  const limit = Math.min(25, Math.max(1, Number.isInteger(body.limit) ? (body.limit as number) : 5));

  try {
    const db = createAdminClient();
    let runId: string | null = null;
    if (typeof body.scenario === "string") {
      const { data: run } = await db.from("scenario_runs").select("id").eq("name", body.scenario).maybeSingle();
      if (!run) return NextResponse.json({ error: "Cenário não encontrado." }, { status: 404 });
      runId = run.id as string;
    }
    const report = await processDueTasks(db, {
      runId, limit, worker: `cron:${randomUUID().slice(0, 8)}`,
      deps: { params: await loadPolicyParams(db), adapter: createSimulatedAdapter(db) },
    });
    // Investigações pendentes (com retentativa e disjuntor): lote pequeno, porque cada uma pode chamar a IA.
    const investigations = await processInvestigationTasks(db, {
      limit: 2, worker: `cron:${randomUUID().slice(0, 8)}`, budgetMs: 25_000, deps: await buildInvestigationDeps(db),
    });
    return NextResponse.json({ ...report, investigations });
  } catch (e) {
    console.error("jobs/process", e instanceof Error ? e.message : "erro");
    return NextResponse.json({ error: "Falha ao processar as tarefas." }, { status: 500 });
  }
}
