// GOB-03 · Verifica o aceite da importação e do relógio contra o banco de DESENVOLVIMENTO.
// Pré-requisitos: migration 20261107000003 aplicada e `node --env-file=.env.local scripts/import-data.ts` executado.
// Uso: node --env-file=.env.local scripts/verify-scenario.ts
// Cria dois cenários temporários ("verify-a" e "verify-b") e os remove ao final.
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "node:url";
import { readCsv } from "./lib/csv.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  console.error("Defina NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SECRET_KEY.");
  process.exit(2);
}
const db = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const BD = fileURLToPath(new URL("../BD/", import.meta.url));

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FALHA"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const count = async (table: string) => {
  const { count: n, error } = await db.from(table).select("*", { count: "exact", head: true });
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
};
const ok = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

async function newRun(name: string) {
  await db.from("scenario_runs").delete().eq("name", name);
  const rows = ok(await db.from("scenario_runs").insert({ name, mode: "preview" }).select("id"), `criar ${name}`);
  return rows![0].id as string;
}

const created: string[] = [];
async function main() {
  // 1. Contagens e referências selecionadas contra os CSVs.
  const pedidos = readCsv(`${BD}pedidos.csv`);
  const expected: [string, number][] = [
    ["products", readCsv(`${BD}produtos.csv`).length],
    ["customers", readCsv(`${BD}clientes.csv`).length],
    ["orders", pedidos.length],
    ["order_items", readCsv(`${BD}itens_pedido.csv`).length],
    ["conversations", readCsv(`${BD}historico_conversas.csv`).length + readCsv(`${BD}fila_aberta.csv`).length],
    ["messages", readCsv(`${BD}historico_mensagens.csv`).length],
    ["tracking_events", readCsv(`${BD}rastreio_portais_transportadoras.csv`).length],
    ["policies", readCsv(`${BD}politicas.csv`).length],
  ];
  for (const [table, n] of expected) {
    const inDb = await count(table);
    check(`contagem ${table}`, inDb === n, `banco=${inDb} csv=${n}`);
  }

  for (const id of ["AT116665", "AT116703"]) {
    const conv = ok(await db.from("conversations").select("conversation_id, order_id, customer_id").eq("conversation_id", id).maybeSingle(), id);
    const csvRow = [...readCsv(`${BD}fila_aberta.csv`), ...readCsv(`${BD}historico_conversas.csv`)].find((r) => r.conversation_id === id);
    check(`referência ${id}`, !!conv && !!csvRow && conv.order_id === (csvRow.order_id || null) && conv.customer_id === csvRow.customer_id);
  }
  const sample = pedidos.find((o) => o.valor === "72.80") ?? pedidos[0];
  const o = ok(await db.from("orders").select("total_cents, tracking_code").eq("order_id", sample.order_id).maybeSingle(), "pedido");
  check(`valor em centavos ${sample.order_id}`, o?.total_cents === Math.round(Number(sample.valor) * 100));

  // 2. Relógio: pedido futuro invisível até a data correta.
  const runA = await newRun("verify-a");
  created.push(runA);
  const future = pedidos.filter((p) => p.data_pedido > "2026-11-02").sort((a, b) => a.data_hora_pedido.localeCompare(b.data_hora_pedido))[0];
  const visible = async (run: string) =>
    (ok(await db.rpc("orders_as_of", { p_run: run }).select("order_id").eq("order_id", future.order_id), "orders_as_of") as unknown[]).length > 0;
  check(`pedido futuro ${future.order_id} (${future.data_hora_pedido}) oculto no início`, !(await visible(runA)));
  const hoursNeeded = Math.ceil((new Date(future.data_hora_pedido.replace(" ", "T") + "-03:00").getTime() - new Date("2026-11-02T08:00:00-03:00").getTime()) / 3_600_000);
  ok(await db.rpc("advance_scenario_clock", { p_run: runA, p_hours: Math.max(hoursNeeded - 1, 0) }), "avançar relógio");
  check("ainda oculto 1 hora antes", !(await visible(runA)));
  ok(await db.rpc("advance_scenario_clock", { p_run: runA, p_hours: 1 }), "avançar relógio");
  check("visível quando o relógio alcança a data", await visible(runA));

  // 3. Reset isolado: preserva a fonte e outros cenários.
  const runB = await newRun("verify-b");
  created.push(runB);
  const anyCustomer = ok(await db.from("customers").select("customer_id").limit(1), "cliente")![0].customer_id;
  const mkConv = (id: string, run: string) => ({
    conversation_id: id, customer_id: anyCustomer, channel: "whatsapp", origin: "simulado",
    opened_at: "2026-11-02T08:00:00-03:00", scenario_run_id: run,
  });
  ok(await db.from("conversations").upsert([mkConv("VERIFY-A1", runA), mkConv("VERIFY-B1", runB)]), "conversas simuladas");
  const before = { source: await count("orders"), conv: await count("conversations") };
  ok(await db.rpc("reset_scenario_run", { p_run: runA }), "reset A");
  const aLeft = ok(await db.from("conversations").select("conversation_id").eq("conversation_id", "VERIFY-A1"), "A1");
  const bLeft = ok(await db.from("conversations").select("conversation_id").eq("conversation_id", "VERIFY-B1"), "B1");
  check("reset remove o operacional do cenário A", aLeft!.length === 0);
  check("reset preserva o cenário B", bLeft!.length === 1);
  check("reset preserva a fonte (pedidos e conversas importadas)", (await count("orders")) === before.source && (await count("conversations")) === before.conv - 1);
  const clock = ok(await db.from("scenario_runs").select("clock_now, clock_start").eq("id", runA).single(), "relógio A");
  check("reset volta o relógio ao início", new Date(clock!.clock_now).getTime() === new Date(clock!.clock_start).getTime());
  check("reset oculta de novo o pedido futuro", !(await visible(runA)));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    failures++;
  })
  .finally(async () => {
    await db.from("conversations").delete().in("conversation_id", ["VERIFY-A1", "VERIFY-B1"]);
    for (const id of created) await db.from("scenario_runs").delete().eq("id", id);
    console.log(failures ? `\n${failures} falha(s).` : "\nTudo certo.");
    process.exit(failures ? 1 : 0);
  });
