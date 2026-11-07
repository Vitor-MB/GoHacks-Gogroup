import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentStaff } from "../../../server/auth/session";
import { getCaseDetail } from "../../../server/cases";
import { createSessionClient } from "../../../server/db/client";

const CHANNEL_LABEL = { whatsapp: "WhatsApp", email: "E-mail", reclame_aqui: "Reclame Aqui (público)" } as const;

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await getCurrentStaff();
  if (!staff) notFound();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const detail = await getCaseDetail(await createSessionClient(), id);
  if (!detail) notFound();

  return (
    <main className="queue">
      <p><Link href="/fila">← Fila</Link></p>
      <h1>{detail.summary ?? "Caso"}</h1>
      <p className="muted">
        Situação: {detail.clarification ? "pendente de esclarecimento" : detail.status} · Pedido: {detail.orderId ?? "não confirmado"} ·
        Marca: {detail.brandId ?? "não confirmada"}
      </p>
      {detail.clarification && <p role="status"><strong>Esclarecimento necessário:</strong> {detail.clarification}</p>}

      <h2>Fontes</h2>
      <ul>
        {detail.sources.map((s, i) => <li key={i}>{s.type}: {s.id}{s.detail ? ` (${s.detail})` : ""}</li>)}
        {detail.sources.length === 0 && <li>Nenhuma fonte verificada.</li>}
      </ul>

      <h2>Histórico por canal</h2>
      {detail.conversationsDetail.map((c) => (
        <section key={c.conversationId}>
          <h3>{CHANNEL_LABEL[c.channel]} · {c.conversationId}</h3>
          <ul>
            {c.messages.map((m) => (
              <li key={m.id}><strong>{m.author}</strong> · {new Date(m.sentAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}: {m.body}</li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
