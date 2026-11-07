// GOB-02 · Verifica acesso por papel/escopo pela API direta do Supabase (PostgREST), sem passar pela aplicação.
// Uso (ambiente de DESENVOLVIMENTO, com as 3 contas do seed.sql criadas):
//   node --env-file=.env.local scripts/verify-access.ts
// Senhas das contas de teste via ambiente: TEST_PASSWORD (comum) ou TEST_PASSWORD_OPERADOR / _SUPERVISOR / _RESTRITO.
// Insere fixtures temporárias com a chave privilegiada e as remove ao final.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !publishable || !secret) {
  console.error("Defina NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY e SUPABASE_SECRET_KEY.");
  process.exit(2);
}

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, secret, opts);

function password(role: string) {
  const p = process.env[`TEST_PASSWORD_${role.toUpperCase()}`] ?? process.env.TEST_PASSWORD;
  if (!p) throw new Error(`Defina TEST_PASSWORD (ou TEST_PASSWORD_${role.toUpperCase()}).`);
  return p;
}

async function sessionFor(role: string) {
  const client = createClient(url!, publishable!, opts);
  const { error } = await client.auth.signInWithPassword({
    email: `${role}@gobia.test`,
    password: password(role),
  });
  if (error) throw new Error(`Login de ${role} falhou: ${error.message}`);
  return client;
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FALHA"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const ids = { customer: "CHTEST01", orders: ["GCHTEST1", "GBHTEST1"], skus: ["TST-GOC", "TST-KOK"] };

async function cleanup() {
  await admin.from("orders").delete().in("order_id", ids.orders);
  await admin.from("products").delete().in("sku", ids.skus);
  await admin.from("customers").delete().eq("customer_id", ids.customer);
}

async function main() {
  await cleanup();
  const seed = [
    admin.from("customers").insert({ customer_id: ids.customer, cpf: "000.000.000-00" }),
  ];
  for (const r of await Promise.all(seed)) if (r.error) throw r.error;
  let r = await admin.from("products").insert([
    { sku: "TST-GOC", name: "Teste Gocase", brand_id: "gocase", business_unit_id: "gocase" },
    { sku: "TST-KOK", name: "Teste Kokeshi", brand_id: "kokeshi", business_unit_id: "gobeaute" },
  ]);
  if (r.error) throw r.error;
  r = await admin.from("orders").insert([
    { order_id: "GCHTEST1", customer_id: ids.customer, brand_id: "gocase", business_unit_id: "gocase", ordered_at: new Date().toISOString(), total_cents: 10000, sku: "TST-GOC" },
    { order_id: "GBHTEST1", customer_id: ids.customer, brand_id: "kokeshi", business_unit_id: "gobeaute", ordered_at: new Date().toISOString(), total_cents: 5000, sku: "TST-KOK" },
  ]);
  if (r.error) throw r.error;

  const count = async (c: ReturnType<typeof createClient>) => {
    const res = await c.from("orders").select("order_id").in("order_id", ids.orders);
    return { n: res.data?.length ?? 0, error: res.error };
  };

  // Sem sessão
  const anon = createClient(url!, publishable!, opts);
  const a = await anon.from("orders").select("order_id").in("order_id", ids.orders);
  check("sem sessão não lê pedidos", !!a.error || (a.data?.length ?? 0) === 0, a.error?.message ?? "0 linhas");

  // Operador e supervisor (grupo)
  for (const role of ["operador", "supervisor"]) {
    const c = await sessionFor(role);
    const { n } = await count(c);
    check(`${role} (grupo) vê os 2 pedidos`, n === 2, `${n} linhas`);
  }

  // Restrito (marca Kokeshi): acesso cruzado deve falhar
  const restrito = await sessionFor("restrito");
  const { n } = await count(restrito);
  check("restrito (Kokeshi) vê só 1 pedido", n === 1, `${n} linhas`);
  const cross = await restrito.from("orders").select("order_id").eq("order_id", "GCHTEST1");
  check("restrito não lê pedido Gocase (acesso cruzado)", (cross.data?.length ?? 0) === 0);
  const prod = await restrito.from("products").select("sku").in("sku", ids.skus);
  check("restrito vê só produto da própria marca", (prod.data?.length ?? 0) === 1);
  const cust = await restrito.from("customers").select("customer_id").eq("customer_id", ids.customer);
  check("restrito vê o cliente via pedido no escopo", (cust.data?.length ?? 0) === 1);

  // Colunas e escrita bloqueadas
  const cpf = await restrito.from("customers").select("cpf").eq("customer_id", ids.customer);
  check("CPF não é legível pelo navegador", !!cpf.error, cpf.error?.message ?? "sem erro");
  const w = await restrito.from("orders").update({ total_cents: 1 }).eq("order_id", "GBHTEST1");
  const after = await admin.from("orders").select("total_cents").eq("order_id", "GBHTEST1").single();
  check("authenticated não altera pedidos", !!w.error || after.data?.total_cents === 5000, w.error?.message ?? "0 linhas afetadas");
  const ins = await restrito.from("staff_scopes").insert({ staff_id: "00000000-0000-0000-0000-000000000000", scope: "group" });
  check("authenticated não cria escopo próprio", !!ins.error, ins.error?.message ?? "sem erro");
}

main()
  .catch((e) => {
    console.error("Erro na verificação:", e instanceof Error ? e.message : e);
    failures++;
  })
  .finally(async () => {
    await cleanup();
    console.log(failures ? `\n${failures} verificação(ões) falharam.` : "\nTodas as verificações passaram.");
    process.exit(failures ? 1 : 0);
  });
