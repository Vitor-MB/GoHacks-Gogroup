import Link from "next/link";
import { getCurrentStaff } from "../../server/auth/session";
import { createSessionClient } from "../../server/db/client";
import { scenarioClock } from "../../server/queries";
import { SimulatorChat } from "./simulator-chat";

const CHANNELS = { whatsapp: "WhatsApp", email: "E-mail", reclame_aqui: "Reclame Aqui (público)" } as const;
type ChannelKey = keyof typeof CHANNELS;
const DELIVERY: Record<string, string> = {
  aguardando_separacao: "Aguardando separação", em_transito: "Em trânsito", entregue: "Entregue", extraviado: "Extraviado", devolvido: "Devolvido", cancelado: "Cancelado",
};
const ORDER_RE = /^[A-Za-z]{3}\d{6}$/;
const LIMIT = 24;

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

interface OrderRow { order_id: string; customer_id: string; delivery_status: string | null; ordered_at: string; customers: { full_name: string | null } | { full_name: string | null }[] | null }
const nameOf = (o: OrderRow) => (Array.isArray(o.customers) ? o.customers[0] : o.customers)?.full_name ?? o.customer_id;

export default async function SimulatorPage({ searchParams }: { searchParams: Promise<Params> }) {
  const staff = await getCurrentStaff();
  if (!staff) return <main className="page"><p>Conta sem funcionário ativo vinculado.</p></main>;
  const sp = await searchParams;
  const pedido = one(sp.pedido)?.toUpperCase();
  const canalRaw = one(sp.canal);
  const canal: ChannelKey = canalRaw && canalRaw in CHANNELS ? (canalRaw as ChannelKey) : "whatsapp";
  const q = one(sp.q)?.trim().slice(0, 60);

  const db = await createSessionClient();
  const { data: run } = await db.from("scenario_runs").select("id").eq("name", "demo").maybeSingle();
  if (!run) return <main className="page"><p>Cenário &quot;demo&quot; não encontrado.</p></main>;
  const clock = await scenarioClock(db, run.id as string);

  const cols = "order_id, customer_id, delivery_status, ordered_at, customers(full_name)";

  // Pedido escolhido: precisa estar no escopo da sessão (RLS) e já existir no relógio do cenário.
  if (pedido && ORDER_RE.test(pedido)) {
    const { data } = await db.from("orders").select(cols).eq("order_id", pedido).lte("ordered_at", clock).maybeSingle();
    const order = data as unknown as OrderRow | null;
    if (!order) return <main className="page sv"><p>Pedido não encontrado no seu escopo. <Link href="/simulador">Escolher outro</Link></p></main>;
    const { data: items } = await db.from("order_items").select("description").eq("order_id", pedido).order("line").limit(1);
    const item = (items?.[0]?.description as string | undefined) ?? null;
    return (
      <main className="page sv">
        <header className="sv-head st-head">
          <div>
            <h1>Simulador de chat</h1>
            <p className="muted">{nameOf(order)} · pedido {order.order_id}{item ? ` · ${item}` : ""}{order.delivery_status ? ` · ${DELIVERY[order.delivery_status] ?? order.delivery_status}` : ""}</p>
          </div>
          <div className="cl-actions">
            <nav className="sv-tabs" aria-label="Canal da conversa">
              {(Object.keys(CHANNELS) as ChannelKey[]).map((c) => (
                <Link key={c} href={`/simulador?pedido=${order.order_id}&canal=${c}`} className={c === canal ? "is-on" : undefined} aria-current={c === canal ? "true" : undefined}>{CHANNELS[c]}</Link>
              ))}
            </nav>
            <Link href="/simulador" className="sv-open">Trocar pedido</Link>
          </div>
        </header>
        <p className="sv-notice">Simulação no cenário demo: cada conversa cria ou atualiza um caso real na fila. {canal === "reclame_aqui" ? "No Reclame Aqui a resposta é pública, então a GoBIA não escreve dados privados." : ""}</p>
        <SimulatorChat key={`${order.order_id}-${canal}`} channel={canal} customerId={order.customer_id} orderId={order.order_id} customerName={nameOf(order)} />
      </main>
    );
  }

  // Seletor: busca por nome do cliente ou número do pedido; sem busca, os pedidos mais recentes.
  let query = db.from("orders").select(cols).lte("ordered_at", clock).order("ordered_at", { ascending: false }).limit(LIMIT);
  if (q) {
    if (ORDER_RE.test(q)) query = query.eq("order_id", q.toUpperCase());
    else {
      const { data: cs } = await db.from("customers").select("customer_id").ilike("full_name", `%${q.replace(/[%_]/g, " ")}%`).limit(20);
      const ids = (cs ?? []).map((c) => c.customer_id as string);
      query = query.in("customer_id", ids.length ? ids : ["-"]);
    }
  }
  const { data: list, error } = await query;
  const orders = (list ?? []) as unknown as OrderRow[];
  const { data: its } = orders.length ? await db.from("order_items").select("order_id, description, line").in("order_id", orders.map((o) => o.order_id)).order("line") : { data: [] };
  const firstItem = new Map<string, string>();
  for (const it of its ?? []) if (!firstItem.has(it.order_id as string)) firstItem.set(it.order_id as string, String(it.description ?? ""));

  return (
    <main className="page sv">
      <header className="sv-head">
        <h1>Simulador de chat</h1>
        <p className="muted">Escolha um cliente e um pedido para fazer o papel dele e conversar com a GoBIA. Cada conversa cria ou atualiza um caso real no cenário demo.</p>
      </header>
      <form method="get" action="/simulador" className="cl-search sm-search" role="search">
        <input type="search" name="q" defaultValue={q ?? ""} placeholder="Nome do cliente ou número do pedido" aria-label="Buscar cliente ou pedido" maxLength={60} />
      </form>
      {error && <p role="alert" className="notice-err">Não foi possível carregar os pedidos.</p>}
      <ul className="sm-orders">
        {orders.map((o) => (
          <li key={o.order_id}>
            <Link href={`/simulador?pedido=${o.order_id}`} className="sm-order">
              <strong>{nameOf(o)}</strong>
              <span>{firstItem.get(o.order_id) || "Pedido sem itens"}</span>
              <small>{o.order_id}{o.delivery_status ? ` · ${DELIVERY[o.delivery_status] ?? o.delivery_status}` : ""}</small>
            </Link>
          </li>
        ))}
        {orders.length === 0 && !error && <li className="muted">Nenhum pedido encontrado no seu escopo.</li>}
      </ul>
      {!q && <p className="muted sv-foot">Mostrando os {LIMIT} pedidos mais recentes até o relógio do cenário. Use a busca para achar outro.</p>}
    </main>
  );
}
