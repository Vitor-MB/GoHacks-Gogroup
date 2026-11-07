// GOB-10 · Texto da contagem regressiva da janela de revisão. O relógio exibido é o do CENÁRIO (não avança sozinho).
const fmt = (ms: number) => {
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3600_000);
  const m = Math.floor((abs % 3600_000) / 60_000);
  if (h === 0 && m === 0) return "menos de 1 min";
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
};

/** remainingMs = execute_after − relógio do cenário. Vencer a janela torna a ação elegível para a próxima rodada, não a executa na hora. */
export function countdownLabel(remainingMs: number): string {
  return remainingMs > 0 ? `faltam ${fmt(remainingMs)}` : `vencida há ${fmt(remainingMs)} — executa na próxima rodada do processador`;
}
