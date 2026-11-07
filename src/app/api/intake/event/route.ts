import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { readServerConfig } from "../../../../server/config";
import { createAdminClient } from "../../../../server/db/admin";
import { ingestContact, parseContactEvent } from "../../../../server/intake";

export const dynamic = "force-dynamic";

function authorized(request: Request): boolean {
  const secret = readServerConfig().intakeSecret;
  if (!secret) return false;
  const given = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Entrada comum de contatos simulados. Corpo: { scenario?: string, ...ContactEvent }. */
export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }
  const parsed = parseContactEvent(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const scenario = typeof (body as { scenario?: unknown }).scenario === "string" ? (body as { scenario: string }).scenario : "demo";
  const db = createAdminClient();
  const { data: run } = await db.from("scenario_runs").select("id").eq("name", scenario).maybeSingle();
  if (!run) return NextResponse.json({ error: "Cenário não encontrado." }, { status: 404 });

  try {
    const result = await ingestContact(db, run.id, parsed.event, { enqueue: true });
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (e) {
    console.error("intake", e instanceof Error ? e.message : "erro");
    return NextResponse.json({ error: "Falha ao registrar o contato." }, { status: 500 });
  }
}
