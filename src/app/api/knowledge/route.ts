import { NextResponse } from "next/server";
import { getCurrentStaff } from "../../../server/auth/session";
import { createSessionClient } from "../../../server/db/client";
import { searchKnowledge } from "../../../server/knowledge";

export const dynamic = "force-dynamic";

const SLUG = /^[a-z0-9_-]{1,40}$/i;
const SKU = /^[A-Z]{3}-\d{4}$/;

/** GET /api/knowledge?q=...&brand=&unit=&sku=&category=&limit=&scenario=demo — busca textual autorizada pela sessão. */
export async function GET(request: Request) {
  const staff = await getCurrentStaff();
  if (!staff) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });

  const p = new URL(request.url).searchParams;
  const q = (p.get("q") ?? "").trim();
  const brand = p.get("brand") ?? undefined;
  const unit = p.get("unit") ?? undefined;
  const sku = p.get("sku") ?? undefined;
  const category = p.get("category") ?? undefined;
  const scenario = p.get("scenario") ?? "demo";
  const limit = Number(p.get("limit") ?? 5);

  if (q.length > 200) return NextResponse.json({ error: "Consulta longa demais (máx. 200 caracteres)." }, { status: 400 });
  if (!q && !category && !sku) return NextResponse.json({ error: "Informe q, category ou sku." }, { status: 400 });
  if ((brand && !SLUG.test(brand)) || (unit && !SLUG.test(unit)) || (category && !SLUG.test(category)) || !SLUG.test(scenario)) {
    return NextResponse.json({ error: "Filtro inválido." }, { status: 400 });
  }
  if (sku && !SKU.test(sku)) return NextResponse.json({ error: "SKU inválido." }, { status: 400 });
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) return NextResponse.json({ error: "limit deve ir de 1 a 20." }, { status: 400 });

  const db = await createSessionClient();
  const { data: run } = await db.from("scenario_runs").select("id").eq("name", scenario).maybeSingle();
  if (!run) return NextResponse.json({ error: "Cenário não encontrado." }, { status: 404 });

  return NextResponse.json(await searchKnowledge(db, run.id, { query: q, brand, unit, sku, category, limit }));
}
