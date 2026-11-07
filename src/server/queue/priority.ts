// GOB-09 · Prioridade explicável da fila. Só prazo, consequência e pendências contam; sentimento do cliente não entra.
// Cada ponto vem acompanhado do motivo que o gerou, para o funcionário ver por que o caso está onde está.

export interface PriorityInput {
  topic: string;
  status: string;
  /** Idade do caso no relógio do cenário, em horas. */
  ageHours: number;
  clarificationPending: boolean;
  assigned: boolean;
  handoffReason: string | null;
  proposal: { status: string; amountCents: number | null; escalationLevel: number; overdue: boolean } | null;
}

export interface Priority {
  level: "alta" | "media" | "baixa";
  score: number;
  reasons: string[];
}

const brl = (c: number) => `R$ ${(c / 100).toFixed(2).replace(".", ",")}`;

export function priorityOf(i: PriorityInput): Priority {
  let score = 0;
  const reasons: string[] = [];
  const add = (points: number, why: string) => { score += points; reasons.push(`${why} (+${points})`); };

  if (i.topic === "reacao_adversa") add(100, "Relato de reação adversa: orientação e registro de cosmetovigilância em até 24 h");
  if (i.proposal?.status === "aguardando_aprovacao") {
    add(25, "Aguarda aprovação do supervisor");
    if (i.proposal.overdue) add(30, "Prazo de aprovação vencido");
    if (i.proposal.escalationLevel >= 2) add(15, "Cobrança já escalonada");
  }
  if (i.proposal?.status === "suspensa") add(15, "Proposta suspensa aguardando decisão");
  if (i.proposal?.amountCents && i.proposal.amountCents > 0) {
    add(i.proposal.amountCents > 10_000 ? 15 : 5, `Valor em jogo: ${brl(i.proposal.amountCents)}`);
  }
  if (i.handoffReason === "execucao_falhou") add(30, "A execução falhou e nada foi comunicado ao cliente");
  if (i.handoffReason === "revalidacao_bloqueada") add(20, "A revalidação bloqueou a execução aprovada");
  if (i.handoffReason === "continuidade_humana") add(10, "A GoBIA não concluiu a investigação");
  if (i.ageHours >= 48) add(20, `Caso aberto há ${Math.floor(i.ageHours)} h`);
  else if (i.ageHours >= 24) add(10, `Caso aberto há ${Math.floor(i.ageHours)} h`);
  if (i.status === "aguardando_humano" && !i.assigned) add(10, "Sem responsável");
  if (i.clarificationPending) add(5, "Aguarda esclarecimento do cliente");

  if (reasons.length === 0) reasons.push("Sem pendência que eleve a prioridade");
  return { level: score >= 60 ? "alta" : score >= 25 ? "media" : "baixa", score, reasons };
}
