import { NextResponse } from "next/server";
import { getCurrentStaff } from "../../../../server/auth/session";
import { getCaseDetail } from "../../../../server/cases";
import { createSessionClient } from "../../../../server/db/client";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await getCurrentStaff();
  if (!staff) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Identificador inválido." }, { status: 400 });
  const detail = await getCaseDetail(await createSessionClient(), id);
  if (!detail) return NextResponse.json({ error: "Caso não encontrado." }, { status: 404 });
  return NextResponse.json(detail);
}
