// GOB-04 · Carrega a fila inicial de um cenário: conversas abertas da base viram casos, conforme o relógio.
// Pré-requisitos: migrations até 20261107000004 e importação (GOB-03) executadas.
// Uso: node --env-file=.env scripts/seed-queue.ts [--scenario demo]
// Idempotente: repetir não duplica mensagens nem casos.
import { createClient } from "@supabase/supabase-js";
import { seedInitialQueue } from "../src/server/intake.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  console.error("Defina NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SECRET_KEY.");
  process.exit(2);
}
const flag = process.argv.indexOf("--scenario");
const scenario = flag > -1 ? process.argv[flag + 1] : "demo";

const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: run, error } = await db.from("scenario_runs").select("id").eq("name", scenario).maybeSingle();
if (error || !run) {
  console.error(`Cenário "${scenario}" não encontrado${error ? `: ${error.message}` : ""}.`);
  process.exit(1);
}
const r = await seedInitialQueue(db, run.id);
console.log(`Cenário "${scenario}": ${r.processed} conversas processadas (${r.duplicates} já existentes), ${r.cases} casos na fila.`);
