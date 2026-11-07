import { NextResponse } from "next/server";
import { getCurrentStaff } from "../../../../../server/auth/session";
import { createSessionClient } from "../../../../../server/db/client";
import { getOrderEvidence, getProductionEvidence, getTrackingEvidence } from "../../../../../server/queries";

export const dynamic = "force-dynamic";

/** GET /api/orders/GCH558661/evidence?scenario=demo — pedido, rastreio e produção no relógio do cenário (escopo da sessão). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await getCurrentStaff();
  if (!staff) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });

  const { id } = await params;
  if (!/^[A-Z]{3}\d{6}$/.test(id)) return NextResponse.json({ error: "Identificador de pedido inválido." }, { status: 400 });
  const scenario = new URL(request.url).searchParams.get("scenario") ?? "demo";
  if (!/^[a-z0-9_-]{1,40}$/i.test(scenario)) return NextResponse.json({ error: "Cenário inválido." }, { status: 400 });

  const db = await createSessionClient();
  const { data: run } = await db.from("scenario_runs").select("id").eq("name", scenario).maybeSingle();
  if (!run) return NextResponse.json({ error: "Cenário não encontrado." }, { status: 404 });

  const [order, tracking, production] = await Promise.all([
    getOrderEvidence(db, run.id, id), getTrackingEvidence(db, run.id, id), getProductionEvidence(db, run.id, id),
  ]);
  if (!order.data) return NextResponse.json({ error: "Pedido não encontrado." }, { status: 404 });
  return NextResponse.json({ order, tracking, production });
}
