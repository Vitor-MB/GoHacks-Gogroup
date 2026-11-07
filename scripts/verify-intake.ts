// GOB-04 · Verifica o aceite da entrada de contatos contra o banco de DESENVOLVIMENTO.
// Pré-requisitos: migration 20261107000004 aplicada e importação (GOB-03) executada.
// Uso: node --env-file=.env scripts/verify-intake.ts
// Cria o cenário temporário "verify-intake" e o remove ao final (casos, conversas e eventos saem junto).
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "node:url";
import { readCsv } from "./lib/csv.ts";
import {
  classifyTopic, composeOutbound, ingestContact, parseContactEvent, seedInitialQueue,
  type ContactEvent,
} from "../src/server/intake.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
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
const ok = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

let runId = "";
const count = async (table: string, col: string, value: string) => {
  const { count: n, error } = await db.from(table).select("*", { count: "exact", head: true }).eq(col, value);
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
};
const messagesInRun = async () => {
  const convs = ok(await db.from("conversations").select("conversation_id").eq("origin", "fila"), "conversas da fila");
  const { count: n } = await db.from("messages").select("*", { count: "exact", head: true })
    .in("conversation_id", convs!.map((c) => c.conversation_id));
  return n ?? 0;
};
const caseOf = async (conversationId: string) => {
  const rows = ok(await db.from("case_conversations").select("case_id, cases!inner(scenario_run_id)")
    .eq("conversation_id", conversationId).eq("cases.scenario_run_id", runId), "caso da conversa");
  return rows![0]?.case_id as string | undefined;
};

const T0 = "2026-11-02T08:00:00-03:00";
let seq = 0;
const ev = (over: Partial<ContactEvent>): ContactEvent => ({
  channel: "whatsapp", externalEventId: `V-${++seq}`, text: "Meu pedido está atrasado, não chegou.", receivedAt: T0, ...over,
});

async function main() {
  // ---- Regras puras ----
  check("assunto: atraso", classifyTopic("Atendimento", "prometeram entregar até 30/10 e nada") === "rastreio_atraso");
  check("assunto: avaria", classifyTopic("", "o produto veio quebrado") === "avaria");
  check("assunto: reação adversa prevalece", classifyTopic("Atraso na entrega", "tive alergia ao produto") === "reacao_adversa");
  check("assunto: troca", classifyTopic("Devolução", "") === "troca_devolucao");
  check("contrato: canal inválido rejeitado", !parseContactEvent({ channel: "sms", externalEventId: "x", text: "oi", receivedAt: T0 }).ok);
  check("contrato: data sem fuso rejeitada", !parseContactEvent({ channel: "email", externalEventId: "x", text: "oi", receivedAt: "2026-11-02T08:00:00" }).ok);
  check("contrato: evento válido aceito", parseContactEvent({ channel: "email", externalEventId: "x", text: "oi", receivedAt: T0 }).ok);

  const priv = "Meu CPF é 123.456.789-09, e-mail ana@teste.com, tel (11) 98765-4321, pedido GCH558661.";
  const pub = composeOutbound("reclame_aqui", priv);
  check("saída pública omite dados privados", pub.redacted && !/123\.456|ana@|98765|GCH558661/.test(pub.text), pub.text);
  check("saída privada (e-mail) segue sem alteração", composeOutbound("email", priv).text === priv);

  // ---- Cenário isolado ----
  await db.from("scenario_runs").delete().eq("name", "verify-intake");
  runId = ok(await db.from("scenario_runs").insert({ name: "verify-intake", mode: "preview" }).select("id"), "criar cenário")![0].id;

  const msgsBefore = await messagesInRun();

  const first = await seedInitialQueue(db, runId);
  const events1 = await count("contact_events", "scenario_run_id", runId);
  const cases1 = await count("cases", "scenario_run_id", runId);
  const again = await seedInitialQueue(db, runId);
  check("fila inicial criada", first.processed > 0 && cases1 > 0, `${first.processed} conversas → ${cases1} casos`);
  check("repetir a fila não duplica", again.duplicates === again.processed
    && (await count("contact_events", "scenario_run_id", runId)) === events1
    && (await count("cases", "scenario_run_id", runId)) === cases1 && (await messagesInRun()) === msgsBefore,
    `eventos=${events1} casos=${cases1}`);

  const noOrderConvs = ok(await db.from("conversations").select("conversation_id").eq("origin", "fila").is("order_id", null), "fila sem pedido")!.length;
  const clarCases = (await db.from("cases").select("*", { count: "exact", head: true })
    .eq("scenario_run_id", runId).is("order_id", null).not("clarification", "is", null)).count ?? 0;
  check("conversas da fila sem pedido ficam pendentes de esclarecimento", noOrderConvs > 0 && clarCases === noOrderConvs, `${clarCases}/${noOrderConvs}`);

  // ---- AT116589 e AT116707 compartilham a pendência do pedido GCH558661 ----
  const c1 = await caseOf("AT116589"), c2 = await caseOf("AT116707");
  check("AT116589 e AT116707 compartilham o caso", !!c1 && c1 === c2);
  if (c1) {
    const convs = ok(await db.from("case_conversations").select("conversations(conversation_id, channel)").eq("case_id", c1), "vínculos");
    const channels = (convs as unknown as { conversations: { channel: string } }[]).map((c) => c.conversations.channel).sort();
    check("canais de origem preservados", channels.join() === "email,reclame_aqui", channels.join());
    const k = ok(await db.from("cases").select("order_id, brand_id, clarification, status").eq("id", c1).single(), "caso");
    check("pedido e marca resolvidos pelo pedido", k!.order_id === "GCH558661" && k!.brand_id === "gocase" && !k!.clarification && k!.status === "novo");
  }

  // ---- Deduplicação por evento ----
  const base = ev({ customerId: "CH107459", orderId: "GCH558661", channel: "whatsapp", externalEventId: "DUP-1" });
  const r1 = await ingestContact(db, runId, base);
  const r2 = await ingestContact(db, runId, base);
  const dupMsgs = ok(await db.from("messages").select("message_id").eq("conversation_id", r1.conversation_id), "mensagens");
  check("reenviar o evento não duplica", !r1.duplicate && r2.duplicate && r1.case_id === r2.case_id && dupMsgs!.length === 1);
  check("novo canal do mesmo cliente/pedido/assunto entra na mesma pendência", r1.case_id === c1 && !r1.new_case);

  // ---- Assunto diferente mantém o contexto separado ----
  const other = await ingestContact(db, runId, ev({ customerId: "CH107459", orderId: "GCH558661", subject: "Troca", text: "Quero trocar o produto." }));
  check("assunto diferente cria outro caso", other.new_case === true && other.case_id !== c1);

  // ---- Outra marca separada (cliente com pedidos de unidades diferentes) ----
  const clockMs = Date.parse(T0);
  const visible = readCsv(`${BD}pedidos.csv`).filter((o) => Date.parse(o.data_hora_pedido.replace(" ", "T") + "-03:00") <= clockMs);
  const byCustomer = new Map<string, Map<string, string>>();
  for (const o of visible) {
    const m = byCustomer.get(o.customer_id) ?? new Map();
    if (!m.has(o.order_id.slice(0, 3))) m.set(o.order_id.slice(0, 3), o.order_id);
    byCustomer.set(o.customer_id, m);
  }
  const both = [...byCustomer.entries()].find(([, m]) => m.has("GCH") && m.has("GBH"));
  if (both) {
    const [cust, m] = both;
    const a = await ingestContact(db, runId, ev({ customerId: cust, orderId: m.get("GCH") }));
    const b = await ingestContact(db, runId, ev({ customerId: cust, orderId: m.get("GBH") }));
    check("pedidos de marcas diferentes do mesmo cliente não se unem", a.case_id !== b.case_id, `${cust}: ${m.get("GCH")} × ${m.get("GBH")}`);
  } else {
    console.log("SEM DADOS: nenhum cliente com pedidos Gocase e GoBeauté antes do relógio inicial.");
  }

  // ---- Identidade incerta vira pendência de esclarecimento ----
  const pend = async (name: string, e: ContactEvent, code: string) => {
    const r = await ingestContact(db, runId, e);
    const k = ok(await db.from("cases").select("status, clarification, order_id, brand_id").eq("id", r.case_id).single(), name);
    check(name, r.needs_clarification === true && k!.status === "aguardando_cliente" && !!k!.clarification?.startsWith(`[${code}]`)
      && k!.order_id === null && k!.brand_id === null, k!.clarification ?? "");
  };
  await pend("cliente desconhecido → esclarecer", ev({ text: "Cadê meu pedido? Já faz tempo." }), "cliente_nao_identificado");
  await pend("pedido não informado → esclarecer", ev({ customerId: "CH107459" }), "pedido_nao_identificado");
  const foreign = visible.find((o) => o.customer_id !== "CH107459")!;
  await pend("pedido de outro cliente → esclarecer", ev({ customerId: "CH107459", orderId: foreign.order_id }), "pedido_de_outro_cliente");
  await pend("conta de origem de outra marca → esclarecer", ev({ customerId: "CH107459", orderId: "GCH558661", account: "Barbour's" }), "marca_divergente");
  await pend("pedido inexistente → esclarecer", ev({ customerId: "CH107459", orderId: "GCH000001" }), "pedido_nao_encontrado");
  const future = readCsv(`${BD}pedidos.csv`).find((o) => Date.parse(o.data_hora_pedido.replace(" ", "T") + "-03:00") > clockMs)!;
  await pend("pedido futuro (após o relógio) → esclarecer", ev({ customerId: future.customer_id, orderId: future.order_id }), "pedido_nao_encontrado");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    failures++;
  })
  .finally(async () => {
    try {
      if (runId) {
        // ---- Reset isola o cenário e preserva a fonte ----
        const sourceAfterSeed = (await db.from("conversations").select("*", { count: "exact", head: true }).is("scenario_run_id", null)).count ?? 0;
        ok(await db.rpc("reset_scenario_run", { p_run: runId }), "reset");
        const left = (await count("cases", "scenario_run_id", runId)) + (await count("contact_events", "scenario_run_id", runId))
          + (await count("conversations", "scenario_run_id", runId));
        const sourceAfterReset = (await db.from("conversations").select("*", { count: "exact", head: true }).is("scenario_run_id", null)).count ?? 0;
        check("reset remove casos, conversas e eventos do cenário", left === 0);
        check("reset preserva as conversas da base", sourceAfterReset === sourceAfterSeed);
      }
      if (publishable) {
        const anon = createClient(url, publishable, { auth: { persistSession: false } });
        const { data, error } = await anon.from("contact_events").select("id").limit(1);
        check("anônimo não lê contact_events", !!error || (data ?? []).length === 0);
        const rpc = await anon.rpc("record_contact", { p_run: runId || "00000000-0000-0000-0000-000000000000", p_event: {}, p_ctx: {} });
        check("anônimo não executa record_contact", !!rpc.error);
      }
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      failures++;
    }
    if (runId) await db.from("scenario_runs").delete().eq("id", runId);
    console.log(failures ? `\n${failures} falha(s).` : "\nTudo certo.");
    process.exit(failures ? 1 : 0);
  });
