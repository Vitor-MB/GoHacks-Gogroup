// GOB-08 · Adaptadores operacionais SIMULADOS (chamado à transportadora, reenvio, solicitação de reembolso, etc.).
// Nada aqui chama um serviço real. O "sistema externo" é a tabela simulated_operations (uma linha por chave de
// idempotência), o que permite reconciliar um resultado incerto antes de repetir a ação.
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export type FailureKind = "transitoria" | "permanente" | "incerta";

export class AdapterFailure extends Error {
  kind: FailureKind;
  constructor(kind: FailureKind, message: string) {
    super(message);
    this.name = "AdapterFailure";
    this.kind = kind;
  }
}

export interface ExecutionRequest {
  runId: string;
  proposalId: string;
  /** Chave de idempotência da operação externa (estável entre tentativas e reprocessamentos). */
  key: string;
  action: string;
  orderId: string;
  amountCents: number | null;
  carrier: string | null;
  trackingCode: string | null;
  attempt: number;
}

export interface AdapterSuccess {
  externalRef: string;
  result: Record<string, unknown>;
  ticket?: { ticket_id: string; carrier: string; tracking_code: string | null; reason: string };
  caseStatus: "aguardando_terceiro" | "em_execucao";
}

export interface ActionAdapter {
  /** "simulado": os registros resultantes são identificados como tal. */
  readonly kind: "simulado";
  readonly id: string;
  execute(req: ExecutionRequest): Promise<AdapterSuccess>;
  /** Consulta o estado externo. `null` = a operação não consta (nada aconteceu). */
  reconcile(req: ExecutionRequest): Promise<AdapterSuccess | null>;
}

const PREFIX: Record<string, string> = {
  abrir_chamado_transportadora: "CHM", reenviar_produto: "ENV", reembolsar: "RMB",
  reimprimir_personalizacao: "IMP", trocar_produto: "TRC", cancelar_pedido: "CNC",
};

export const externalRef = (action: string, key: string): string =>
  `SIM-${PREFIX[action] ?? "OPS"}-${createHash("sha256").update(key).digest("hex").slice(0, 10).toUpperCase()}`;

/** O que cada operação simulada produz. Reembolso e reenvio são SOLICITAÇÕES: nada é creditado nem enviado aqui. */
function buildSuccess(req: ExecutionRequest, ref: string): AdapterSuccess {
  switch (req.action) {
    case "abrir_chamado_transportadora":
      return {
        externalRef: ref, caseStatus: "aguardando_terceiro",
        result: { kind: "chamado_transportadora", protocolo: ref, simulado: true },
        ticket: { ticket_id: ref, carrier: req.carrier ?? "desconhecida", tracking_code: req.trackingCode, reason: "Abertura pela GoBIA (simulada) por atraso/rastreio parado." },
      };
    case "reembolsar":
      return {
        externalRef: ref, caseStatus: "aguardando_terceiro",
        result: { kind: "solicitacao_reembolso", status: "solicitado", creditoConfirmado: false, valorCentavos: req.amountCents, simulado: true },
      };
    case "reenviar_produto":
      return {
        externalRef: ref, caseStatus: "aguardando_terceiro",
        result: { kind: "solicitacao_reenvio", status: "solicitado", envioConfirmado: false, simulado: true },
      };
    default:
      return {
        externalRef: ref, caseStatus: "aguardando_terceiro",
        result: { kind: `solicitacao_${req.action}`, status: "solicitado", simulado: true },
      };
  }
}

/** Falha injetável para testes: `applyEffect` simula "a operação ocorreu, mas a resposta se perdeu". */
export type FaultHook = (req: ExecutionRequest) => { kind: FailureKind; message: string; applyEffect?: boolean } | undefined;

export function createSimulatedAdapter(db: SupabaseClient, fault?: FaultHook): ActionAdapter {
  const record = async (req: ExecutionRequest, ref: string) => {
    const { error } = await db.from("simulated_operations").upsert(
      { scenario_run_id: req.runId, idempotency_key: req.key, action: req.action, external_ref: ref, payload: { orderId: req.orderId, amountCents: req.amountCents } },
      { onConflict: "scenario_run_id,idempotency_key", ignoreDuplicates: true },
    );
    if (error) throw new AdapterFailure("transitoria", `sistema simulado indisponível: ${error.message}`);
  };

  return {
    kind: "simulado",
    id: "adaptador-simulado",
    async execute(req) {
      const ref = externalRef(req.action, req.key);
      const f = fault?.(req);
      if (f) {
        if (f.applyEffect) await record(req, ref);
        throw new AdapterFailure(f.kind, f.message);
      }
      await record(req, ref); // uma operação por chave: repetir não cria outra
      return buildSuccess(req, ref);
    },
    async reconcile(req) {
      const { data, error } = await db.from("simulated_operations").select("external_ref")
        .eq("scenario_run_id", req.runId).eq("idempotency_key", req.key).maybeSingle();
      if (error) throw new AdapterFailure("transitoria", `consulta ao sistema simulado falhou: ${error.message}`);
      return data ? buildSuccess(req, data.external_ref as string) : null;
    },
  };
}

/** Texto ao cliente baseado no RESULTADO confirmado: solicitação não é crédito, nem envio, nem caso resolvido. */
export function composeNotification(action: string, success: AdapterSuccess, amountCents: number | null): string {
  const ref = success.externalRef;
  const brl = (c: number) => `R$ ${(c / 100).toFixed(2).replace(".", ",")}`;
  switch (action) {
    case "abrir_chamado_transportadora":
      return `Abri um chamado com a transportadora (protocolo ${ref}) para cobrar a atualização do seu pedido. Acompanho a resposta e aviso você por aqui.`;
    case "reembolsar":
      return `Registrei a sua solicitação de reembolso${amountCents ? ` de ${brl(amountCents)}` : ""} (referência ${ref}). Ela ainda será processada: o valor não foi creditado e o prazo para aparecer depende da forma de pagamento. Aviso quando houver confirmação.`;
    case "reenviar_produto":
      return `Registrei a solicitação de reenvio do seu produto (referência ${ref}). Aviso assim que houver o código de rastreio do novo envio.`;
    default:
      return `Registrei a sua solicitação (referência ${ref}). Aviso quando ela for confirmada.`;
  }
}

/** Janela de revisão proposta do MVP (configuração, não regra original da empresa). */
export const DEFAULT_REVIEW_WINDOW_HOURS = 2;

const ACTION_LABEL: Record<string, string> = {
  reembolsar: "reembolso", reenviar_produto: "reenvio", reimprimir_personalizacao: "reimpressão", trocar_produto: "troca",
  cancelar_pedido: "cancelamento",
};

/** Aviso ao cliente. Só é gravado depois de a programação estar registrada e autorizada; não promete crédito nem horário exato. */
export function reviewWindowMessage(action: string, hours: number): string {
  const janela = hours === 2 ? "duas horas" : `${hours} ${hours === 1 ? "hora" : "horas"}`;
  const what = ACTION_LABEL[action] ?? "ação";
  const tail = action === "reembolsar" ? " O prazo para o valor aparecer depende da forma de pagamento." : "";
  return `Sua solicitação de ${what} está programada para processamento após a janela de revisão de ${janela}. Avisaremos quando ela for confirmada.${tail}`;
}
