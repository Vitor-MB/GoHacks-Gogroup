import Link from "next/link";
import { getCurrentStaff } from "../../server/auth/session";
import { listQueue } from "../../server/cases";
import { createSessionClient } from "../../server/db/client";

const CHANNEL_LABEL = { whatsapp: "WhatsApp", email: "E-mail", reclame_aqui: "Reclame Aqui" } as const;
const TOPIC_LABEL: Record<string, string> = {
  rastreio_atraso: "Rastreio e atraso", troca_devolucao: "Troca ou devolução", avaria: "Avaria",
  personalizacao: "Personalização", brinde: "Brinde", reacao_adversa: "Reação adversa",
  cancelamento: "Cancelamento", outros: "Outros",
};

export default async function QueuePage() {
  const staff = await getCurrentStaff();
  if (!staff) return <main className="queue"><p>Conta sem funcionário ativo vinculado.</p></main>;

  const db = await createSessionClient();
  const { data: run } = await db.from("scenario_runs").select("id, clock_now").eq("name", "demo").maybeSingle();
  const items = run ? await listQueue(db, run.id) : [];

  return (
    <main className="queue">
      <h1>Fila de atendimento</h1>
      {run ? <p className="muted">Relógio do cenário: {new Date(run.clock_now).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</p> : <p>Cenário &quot;demo&quot; não encontrado.</p>}
      <table>
        <thead><tr><th>Assunto</th><th>Pedido</th><th>Canais</th><th>Situação</th></tr></thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td><Link href={`/fila/${c.id}`}>{TOPIC_LABEL[c.topic] ?? c.topic}</Link></td>
              <td>{c.orderId ?? "—"}</td>
              <td>{c.channels.map((ch) => CHANNEL_LABEL[ch]).join(", ")}</td>
              <td>{c.clarification ? "Pendente de esclarecimento" : c.status}</td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={4}>Nenhum caso na fila.</td></tr>}
        </tbody>
      </table>
    </main>
  );
}
