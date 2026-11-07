"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentStaff } from "../../../server/auth/session";
import { createAdminClient } from "../../../server/db/admin";
import { createSimulatedAdapter } from "../../../server/execution/adapters";
import { processDueTasks } from "../../../server/jobs/process";
import { loadPolicyParams } from "../../../server/policy/load";

/**
 * Ferramentas de DEMONSTRAÇÃO, só do supervisor, só no cenário "demo": o relógio de cada execução é isolado,
 * então avançar aqui não afeta nenhum outro cenário nem preview. Em produção o processamento é do Cron.
 */
const DEMO = "demo";

async function demoRun() {
  const staff = await getCurrentStaff();
  if (!staff || staff.role !== "supervisor") return null;
  const admin = createAdminClient();
  const { data } = await admin.from("scenario_runs").select("id").eq("name", DEMO).maybeSingle();
  return data ? { admin, runId: data.id as string, staff } : null;
}

function done(kind: "ok" | "erro", message: string): never {
  revalidatePath("/fila/pendencias");
  revalidatePath("/fila");
  redirect(`/fila/pendencias?${kind}=${encodeURIComponent(message)}`);
}

export async function advanceClockAction(formData: FormData) {
  const hours = Number(formData.get("hours"));
  if (!Number.isInteger(hours) || hours < 1 || hours > 72) done("erro", "Informe de 1 a 72 horas.");
  const ctx = await demoRun();
  if (!ctx) return done("erro", "Só o supervisor avança o relógio, e apenas no cenário de demonstração.");
  const { data, error } = await ctx.admin.rpc("advance_scenario_clock", { p_run: ctx.runId, p_hours: hours });
  if (error) return done("erro", "Não foi possível avançar o relógio.");
  const at = new Date(data as string).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  return done("ok", `Relógio do cenário avançado em ${hours} h: agora ${at}. Nada executa até a próxima rodada do processador.`);
}

export async function processNowAction() {
  const ctx = await demoRun();
  if (!ctx) return done("erro", "Só o supervisor dispara a rodada, e apenas no cenário de demonstração.");
  let message: string;
  try {
    const r = await processDueTasks(ctx.admin, {
      runId: ctx.runId, limit: 10, worker: `demo:${ctx.staff.id.slice(0, 8)}`,
      deps: { params: await loadPolicyParams(ctx.admin), adapter: createSimulatedAdapter(ctx.admin) },
    });
    const by = (o: string) => r.reports.filter((x) => x.outcome === o).length;
    message = `Rodada concluída: ${r.claimed} tarefa(s) reservada(s), ${by("executada")} executada(s), ${by("bloqueada")} bloqueada(s) na revalidação, ${by("adiada") + by("erro")} adiada(s); ${r.approvalsEscalated} aprovação(ões) vencida(s) cobrada(s).`;
  } catch {
    return done("erro", "Não foi possível processar as tarefas.");
  }
  return done("ok", message);
}
