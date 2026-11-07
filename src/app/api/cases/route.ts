import { NextResponse } from "next/server";
import { getCurrentStaff } from "../../../server/auth/session";
import { listQueue } from "../../../server/cases";
import { createSessionClient } from "../../../server/db/client";

export const dynamic = "force-dynamic";

/** Fila do cenário (padrão "demo"), limitada pela RLS ao escopo do funcionário. */
export async function GET(request: Request) {
  const staff = await getCurrentStaff();
  if (!staff) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });

  const scenario = new URL(request.url).searchParams.get("scenario") ?? "demo";
  const db = await createSessionClient();
  const { data: run } = await db.from("scenario_runs").select("id").eq("name", scenario).maybeSingle();
  if (!run) return NextResponse.json({ error: "Cenário não encontrado." }, { status: 404 });
  return NextResponse.json({ items: await listQueue(db, run.id) });
}
