// Estatísticas: verificação das séries dos gráficos (puras, sem banco). Uso: node scripts/verify-charts.ts
import { channelCounts, groupSeries, historyByMonth, meanScore, mvpResolutionsByDay, scoreDistribution, spDay } from "../src/server/metrics/charts.ts";
import type { CaseRecord } from "../src/server/metrics/model.ts";

let failed = 0;
const ok = (cond: boolean, name: string, extra = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "OK  " : "FALHA"} ${name}${extra ? ` — ${extra}` : ""}`);
};
const t = (iso: string) => Date.parse(iso);

ok(spDay(t("2026-11-03T01:30:00Z")) === "2026-11-02", "dia no fuso de Brasília (01:30Z ainda é dia 02)");
ok(spDay(t("2026-11-03T03:00:00Z")) === "2026-11-03", "virada do dia às 03:00Z");

const s = groupSeries([
  { at: t("2026-11-02T12:00:00Z"), a: true }, { at: t("2026-11-02T15:00:00Z"), a: false }, { at: t("2026-11-04T12:00:00Z"), a: true },
], "day", 14);
ok(s.length === 2 && s[0]!.label === "02/11" && s[0]!.a === 1 && s[0]!.b === 1 && s[1]!.label === "04/11", "agrupa por dia, ordenado, só dias com registro");
const many = Array.from({ length: 20 }, (_, i) => ({ at: t("2026-10-01T12:00:00Z") + i * 86_400_000, a: true }));
ok(groupSeries(many, "day", 14).length === 14 && groupSeries(many, "day", 14)[13]!.key === "2026-10-20", "mantém só os últimos 14 dias");
ok(historyByMonth([{ id: "1", channel: "email", openedAt: t("2026-09-10T12:00:00Z"), status: "resolvido", firstResponseAt: null, closedAt: null, unitId: null, brandId: null },
  { id: "2", channel: "email", openedAt: t("2026-09-11T12:00:00Z"), status: "aberto", firstResponseAt: null, closedAt: null, unitId: null, brandId: null }])[0]!.label === "09/26", "histórico por mês, rótulo mm/aa");

const mk = (id: string, status: string, closures: { seq: number; closedAt: number; mode: "autonoma" | "assistida" }[]): CaseRecord => ({
  id, status, channel: "whatsapp", openedAt: 0, topic: "x", customerId: null, orderId: null, unitId: null, brandId: null, handoffReason: null,
  firstResponseAt: null, closures: closures.map((c) => ({ id: `${id}${c.seq}`, reopenedAt: null, ...c })), interventionReasons: [], origin: null, models: [],
  ai: { calls: 0, costKnown: false, costUsd: 0 }, humanWaitMs: 0,
});
const day = mvpResolutionsByDay([
  mk("a", "resolvido", [{ seq: 1, closedAt: t("2026-11-02T12:00:00Z"), mode: "autonoma" }]),
  mk("b", "resolvido", [{ seq: 1, closedAt: t("2026-11-02T12:00:00Z"), mode: "autonoma" }, { seq: 2, closedAt: t("2026-11-03T12:00:00Z"), mode: "assistida" }]),
  mk("c", "aguardando_humano", [{ seq: 1, closedAt: t("2026-11-02T12:00:00Z"), mode: "autonoma" }]),
]);
ok(day.length === 2 && day[0]!.a === 1 && day[0]!.b === 0 && day[1]!.b === 1, "resoluções: usa o encerramento mais recente e ignora caso aberto", JSON.stringify(day));

const d = scoreDistribution([5, 5, 4, null, 1, 7, 0, 2.5]);
ok(d.map((x) => x.score).join() === "5,4,3,2,1" && d.map((x) => x.count).join() === "2,1,0,0,1", "notas 5→1; descarta nula e fora de 1–5", d.map((x) => x.count).join());
ok(meanScore([5, 4, null]) === 4.5 && meanScore([null]) === null, "média das notas ignora ausentes");
const cc = channelCounts(["email", "whatsapp", "whatsapp"]);
ok(cc[0]!.channel === "whatsapp" && cc[0]!.count === 2, "canais ordenados por quantidade");

console.log(failed ? `\n${failed} falha(s).` : "\nTudo certo.");
process.exit(failed ? 1 : 0);
