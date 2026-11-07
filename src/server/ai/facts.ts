// GOB-07 · Do resultado das consultas estruturadas (GOB-05) para os fatos verificados que o GOB-06 aceita.
// Pura: nada aqui vem do modelo. O que o banco não informa fica nulo/falso e o GOB-06 bloqueia ou orienta.
import type { Evidence } from "../evidence.ts";
import { saoPauloDate } from "../evidence.ts";
import type { VerifiedFacts } from "../policy/decision.ts";
import type { OrderEvidence, ProductionEvidence, TrackingEvidence } from "../queries.ts";

const IDENTITY_FIELDS = new Set(["codigo_rastreio", "sku", "entrega"]);

export function factsFromEvidence(
  orderId: string,
  order: Evidence<OrderEvidence>,
  tracking: Evidence<TrackingEvidence>,
  production: Evidence<ProductionEvidence> | null,
  extra: { suspicionPending?: boolean; customerPreference?: "reenvio" | "reembolso" | null } = {},
): VerifiedFacts | null {
  if (!order.data || !tracking.data) return null;
  const o = order.data.order;
  const t = tracking.data;
  const open = t.tickets.find((x) => x.status === "aberto");
  return {
    orderId,
    orderValueCents: typeof o.total_cents === "number" ? o.total_cents : null,
    separatedOn: o.separatedAt ? saoPauloDate(o.separatedAt) : null,
    deliveredOn: o.deliveredOn,
    promisedOn: o.promised_on ?? t.promisedOn,
    lastEventOn: t.lastEvent ? saoPauloDate(t.lastEvent.event_at) : null,
    lastEventStatus: t.lastEvent?.status ?? null,
    lostConfirmed: t.state === "extraviado",
    identityConflicts: [...order.conflicts, ...tracking.conflicts].map((c) => c.field).filter((f) => IDENTITY_FIELDS.has(f)),
    duplicate: open ? { action: "abrir_chamado_transportadora", status: "aberto" } : null,
    // A GOB-08 grava suspeitas; até lá o chamador informa. Sem registro, não há suspeita conhecida.
    suspicionPending: extra.suspicionPending ?? false,
    customerPreference: extra.customerPreference ?? null,
    hasPhoto: (production?.data?.attachments.length ?? 0) > 0,
  };
}
